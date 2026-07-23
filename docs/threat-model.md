# AlgoLift — Threat Model

**Scope of this document.** AlgoLift executes untrusted code as a core function. This document
states what that means, what the isolation boundary actually is, what it defends against, and —
more importantly — what it does not. Nothing here is aspirational: every control listed is
implemented and test-covered today, and every gap is a real gap.

The short version: **on macOS the outer security boundary is Docker Desktop's Linux VM, not the
container.** That is an appropriate boundary for a single-user tool running its author's own code
on their own laptop. It is *not* sufficient for public multi-tenant execution, which is why public
multi-tenant execution is out of scope and disabled by design.

---

## 1. What counts as untrusted code

Two sources, and the second is the one people forget:

| Source | Why it's untrusted |
|---|---|
| **User submissions** | Arbitrary Python / C++20 written by the user and executed verbatim. |
| **Model-generated code** | `reference_solution_py`, `brute_force_py`, `input_generator_py`, `checker_py`, and every entry in `mutants_py` come out of an LLM. They are executed during verification, before any human reads them. |

The second category is the reason the verification gate runs **inside the same sandbox** as user
submissions rather than in the content worker's own process. A generated `input_generator_py` is
executed hundreds of times during the differential stage; treating it as trusted because "we
generated it" would be the single largest hole in the system. `content/algolift_content/sandbox.py`
deliberately cannot construct `docker run` arguments — it shells out to the one TypeScript
implementation (CONTRACTS §6.1), so there is exactly one set of isolation flags, not two that can
drift apart.

Verified end-to-end: Python drives the same TS sandbox and gets correct verdicts across accepted /
wrong answer / runtime error / time limit / compilation error.

---

## 2. The actual boundary

```
   user submission  or  LLM-generated code
              │
              ▼
   ┌──────────────────────────────┐
   │  sandbox container            │  ← controls in §3. NOT a security boundary
   │  (--network none, ro rootfs)  │     against a kernel exploit.
   └──────────────┬───────────────┘
                  │  shared kernel
   ┌──────────────▼───────────────┐
   │  Docker Desktop Linux VM      │  ← THE security boundary on macOS.
   └──────────────┬───────────────┘
                  │  hypervisor
   ┌──────────────▼───────────────┐
   │  macOS host                   │
   └──────────────────────────────┘
```

Containers share the VM's kernel. A container escape via a kernel vulnerability lands the attacker
in the Linux VM — not on macOS. The hypervisor is what stands between hostile code and the user's
actual machine.

**gVisor and Firecracker are not used**, and this is a deliberate cut recorded in PLAN.md §11: they
are unavailable on macOS hosts. Pretending otherwise would be the dishonest option. What we do
instead is state the real boundary and keep the blast radius small.

---

## 3. Controls that are actually implemented

Every flag below is applied on every execution, in this exact order, by
`packages/sandbox/src/run.ts`, and asserted by a snapshot test so it cannot silently regress:

| Control | Flag | Defends against |
|---|---|---|
| No network | `--network none` | Exfiltration, C2, dependency fetching, lateral movement. **Test-verified**: a socket connect from inside the sandbox fails. |
| Read-only root | `--read-only` | Persisting anything into the image; tampering with the runner. |
| Writable scratch only | `--tmpfs /work:rw,size=64m,mode=1777,exec` | Disk exhaustion; anything surviving the run. |
| Non-root | `-u 65534:65534` | Privileged operations inside the container. |
| Memory cap | `--memory`, `--memory-swap` pinned equal | Host memory exhaustion. **Test-verified.** |
| CPU cap | `--cpus` | Starving the host. |
| Process cap | `--pids-limit` | Fork bombs. **Test-verified.** |
| No new privileges | `--security-opt no-new-privileges` | setuid escalation. |
| All capabilities dropped | `--cap-drop ALL` | Kernel-adjacent capability abuse. |
| Wall-clock timeout | Host-enforced kill + `docker kill` backstop by label | Infinite loops. **Test-verified.** |
| Output caps | Host-side stream truncation | Log/memory exhaustion by a spewing program. **Test-verified.** |
| Pinned image digest | Recorded on every `execution_attempts` row | Reproducibility; detecting a swapped base image. |
| Read-only bundle mount | `-v <bundle>:/bundle:ro` | Test data tampering mid-run. |

Hidden tests enter the container only via that read-only bundle, for that run. **No secrets,
credentials, or API keys exist in the runner images** — there is nothing in the sandbox worth
stealing even on a full container compromise.

---

## 4. What this does NOT defend against

Stated plainly, because a threat model that only lists strengths is marketing.

1. **Container escape via a Linux kernel vulnerability.** Shared kernel. The attacker reaches the
   Docker Desktop VM. Mitigated only by the hypervisor and by the fact that the code being run is
   the user's own.
2. **The Docker socket is root-equivalent.** `docker-compose.yml` mounts `/var/run/docker.sock`
   into the judge and content services so they can launch sibling containers. Anyone who achieves
   arbitrary code execution *in the judge or content process itself* (not in the sandbox) controls
   the Docker daemon and therefore the VM. Those processes do not execute untrusted code in-process
   — they only spawn containers — but this is the highest-value target in the system and it should
   be understood as such. A hardened deployment would put a brokered, least-privilege
   container-launch service in front of the socket instead.
3. **Side channels.** No mitigation for timing, cache, or speculative-execution attacks between
   the sandbox and anything else on the machine.
4. **Host resource exhaustion in aggregate.** Per-container limits are enforced; there is no global
   admission control, so N concurrent executions can still collectively load the machine.
5. **Malicious problem content that is *correct*.** The six-stage gate proves a problem is
   internally consistent — reference agrees with brute force, examples reproduce, mutants die. It
   does not prove the problem is *good*, interesting, or free of subtly misleading framing.
   Correctness ≠ quality; PLAN.md §12 names this as the product's ceiling risk.
6. **Supply chain.** Base images (`python:3.12-slim`, `gcc:14`) and the vendored `json.hpp` are
   trusted as-is. Digests are recorded, so a change is *detectable* after the fact, but nothing
   verifies them ahead of time.

---

## 5. Single-user assumptions baked in today

v1 has **no authentication**. `SINGLE_USER_ID` resolves the current user from configuration, not
from the request. Every user-owned table already carries `user_id`, so multi-user is a migration
rather than a rewrite — but until that migration exists, **any process that can reach the API can
read and write the only user's data.** Bind to localhost; do not expose the API.

Also absent by deliberate decision (PLAN.md §11): rate limiting, abuse controls, and consent /
retention machinery. Justification: no strangers on the system. That justification evaporates the
moment the system is exposed.

---

## 6. What public deployment would require

Not a roadmap — a gate. Public multi-tenant execution stays out of scope until **all** of these
exist:

1. A reviewed isolation layer with a per-execution kernel boundary (gVisor, Firecracker, or
   equivalent) on a Linux host — not Docker-on-macOS.
2. Removal of the Docker socket mount in favour of a brokered container-launch service with a
   least-privilege API.
3. Authentication, authorization, and per-user data isolation enforced in the database, not just
   in application code.
4. Global admission control and per-user quotas on execution, not only per-container limits.
5. Egress controls and monitoring at the network layer, not solely `--network none` per container.
6. An incident response path: what happens when — not if — a sandbox escape is reported.

Until then the honest posture is: **this is a single-user tool that runs its author's own code on
their own machine, and its isolation is sized for exactly that.**

---

## 7. Verification

The isolation claims above are not assertions. `packages/sandbox/src/docker.integration.test.ts`
executes real containers and asserts that network access fails, an infinite loop is killed at the
wall timeout, a fork bomb hits the pids limit, a memory hog is constrained, stdout is truncated at
the cap, and the root filesystem is read-only while `/work` is writable. The docker argv builder is
snapshot-tested so the flag list cannot regress unnoticed.

If you change `packages/sandbox/src/run.ts`, those tests are the thing that tells you whether you
just removed a security control.
