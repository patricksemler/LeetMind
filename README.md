# LeetMind

**Progressive overload for problem solving.** LeetMind generates original, deterministically
verified algorithm problems on your own machine, judges your code in sandboxed containers, and
models your mastery per concept so every problem targets the edge of your ability — covering the
pattern families of the NeetCode 150.

It is built first as a daily-use tool for its author, and second as a portfolio artifact. The
engineering that earns the second is engineering the first genuinely needs: a hand-built job queue,
a sandboxed execution substrate, a six-stage verification gate, and a learner model whose every
decision is explainable.

- [`PLAN.md`](PLAN.md) — the *what* and *why*: decision log, milestones, explicit cuts.
- [`docs/CONTRACTS.md`](docs/CONTRACTS.md) — normative names, shapes, schema.
- [`docs/threat-model.md`](docs/threat-model.md) — what the isolation boundary actually is.
- [`docs/measurements.md`](docs/measurements.md) — measured latency/throughput, and their limits.

## How it works

One surface. You open the app and you get a problem.

`GET /api/practice/next` answers "what should I do right now?" and it always has an answer:

| | |
|---|---|
| **a problem** | verified, approved, unattempted, at the edge of your weakest evidenced concept |
| **generating** | nothing verified is left in that band, so a new problem is being written and verified for you — the wait is shown, not hidden behind an empty state |

There is no session to start, nothing to plan, no onboarding to finish, and nothing persisted
between problems. **The learner state *is* the plan**, re-read on every request — so the next
problem reflects the solve you just finished, not a list chosen before you started.

### Finding your level without asking

The first six problems are calibration, and they never say so. Difficulty starts a little below
average, steps up 120 on a solve and drops 220 on a give-up, so it lands in the right
neighbourhood in about two problems. Dropping almost twice as fast as it climbs is the whole
trick: being handed something far beyond you is what makes people quit, and being handed something
slightly too easy costs one problem.

> **The baseline was removed.** v2 opened with a diagnostic probe you had to complete before
> practice would serve you anything — six problems, a progress counter, a `needs_baseline` gate.
> The stepping rule above *was* the baseline; everything around it was ceremony asking the user to
> agree to be measured before being allowed to start. The rule stayed and the screen went.

### When you're stuck, it teaches instead of retrying

Two failures on a concept, or one give-up, and the app stops asking. It shows the full solution and
then makes you **type it out** before you can move on — reading a solution produces the feeling of
understanding without the encounter with the details that writing it forces you through. The
transcription runs against the real hidden test suite so you see it pass, but it is scored as
nothing: the reveal was already scored, and copying it out must not hand that back.

Then two follow-ups, planned at the moment of the reveal so that closing the tab can't skip them:

| | |
|---|---|
| **reinforce** | immediately — same concept, **same shape**, a step easier. Where you use what you just typed, while it's still in working memory. |
| **transfer** | three days later — same concept, **different shape**. The one that actually measures whether anything was learned. |

The pair matters more than either half. Reinforce alone teaches recall of one solution; transfer
alone, with nothing in between, is just another failure a week later.

### Mastery is a claim, not a number

A rating can't tell three unaided solves over three weeks apart from one four-hint solve yesterday —
both land on 1500. So mastery has its own bar, and all five clauses must hold: you're at the top of
that concept's own difficulty range, the estimate has settled, you solved without hints, across
different problems, spread over more than a week. The last one can't be satisfied in a single
sitting, which is the point.

Everything you do teaches the model something — solve, skip, give up, or be taught — and every
resulting change is explained in plain language:

> This problem was rated 1450 and you were at 1200, so you had about a 1 in 5 chance. You solved it
> unaided. That moves **Two Pointers** up 39 to 1239. The estimate is more confident than before:
> give or take 160 points instead of 350.

## Status

All six milestones (M0–M5) are implemented and test-covered. **673 tests** across the workspace,
all passing:

| Package | Tests | What it covers |
|---|---:|---|
| `@leetmind/shared` | 39 | zod contracts, `toPublicProblem` leak-proofing, tree/list codecs |
| `@leetmind/db` | 26 | pool, migrations, bigint parsing, test-DB guard |
| `@leetmind/queue` | 14 | claim/lease/heartbeat/reaper, priority, idempotency, poison jobs |
| `@leetmind/sandbox` | 112 | isolation flags, harness protocol, C++ codegen, **cross-language parity** |
| `@leetmind/learner` | 102 | Glicko-lite, outcome scoring, SM-2, cold-start stepping, teaching triggers, mastery clauses, convergence |
| `apps/web` | 69 | SSE lifecycle, practice loop, teaching/follow-up rendering, hint penalties, verdict-leak safety |
| `apps/api` | 74 | auth + token verification, practice selection/generation, cold start, follow-up queueing, transcribe gating, transactional enqueue, SSE races, sentinel leaks |
| `apps/judge` | 38 | state machine, exactly-once mastery, public-vs-hidden failure semantics, **7 chaos scenarios** |
| `content/` (Python) | 199 | six-stage gate, generation envelope, replenishment, DB nesting |


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
cp .env.example .env               # then edit: at minimum DATABASE_URL
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
streamed verdicts → explainable mastery update → the next problem practice picks as a result →
dashboards. Add `--live` to call the real model for generation, `--keep` to leave the seeded data
in place.

It runs against the **development** database on purpose — the point is to demonstrate the real
application, not a fixture — and removes only its own `demo-*` rows afterwards. Point it somewhere
disposable if you would rather it didn't:

```bash
DATABASE_URL=postgres://leetmind:leetmind@localhost:5432/leetmind_scratch ./scripts/demo.sh
```

## Accounts

Authentication is **Supabase Auth** (email + password). LeetMind's own database never stores a
credential — it stores only the binding between a verified Supabase subject and the local `users`
row that owns the practice history, so every existing `user_id` foreign key kept working.

```bash
supabase start                     # local: db + auth on :54321
supabase status -o env             # copy API_URL and ANON_KEY into .env
```

Set `SUPABASE_URL` (API) and `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (web). Tokens are
verified against the project's published JWKS; leave `SUPABASE_JWT_SECRET` **unset** unless the
project is a legacy one that still signs HS256. Which path a given token takes is decided by the
token's own header, so a project mid-rotation works either way.

Pointing at a hosted project instead is a change of those env vars and nothing else.

- **Single-user mode still works.** With no `SUPABASE_URL` and `NODE_ENV != production`, every
  request is pinned to `SINGLE_USER_ID` — the pre-accounts behaviour, which is what the test suites
  and `pnpm dev:mock` run against. In production, booting without a Supabase project is a hard
  failure rather than a silently shared account.
- **Claiming the pre-accounts history.** Set `LEGACY_CLAIM_EMAIL` to the address that should adopt
  the `SINGLE_USER_ID` row. The first account signing in with exactly that address takes ownership
  of it; nobody else ever can, and unset means nobody does.

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
4. **Every mastery change is explainable, in language a person can read.** `learning_events` is
   append-only and stores before/after state, the full evidence, and a sentence that still makes
   sense months later with no UI around it. The explanation used to be written for whoever was
   debugging the model — *"Expected 64% success (you 1200 vs problem 1100); scored 1.
   sliding_window +12 (1200→1212, ±350→±160)"* — which is correct and tells the person who just
   solved the problem nothing. Explainable has to mean explainable *to the user*: the 0..1 evidence
   score stays out of the interface entirely, and concepts are named, not slugged.

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
| `apps/web` | React + Vite + Monaco workspace, practice loop, baseline, progress, auth |
| `apps/api` | Fastify HTTP + SSE over Postgres `LISTEN/NOTIFY` |
| `apps/judge` | Judge coordinator, submission state machine, rejudge, chaos suite |
| `packages/shared` | zod contracts, logging, config, `toPublicProblem` |
| `packages/db` | pool, migration runner, repositories, test-DB guard |
| `packages/queue` | the Postgres job queue |
| `packages/sandbox` | `docker run` wrapper, harness protocol, C++ codegen, CLI bridge |
| `packages/learner` | Glicko-lite mastery, SM-2 review, baseline planning, selection (pure) |
| `content/` | Python content plane — generation, six-stage verification, replenishment |
| `scripts/` | demo, load test, image build, dead-job requeue |

## Known limitations

Stated here rather than buried.

**The isolation boundary is not the container.** On macOS it is Docker Desktop's Linux VM. That is
appropriate for running your own code on your own machine and disqualifying for public multi-tenant
execution, regardless of how many accounts the app now supports.
[`docs/threat-model.md`](docs/threat-model.md) says exactly what would have to change first —
accounts moved the authentication boundary, not the execution one.

**Generation costs real money and real time.** A problem is one `claude -p` call (~$0.37) plus a
six-stage verification gate, so the practice loop's `generating` state is measured in tens of
seconds. Background replenishment exists precisely so you rarely meet it, but a fast session on a
thin concept will out-run the content plane.

**Content quality is bounded by the gate, not by taste.** Verification proves a problem is
*correct* — reference agrees with brute force, boundaries hold, mutants die. It cannot prove a
problem is *interesting*. Complexity validation and novelty checking are deferred (`PLAN.md` §11).
