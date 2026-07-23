# AlgoLift — Implementation Plan

**Progressive overload for problem solving.** An adaptive algorithm-training platform that generates original, deterministically verified problems on your machine, judges your code in sandboxes, and models your mastery per concept so every session targets the edge of your ability — covering the pattern families of the NeetCode 150.

This plan supersedes the v1.0 GPT spec. Where they disagree, this document wins. Every major decision below was made deliberately in a design review; the rationale is recorded so future changes argue against the *reason*, not just the choice.

---

## 1. Purpose and priorities

1. **Primary: a tool the author actually uses daily** to get measurably better at DSA.
2. **Secondary: a portfolio artifact** demonstrating AI engineering, backend, queues, concurrency, networking, and reliability — earned where the product genuinely needs them (judge, queue, verification pipeline), never sprinkled as ceremony.

The plan is **milestone-shaped, not calendar-shaped**: a walking skeleton proves the entire loop end-to-end first, then each milestone replaces one deliberately-dumb part with the real thing. After each milestone, decide whether to go deeper or stop.

---

## 2. Decision log (resolved)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Project purpose | Personal tool first, portfolio second |
| 2 | Schedule | Milestone-shaped; walking skeleton ASAP |
| 3 | Problem generation | Runtime generation via **local `claude -p`** (single model; invoker pluggable so `codex exec` can be swapped in by config) |
| 4 | Generation timing | **Background prefetch**: demand-predicting replenishment worker keeps a buffer of verified problems warm; the user never waits on generation. Runs while the machine is awake |
| 5 | Deployment | **Local-first, service-shaped**: docker-compose on macOS with real service boundaries; deployable to a VPS later without redesign. Docker Desktop's Linux VM is the outer isolation boundary (documented honestly) |
| 6 | Languages (services) | **TypeScript app plane** (web, API, coordinator, worker manager — one monorepo, shared types) + **Python content plane** (generation + verification). C++ appears only as a judged submission language |
| 7 | Queue | **Hand-built on Postgres** (`FOR UPDATE SKIP LOCKED`, leases, heartbeats, priorities, idempotency). Transactional enqueue with domain writes. No Redis/BullMQ/NATS |
| 8 | Problem I/O contract | **Function-signature harness** (LeetCode-style) with JSON test cases and per-language harness codegen. v1 types: ints, floats, bools, strings, nested lists. Trees/linked lists: Python in M3, C++ parity in M4 |
| 9 | Submission languages | **Python and C++20 only.** Skeleton judges Python; C++ lands in M4 |
| 10 | Learner model | **Glicko-lite per-concept Elo**: rating + uncertainty per user×concept, logistic success prediction, bounded outcome score (hints/time/attempts), K scaled by uncertainty, evidence split by concept weights, immutable LearningEvents. SM-2-style spaced review. No IRT/BKT (unfittable with one user and fresh problems) |
| 11 | Verification gate | **Six blocking deterministic stages**: schema, compile, differential, boundary, example-consistency, **mutation**. Deferred: complexity validation, novelty. Cut: cross-model review, quality-score thresholds, admin quarantine UI |
| 12 | Hints | **Fully pre-generated** ladder stored with the problem (orientation → conceptual → structural → outline → editorial). Fixed, visible penalty schedule. No runtime LLM tutoring (backlog only) |
| 13 | Workouts | **Full structure in v1** (M3): warm-up / working sets / overload / recovery, rationale, skip/replace tracking. **Diagnostic onboarding** with a first-class "I don't know how to approach this" skip that counts as calibration evidence |
| 14 | Observability | Correlation IDs + structured JSON logs from day 1; metrics as SQL over existing tables; in-app **/system** stats page. Prometheus + Grafana + load-test harness deferred to M5 |
| 15 | Auth | None in v1; `user_id` on every table so multi-user is a migration, not a rewrite |

**Standing assumptions:** React + Vite + Monaco + Tailwind frontend; single Postgres instance for app state, queue, and metrics; pnpm workspaces for TS, `uv` for Python.

---

## 3. Architecture

```
┌─────────────────────────── docker-compose (localhost) ───────────────────────────┐
│                                                                                  │
│  web (React/Vite/Monaco) ──HTTP/SSE──▶ api (Node/TS)                             │
│                                          │  ▲                                    │
│                              writes txn  │  │ LISTEN/NOTIFY → SSE fanout         │
│                                          ▼  │                                    │
│                                     Postgres ◀──────────────┐                    │
│                                  (app state + jobs table    │                    │
│                                   + metrics + events)       │                    │
│                                          ▲                  │                    │
│                     lease/heartbeat/ack  │                  │                    │
│                                          │                  │                    │
│   judge coordinator + sandbox workers (Node/TS) ──docker run──▶ sandbox          │
│                                          ▲                       containers      │
│                                          │                       (pinned images) │
│   replenishment + verification worker (Python) ──subprocess──▶ claude -p         │
│                                                    └──── also uses sandbox ──────┘
└──────────────────────────────────────────────────────────────────────────────────┘
```

**Services** (each its own process, all talking to the same Postgres):

- **web** — workout view, problem workspace (Monaco), progress dashboard, /system stats.
- **api** (TS) — HTTP + SSE. Owns request validation, problem delivery (public fields only), submission creation, workout endpoints, learner-state reads. Transactionally writes domain rows + queue jobs. Fans out job/submission state changes to SSE via Postgres `LISTEN/NOTIFY`.
- **judge coordinator + workers** (TS) — claims `judge` jobs from the queue, drives the submission state machine, launches sandbox containers, applies results idempotently, emits `NOTIFY`.
- **content worker** (Python) — claims `generate` and `verify` jobs (lower priority class), invokes `claude -p` with structured prompts, runs the six-stage verification gate (executing all generated code inside the same sandbox substrate), writes approved problems + verification reports.

**Key invariant:** generated code is untrusted code. Verification executes reference/brute-force/mutant solutions under exactly the same sandbox as user submissions. The sandbox substrate is built once (M1) and reused by the content plane (M2).

### Sandbox contract (per execution)

`docker run` with: `--network none`, read-only root FS, `--tmpfs` writable workspace, non-root UID, `--memory`, `--cpus`, `--pids-limit`, wall-clock timeout enforced by the worker, stdout/stderr byte caps, pinned per-language image (recorded on every execution). Hidden tests enter the container only via the harness bundle for that run; no secrets or credentials exist in the image. **Threat model (documented in M5):** the outer boundary on macOS is Docker Desktop's Linux VM; this is appropriate for a single-user tool judging the author's own code and is stated as a limitation, not hidden. Public multi-tenant execution stays out of scope until a reviewed isolation layer exists.

### Queue design (hand-built on Postgres)

- `jobs(id, kind, priority, payload jsonb, status, attempts, max_attempts, lease_expires_at, leased_by, idempotency_key, correlation_id, created_at, ...)`
- Claim: `UPDATE ... WHERE id = (SELECT id FROM jobs WHERE status='queued' AND kind = ANY($kinds) ORDER BY priority, created_at FOR UPDATE SKIP LOCKED LIMIT 1) SET status='leased', lease_expires_at=now()+lease, leased_by=$worker RETURNING *`.
- Heartbeat extends the lease; a reaper requeues expired leases (target: eligible work recovered **< 10 s** after worker death); `attempts >= max_attempts` → `dead` (poison-job parking, surfaced on /system).
- **Priority classes:** interactive judge jobs > verification > generation.
- **Exactly-once effects, at-least-once delivery:** result application is guarded by unique idempotency keys (one terminal verdict per submission; one LearningEvent per submission), so duplicate delivery can never double-apply a mastery update.
- Enqueue always happens in the same transaction as the domain write that justifies it.

---

## 4. Problem representation

A **ProblemVersion** is immutable once approved. Corrections create a new version; old submissions stay bound to the version they ran against.

```jsonc
{
  "problem_id": "ulid", "version": 1,
  "title": "...", "internal_name": "story-neutral-slug",
  "statement_md": "...", "constraints_md": "...",
  "signature": {                       // language-neutral typed contract
    "name": "maxWindowSum",
    "params": [{"name": "nums", "type": "list[int]"}, {"name": "k", "type": "int"}],
    "returns": "int"
  },
  "examples": [{"args": [...], "expected": ..., "explanation": "..."}],
  "concepts": [{"id": "sliding_window", "role": "primary", "weight": 0.7},
               {"id": "arrays_hashing", "role": "secondary", "weight": 0.3}],
  "difficulty": {"rating": 1420, "confidence": "generated"},   // Elo scale
  "expected_active_minutes": [10, 25],
  "target_complexity": {"time": "O(n)", "space": "O(1)"},
  "reference_solution_py": "...", "brute_force_py": "...",
  "input_generator_py": "...",     // seeded, deterministic; used by differential + hidden-suite build
  "comparator": "exact | float_tol | unordered | checker_py",
  "hidden_tests": [...],           // built from verified generator outputs; never served to the client
  "mutants_py": ["...", "..."],    // plausibly-wrong solutions; must all be rejected
  "hints": {"l1_orientation": "...", "l2_conceptual": "...", "l3_structural": "...",
            "outline": "...", "editorial_md": "..."},
  "provenance": {"mode": "novel|template|composed", "model": "...", "prompt_version": "...", "generated_at": "..."},
  "state": "candidate | verifying | approved | rejected | retired"
}
```

Notes:
- **Type system v1:** `int, float, bool, str, list[T]` (nested). **M3 adds** `TreeNode` / `ListNode` with LeetCode-style level-order / array encodings, built by the harness — required for full NeetCode pattern coverage. **M4** brings C++ parity for all types.
- **Comparators** handle "any valid answer" problems (`unordered`, or a `checker_py` function verified alongside the solutions).
- Hidden tests are **correct by construction**: inputs come from the seeded generator + boundary derivation; expected outputs come from the differential-verified reference solution — never from LLM assertion.
- The client API serves only public fields. Hidden tests, solutions, generator, and mutants never leave the server.

### Concept taxonomy (seed data, from the NeetCode 150 pattern families)

`arrays_hashing → two_pointers_sliding_window → stacks_queues; arrays_hashing → binary_search; arrays_hashing → trees_bst → heaps_pq; trees_bst → graph_traversal (BFS/DFS) → graph_structure (toposort, union-find) → shortest_paths; graph_traversal → backtracking → dp_1d → dp_2d; arrays_hashing → greedy`

Stored as `concepts` + `concept_edges` tables with description, misconceptions, and supported difficulty range per concept. Editable seed migration, not hardcoded.

---

## 5. Content plane: generation + verification

### Generation (Python worker → `claude -p`)

- **Input:** structured request — target concepts + weights, target rating band, expected solve time, required/forbidden patterns, target complexity, comparator needs, similarity exclusions (recent titles/mechanics), neutral-story requirement.
- **Output:** the full ProblemVersion JSON above (schema-enforced; retry with error feedback on schema failure).
- Every invocation logged as a `model_runs` row: prompt version, duration, output hash, resulting candidate, final verification outcome — this powers the cost-per-approved-problem and pass-rate metrics.

### Verification gate — all six stages blocking, fully deterministic, sandboxed

1. **Schema** — required fields, well-formed signature/types, hint ladder present, no code blocks or algorithm names in L1/L2 hints, constraints parseable.
2. **Compile/load** — reference and brute-force run in the sandbox.
3. **Differential** — reference vs brute-force over N seeded random inputs from the generator (record seeds in the report); disagreement → shrink → reject with minimized counterexample.
4. **Boundary** — auto-derived from constraints (empty/min/max sizes, duplicates, extremes, negatives) + problem-declared adversarial cases; both solutions must agree and complete within limits.
5. **Example consistency** — every public example reproduced by the reference solution.
6. **Mutation** — every provided mutant must be rejected by the hidden suite (built in stage 3–4). A surviving non-equivalent mutant → reject. This is the guard against weak hidden suites silently corrupting the learner model with false Accepts.

Failures → `rejected` with a stored `verification_reports` row (stage results, seeds, counterexamples, solution hashes). There is no human approval queue and no admin UI: **failed = discarded with logged reason; the terminal is the admin console.**

### Replenishment (background prefetch)

- Predict demand from the learner profile: for each concept×rating band likely to appear in upcoming workouts (weak concepts, due reviews, next overload steps), maintain a **low-watermark buffer** (e.g., 3 unattempted approved problems per active band).
- When below watermark → enqueue `generate` jobs (lowest priority). The user-facing workout assembler only ever reads from the approved pool, so LLM downtime or verification failures degrade buffer depth, never the practice session.
- Escape hatch (M3+): "generate me a problem about X now" — an explicit synchronous request where waiting is expected.

---

## 6. Judge

- **Workflows:** `Run` (public examples / custom input; no mastery effect), `Submit` (versioned hidden suite; authoritative verdict), `Rejudge` (M4; historical submission against its pinned versions).
- **Lifecycle:** `created → queued → assigned → compiling → running → completed`, streamed to the client over SSE (no polling). Terminal verdicts: Accepted, Wrong Answer, Compilation Error, Runtime Error, Time Limit, Memory Limit, Output Limit, Internal Judge Error, Cancelled.
- **Harness codegen:** from the typed signature, generate a per-language main that deserializes JSON args, invokes the user function, and emits structured per-test results (status, output, time, memory). Python: direct import + `json`. C++ (M4): generated `main.cpp` with type mapping (`list[int]` → `std::vector<int>`, …) compiled against the user's function.
- Every execution records image digest, language/compiler version, flags, limits, and resource usage (`execution_attempts`), making historical verdicts reproducible.

---

## 7. Learner model

**State** (`user_concept_state` per user×concept): `rating`, `uncertainty` (RD), attempt/solve/unassisted counts, streaks, rolling active-time stats, hint usage by level, last-practiced, next-review-at, error-category counts, plus append-only `learning_events` (before/after state + full evidence for every change — the explainability requirement, satisfied structurally).

**Prediction:** `P(success) = 1 / (1 + 10^((problem_rating − user_rating)/400))`, using the weighted blend of concept ratings for multi-concept problems.

**Outcome score** (bounded 0–1, replaces binary win/loss):
- Base: Accepted = 1.0, give-up/abandon = 0.0.
- Hint cap (visible before each hint is taken): L1 → 0.9, L2 → 0.75, L3 → 0.6, outline → 0.4.
- Modifiers within ±0.1: active time vs expected band; substantive submission count. Compilation errors are excluded from mastery impact unless recurrent (tracked as language-level error category instead).
- **Diagnostic/workout skip ("I don't know how to approach this")** = 0.0 outcome at reduced evidence weight — it lowers the estimate *and* the uncertainty without a demoralizing forced failure. Skip-for-preference (replace) is recorded separately and does **not** count as inability.

**Update:** Elo delta = K × (outcome − expected), K scaled by uncertainty (fast early calibration, stable later), delta split across concepts by weight, per-problem swing capped. Uncertainty shrinks with evidence and grows slowly with inactivity. Problem ratings drift only marginally from single-user data; difficulty quality is owned by generation-time estimation (concept depth, constraints, brute/optimal gap observed during verification).

**Review scheduler:** SM-2-style per concept — interval grows with successful review outcomes, shrinks on failure; `next_review_at` feeds workout assembly urgency. Deliberately boring in v1.

---

## 8. Product surface

### Diagnostic onboarding (M3)
Short adaptive baseline (~4–6 problems): starts low-mid per concept cluster, steps difficulty on success, drops fast on skip/failure. The skip button is prominent and judgment-free — skipping is expected for unknown topics and is exactly what makes the diagnostic short. Output: seeded ratings with honest uncertainty. Optional config self-seed remains available; self-ratings only seed, never establish mastery.

### Workouts (M3)
Assembled from the approved pool: **warm-up** (prerequisite/recent concept, high P(success)) → **working sets** (1–2 problems in the 65–80% band on target weakness) → **overload** (slightly above band or concept combination) → **recovery** (spaced review when due). Each workout shows rationale ("targets union-find: mastery 41%; reviews sorting: 9 days idle"), estimated duration, and challenge level. Session-length and topic-focus requests honored; replace vs can't-solve tracked distinctly. Concept/algorithm tags stay hidden until solve or give-up.

### Workspace (M1, grows through M3)
Statement/examples/constraints; Monaco with language select; Run (custom input) and Submit; live state + per-test progress via SSE; verdict with runtime/memory and safe diagnostics; hint ladder with visible penalty; give-up → editorial; post-solve editorial + complexity; active-time tracking with focus/blur pause (timer display can be hidden; measurement continues).

### Progress (M3)
Mastery + uncertainty per concept (with trend), review-due list, solve stats by difficulty (with/without hints), median active time, error-category recurrences, personal records (highest unassisted difficulty; comparable-time improvements — not raw counts), workout history.

### /system (M1, grows)
Queue depth + wait percentiles, worker liveness/leases, verdict distribution, buffer depth per band, generation pass rate by stage, model-run latency/cost, recent dead jobs — all SQL over existing tables.

---

## 9. Data model (Postgres, single instance)

`users` · `concepts` · `concept_edges` · `user_concept_state` · `problems` · `problem_versions` (immutable content JSON + state) · `problem_concepts` · `verification_reports` · `workouts` · `workout_items` (role, rationale, selection evidence, completion/skip state) · `submissions` (source hash, language, lifecycle, verdict, idempotency key) · `execution_attempts` (worker, image digest, limits, usage, per-test results) · `hint_events` · `learning_events` (append-only) · `model_runs` · `jobs` (queue).

Conventions: ULID keys; `correlation_id` propagated request→job→execution→event; `user_id` on every user-owned table; migrations from M0; server-only columns never serialized to the client.

---

## 10. Milestones

### M0 · Foundations
Monorepo scaffold (pnpm: `web`, `api`, `judge`, `shared`; `content/` via uv), docker-compose (Postgres + services), migration tooling + initial schema, structured JSON logging with correlation IDs end-to-end, taxonomy seed migration.
**Done when:** `docker compose up` brings up all services green; a request's correlation ID is traceable through api → job → worker logs.

### M1 · The Loop (walking skeleton)
Python-only judge on the sandbox contract; hand-built queue (claim/lease/heartbeat/reaper/idempotent ack); submission state machine streamed over SSE; Monaco workspace with Run + Submit; Glicko-lite engine writing LearningEvents; simple next-problem selection (nearest 65–80% band on weakest concept, one-line rationale); generation CLI (`claude -p`) with stages 1/2/5 only + human eyeball to seed ~10–15 problems across 3–4 concepts.
**Done when:** solve a problem end-to-end in the browser — queued→running→verdict streamed, rating moves, next selection reflects it. Kill a worker mid-judge: job requeues, no duplicate LearningEvent.

### M2 · Content Factory
Full six-stage verification gate (differential + boundary + mutation, sandboxed, seeded, reported); replenishment worker with watermark buffer per concept×band; priority classes enforced (interactive > verify > generate); `model_runs` provenance + cost metrics; /system shows pass-rate by stage and buffer depth.
**Done when:** the pool refills itself unattended against the current profile; a deliberately-broken candidate (wrong reference, weak tests, surviving mutant) is rejected at the right stage with a stored report; no human eyeball in the publish path.

### M3 · Training Product (**v1 — daily use starts here**)
Diagnostic onboarding with skip-as-signal; full workout assembly (roles, rationale, duration budgeting, replace-vs-inability tracking); SM-2 review scheduling feeding recovery items; hint ladder UI with visible penalties + give-up/editorial flow; progress dashboard; tree/linked-list types in the Python harness (tree-pattern problems enter the pool); focused-workout and synchronous-generation escape hatches.
**Done when:** a fresh user goes diagnostic → explained workout → full session daily, with tree problems in rotation and every mastery change explainable from LearningEvents.

### M4 · Judge Hardening + C++
C++20 pipeline (pinned toolchain image, compile stage with error surfacing, harness codegen + type mapping incl. trees/lists); Rejudge against pinned versions; duplicate-delivery and idempotency test suite; poison-job parking + /system surfacing; automated worker-kill recovery test (< 10 s requeue) in CI.
**Done when:** the same problem passes in Python and C++; a rejudged historical submission reproduces its verdict; chaos tests pass repeatedly.

### M5 · Ops & Evidence (portfolio)
Prometheus + Grafana (compose profile); load-test harness with documented profile (concurrent sessions, submission mix, language mix) producing p50/p95/p99 queue + judge latency, throughput, and lease-recovery time; threat-model document (Docker-in-VM boundary, single-user assumptions, what public deployment would require); architecture README + demo script walking the full loop: weakness → objective → generation → verification (incl. a visible rejection) → sandboxed judging with streamed results → hint → explainable mastery update → next-workout change → dashboards.
**Done when:** the demo runs start-to-finish from a clean `docker compose up`, and the measured numbers live in the repo.

### M6 · Backlog (unscheduled, in rough order)
Novelty/similarity checking (only if repetition is actually observed) · empirical complexity validation · `codex exec` as alternate generator · runtime code-aware hint (level 4) with strict prompt boundaries · multi-user auth + VPS deployment (compose lift + local generation agent) · richer FSRS-style scheduling · mistake-category classification beyond deterministic signals.

---

## 11. Explicitly cut from the GPT spec (with reasons)

- **Runtime-blocking generation** — replaced by prefetch buffer; nobody practices against a spinner.
- **IRT / Bayesian knowledge tracing** — statistically unfittable with one user and never-before-seen problems.
- **Cross-model ambiguity review** — single-model generation by decision; deterministic gates carry correctness.
- **Admin console, approval queues, quarantine workflow, RBAC, audit UI** — single-user; rejected candidates are logged rows, the terminal is the admin console.
- **Redis/NATS/BullMQ** — Postgres queue is sufficient at this scale and is where the reliability portfolio gets earned.
- **gVisor/Firecracker isolation** — unavailable on macOS hosts; Docker Desktop VM boundary documented honestly instead. Public multi-tenant execution stays disabled (spec agrees).
- **Per-IP/global rate limiting, abuse controls, retention/consent machinery** — no strangers on the system; revisit at multi-user (M6).
- **100-session / 25-concurrent-execution targets** — replaced by measured, honest single-machine numbers in M5.
- **OpenTelemetry tracing** — correlation IDs in structured logs deliver the debugging value at a fraction of the setup.
- **Quality scoring thresholds, human-calibrated difficulty review** — six deterministic gates + generation-time estimation own quality in v1.

---

## 12. Risks worth naming

1. **Generated-problem quality is the product's ceiling.** The six-stage gate guarantees *correctness*, not *interestingness*. Mitigation: provenance metrics (pass rate by stage, rejection reasons) tune prompts; the M3 escape hatches and replace-tracking surface boredom; novelty checking waits in M6 with a trigger condition (observed repetition).
2. **Difficulty estimates will be noisy** with no population to calibrate against. Mitigation: Elo self-corrects the *user* side quickly; expected-time bands widen the tolerance; verification records brute/optimal runtime gap as an objective difficulty signal.
3. **JSON↔C++ harness codegen is the biggest hidden time sink** (M4). Mitigation: the type system is deliberately tiny; Python-first proves the contract before C++ pays the tax.
4. **Hand-built queue edge cases** (lease races, poison jobs) will bite. Mitigation: they're the point — M4's chaos/idempotency test suite is a first-class deliverable, not an afterthought.
