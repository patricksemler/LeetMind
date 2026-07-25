# LeetMind

**Progressive overload for problem solving.** LeetMind generates original, deterministically
verified algorithm problems on your own machine, judges your code in sandboxed containers, and
models your mastery per concept so every session targets the edge of your ability — covering the
pattern families of the NeetCode 150.

It is built first as a daily-use tool for its author, and second as a portfolio artifact. The
engineering that earns the second is engineering the first genuinely needs: a hand-built job queue,
a sandboxed execution substrate, a six-stage verification gate, and a learner model whose every
decision is explainable.

- [`PLAN.md`](PLAN.md) — the *what* and *why*: decision log, milestones, explicit cuts.
- [`docs/CONTRACTS.md`](docs/CONTRACTS.md) — normative names, shapes, schema.
- [`docs/threat-model.md`](docs/threat-model.md) — what the isolation boundary actually is.
- [`docs/measurements.md`](docs/measurements.md) — measured latency/throughput, and their limits.

## Status

All six milestones (M0–M5) are implemented and test-covered. **549 tests** across the workspace:

| Package | Tests | What it covers |
|---|---:|---|
| `@leetmind/shared` | 35 | zod contracts, `toPublicProblem` leak-proofing, tree/list codecs |
| `@leetmind/db` | 26 | pool, migrations, bigint parsing, test-DB guard |
| `@leetmind/queue` | 14 | claim/lease/heartbeat/reaper, priority, idempotency, poison jobs |
| `@leetmind/sandbox` | 102 | isolation flags, harness protocol, C++ codegen, **cross-language parity** |
| `@leetmind/learner` | 87 | Glicko-lite, outcome scoring, SM-2, workout assembly, convergence |
| `apps/web` | 24 | SSE lifecycle, active-time, hint penalties, verdict-leak safety |
| `apps/api` | 46 | transactional enqueue, SSE races, give-up idempotency, sentinel leaks |
| `apps/judge` | 21 | state machine, exactly-once mastery, **7 chaos scenarios** |
| `content/` (Python) | 194 | six-stage gate, generation envelope, replenishment, DB nesting |

Notable verified properties:

- **Cross-language parity** — the same hidden suite yields the same verdict in Python and C++20,
  across scalars, nested lists, strings, floats, `TreeNode` and `ListNode` (12/12).
- **Worker-kill recovery in ~8.3s** — a real `SIGKILL` of a real worker mid-execution, reaper
  requeue, second worker completes exactly once. Budget is 10s.
- **Exactly-once mastery** — enforced structurally by a unique idempotency key, not by an
  application-level check. Verified under 8 concurrent duplicate deliveries.
- **Generation reliability** — 3/3 real `claude -p` calls parsed and validated first try using the
  delimited envelope format, at ~$0.37/candidate. The earlier single-JSON-object format failed.

## Quickstart

```bash
pnpm install
docker compose up -d db
pnpm db:migrate
./scripts/build-images.sh          # sandbox runner images (python + c++)

pnpm dev:api                       # :8080
pnpm dev:judge                     # claims judge jobs
pnpm dev:web                       # :5173
```

## See the whole loop in one command

```bash
./scripts/demo.sh
```

Walks weakness → generation → verification (with a visible rejection) → sandboxed judging with
streamed verdicts → explainable mastery update → next workout → dashboards. Add `--live` to call the
real model for generation, `--keep` to leave the seeded data in place.

## Architecture

```
web (React/Vite/Monaco) ──HTTP/SSE──▶ api (Fastify)
                                        │  ▲
                            writes txn   │  │ LISTEN/NOTIFY → SSE fanout
                                        ▼  │
                                   Postgres ◀────────────┐
                                (app state + jobs queue   │
                                 + metrics + events)      │
                                        ▲                 │
                   lease/heartbeat/ack  │                 │
                                        │                 │
   judge coordinator + workers (TS) ──docker run──▶ sandbox containers
                                        ▲                 (pinned images)
                                        │
   content plane (Python) ──subprocess──▶ claude -p
              └──── executes generated code in the SAME sandbox ────┘
```

Four design decisions carry most of the weight:

1. **The queue is hand-built on Postgres** — `FOR UPDATE SKIP LOCKED`, leases, heartbeats, a reaper,
   priority classes, and idempotency keys. Enqueue always joins the transaction of the domain write
   that justifies it, so a rolled-back submission can never leave an orphan job.
2. **There is exactly one sandbox implementation.** The Python content plane cannot build `docker
   run` arguments; it shells out to the TypeScript sandbox CLI. Generated code is untrusted code,
   and it runs under precisely the same isolation as user submissions.
3. **Hidden tests are correct by construction.** Inputs come from a seeded generator plus boundary
   derivation; expected outputs come from the differential-verified reference solution — never from
   model assertion. (This repo has a worked example of why: a hand-written fixture expectation was
   simply wrong, and the gate's regenerated suite disagreed with it correctly.)
4. **Every mastery change is explainable.** `learning_events` is append-only and stores before/after
   state plus the full evidence and a human sentence: *"Expected 64% success (you 1200 vs problem
   1100); scored 1. sliding_window +12 (1200→1212, ±350→±160)."*

## Running the tests

Tests never touch the development database. They run against a separate `leetmind_test` database,
and a guard refuses any destructive fixture unless the target database name ends in `_test` — see
[`docs/CONTRACTS.md` §13](docs/CONTRACTS.md). That guard exists because a prior data-loss incident
truncated real practice history; it is defence in depth, not ceremony.

```bash
createdb leetmind_test
DATABASE_URL=postgres://leetmind:leetmind@localhost:5432/leetmind_test pnpm db:migrate
```

```bash
pnpm -w test                       # every TS package + app
cd content && uv run pytest -q     # Python content plane
cd content && uv run pytest -n 4   # parallel (schema-per-worker isolation)
```

Suites are isolated per process, so the TypeScript and Python suites can run simultaneously.
`@leetmind/queue` provisions its own throwaway Postgres automatically.

## Operations

```bash
docker compose --profile metrics up          # Prometheus + Grafana on :3000
node --import tsx scripts/requeue-dead-job.ts list
node --import tsx scripts/loadtest/run.ts    # measured p50/p95/p99
```

`/api/system/stats` is plain SQL over existing tables: queue depth and wait percentiles, worker
liveness, verdict mix, buffer depth per band, generation pass-rate by stage, and recent dead jobs.
There is no admin UI by design — the terminal is the admin console.

## Repo layout

| Path | Purpose |
|---|---|
| `apps/web` | React + Vite + Monaco workspace, progress, diagnostic, `/system` |
| `apps/api` | Fastify HTTP + SSE over Postgres `LISTEN/NOTIFY` |
| `apps/judge` | Judge coordinator, submission state machine, rejudge, chaos suite |
| `packages/shared` | zod contracts, logging, config, `toPublicProblem` |
| `packages/db` | pool, migration runner, repositories, test-DB guard |
| `packages/queue` | the Postgres job queue |
| `packages/sandbox` | `docker run` wrapper, harness protocol, C++ codegen, CLI bridge |
| `packages/learner` | Glicko-lite mastery, SM-2 review, workout assembly (pure) |
| `content/` | Python content plane — generation, six-stage verification, replenishment |
| `scripts/` | demo, load test, image build, dead-job requeue |

## Known limitations

Stated here rather than buried: this is a **single-user tool with no authentication**, and on macOS
the real isolation boundary is Docker Desktop's Linux VM rather than the container. Both are
appropriate for running your own code on your own machine, and both are disqualifying for public
multi-tenant execution. [`docs/threat-model.md`](docs/threat-model.md) says exactly what would have
to change first.
