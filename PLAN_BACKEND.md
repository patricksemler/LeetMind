# PLAN_BACKEND — LeetMind backend, greenfield

**Status:** approved design, not yet implemented.
**Scope:** a complete rewrite of the LeetMind backend plus the minimal frontend rewiring needed to
speak to it. The old backend (deleted, in git history) is *not* consulted — this document is the
only spec.

---

## 1. What the system does

LeetMind serves one generated algorithm problem at a time, picked for the edge of the user's
ability. The backend owns four loops:

1. **Learner model** — a per-user Elo rating for every problem type, updated from solve metrics.
2. **Generation** — a two-step background pipeline (plan → build) that keeps every user one
   problem ahead: one *active* problem, one *on-deck*.
3. **Judging** — user code runs in a throwaway Docker container against public then private test
   cases.
4. **Feedback** — resolution metrics (runs, submissions, hints, time, give-up) become an Elo
   update, which feeds the next generation plan.

## 2. Decision record

Decisions made in the design review (2026-07-27). Each is binding for the implementation.

| # | Area | Decision |
|---|------|----------|
| 1 | Starting point | Complete greenfield; old code never consulted |
| 2 | Layout | Monorepo: `apps/web` (existing React app) + `apps/server` (new) |
| 3 | Server stack | Python 3.12 + FastAPI |
| 4 | Auth | Supabase Auth; browser holds the JWT, server only verifies it |
| 5 | Database | Supabase Postgres, raw SQL via asyncpg (no ORM) |
| 6 | Taxonomy | Fixed curated flat list of 20 problem types, seeded at migration |
| 7 | Type blending | One **primary** type (gets the full Elo update) + 0–2 **support** types drawn from strengths (scaffolding only, no Elo effect) |
| 8 | Elo | Performance-score Elo: `R += K·(S − E)`; S discounted by hints/failed submits/excess runs/time-over-par; give-up = 0; K decays with per-type evidence |
| 9 | Cold start | Seed 1200 unevidenced; coverage-first probe phase; weakness targeting engages per-type only with real evidence |
| 10 | Planner (step 1) | Deterministic scored shortlist (top 3 types) → one LLM call picks primary from the shortlist, support types, target rating, premise |
| 11 | Builder (step 2) | Emits statement, signature, public+private tests, 4-rung hint ladder, reference solution, complexity, par time. **Judge-verified**: servable only after the reference solution passes 100% of tests; bounded repair loop |
| 12 | LLM transport | Subprocess to a coding-agent CLI — `claude -p` (default) or `codex exec`; JSON-schema-validated output; uses the CLI's own login, no API keys in the server |
| 13 | Pipeline | Single FastAPI deployable; asyncio worker consuming a Postgres `generation_jobs` table via `FOR UPDATE SKIP LOCKED` |
| 14 | Languages | Python-only submissions in v1 |
| 15 | Sandbox | Containment **is** the safety check: ephemeral container, no network, non-root, read-only fs, mem/CPU/pids/time/output caps. No static code screening |
| 16 | Run/Submit | Two actions. Run = public cases only, never scored. Submit = public then private; failing a public case demotes the submit to a run; a private failure reveals the failing case (input, expected, actual) |
| 17 | Contract | pydantic → OpenAPI → generated TS types in the frontend; drift is a compile error |
| 18 | Delivery | Judge verdicts returned synchronously; generation progress over SSE |
| 19 | Deployment | Local-first, VPS-shaped: docker compose portable to any Docker host; hosting out of scope |
| 20 | Frontend scope | Rewire the seam only: new client, generated types, SSE hook, drop C++, fix what the typechecker flags |
| 21 | Testing | Real Postgres + real Docker in tests; the LLM CLI stubbed with recorded fixtures; Elo/selection unit-tested; Playwright smoke re-pointed |
| 22 | Elo legibility | Every resolution response carries a full rating-update breakdown so the UI can explain the change |

**Inherited invariants** (from the earlier selection-collapse incident; the selection scorer must
satisfy all four by construction):

- I1. Never-attempted types stay reachable.
- I2. Weakness is evidence-gated — a seeded rating with `attempts = 0` is not a measurement.
- I3. Something breaks the fail → rating-drop → same-type-again loop (repetition penalty).
- I4. Premise **shape** rotates least-recently-used per type, so "avoid this title" can't be
  satisfied by writing the same problem under a new name.

### 2.1 Review amendments (external review, 2026-07-27)

A review of the first draft produced eight findings. Rows 23–30 are the accepted outcomes,
folded into the body sections below. The reveal-policy finding was put back to the user and the
original spec was deliberately **re-affirmed**, not changed.

| # | Area | Decision |
|---|------|----------|
| 23 | Judge integrity | User code never shares a process with the harness: supervisor/child split inside the container. The child sees only user code + one test input; expected outputs live only in the supervisor; timeouts are enforced by the supervisor, not by an alarm user code could cancel |
| 24 | Verification | Supersedes row 11's single-verify: **brute-force differential**. The builder also emits a naive brute-force solution and a random input generator; reference and brute must agree on all authored tests plus N random inputs |
| 25 | Reveal policy | Re-affirmed: every failed submission reveals its first failing private case in full (input, expected, actual). Single-player — enumeration/hardcoding only corrupts the cheater's own rating, and each failed submission already costs Elo |
| 26 | Job durability | Planner output persisted as `generation_jobs.plan_json`; leases use fencing tokens + heartbeats; every stage write requires a matching lease token |
| 27 | Concurrency | Invariants enforced in the database, not application code: partial unique indexes (one `active`, one `ready` per user), `UNIQUE (problem_id)` on `rating_updates`, per-user `pg_advisory_xact_lock` around every queue mutation, resolution requires the row locked and still `active` |
| 28 | API semantics | `GET /practice/next` is a pure read (sole idempotent write: stamping `served_at` on first delivery); promotion happens in the resolution transaction and at worker completion; `POST /practice/replenish` covers bootstrap and self-heal; SSE is consumed via fetch-based streaming because native `EventSource` cannot send the bearer header |
| 29 | Difficulty scale | v1 anchors `problem_rating` to a deterministic prompt rubric (§6.3); `rating_updates` rows are the dataset for empirical recalibration later (v2). Accepted v1 limitation |
| 30 | Accepted trade-off | Personalization runs one problem behind: the on-deck problem was planned before the latest resolution. That is the price of always-one-ready. Pending plans are *reserved* in selection (§6.2) so parallel jobs can never duplicate type/shape |

Additional hardening from the same review: judge concurrency semaphore, per-user in-flight
execution limit, code/body size caps, explicit ownership predicate on every problem query, and
named containers so timeout cleanup kills the right one.

### 2.2 Review amendments, round 2 (2026-07-27)

| # | Area | Decision |
|---|------|----------|
| 31 | Planning serialization | The worker claim query refuses a job whose user already has another live-leased job, so per-user planning is fully serial and every reservation (`plan_json`) is committed before the next planning starts. Closes the window where two planners could pick the same type/shape |
| 32 | Oracle independence | The brute-force oracle is generated in a **separate CLI call that sees only the statement and signature** — never the reference solution, tests, or builder conversation. Expected outputs are the three-way agreed value (builder-expected = reference = oracle), not any single artifact's claim |
| 33 | Verification timeout | Verification gets its own wall clock (`VERIFY_WALL`, default 300 s); the interactive judge wall rises to 60 s (a full submit suite at the 2 s per-test cap exceeds 20 s) |
| 34 | No secrets in the container | Supersedes the in-container supervisor of amendment 23: the container now holds only a dumb **executor** (user code + test inputs, streamed results); expected outputs and verdict logic live in a server-side **comparator**. Children run in their own process group (`setsid`) and the whole group is killed after every test. Killing or probing the executor is self-harm, not escape |
| 35 | Lock/guard pragmatics | Advisory-lock key is `hashtextextended(user_id::text, 0)` (uuid → bigint; a hash collision merely over-serializes). v1 mandates a single server process (`uvicorn --workers 1`): the judge semaphore and in-flight guard are process-local by design; DB-backed guards are the v2 path to scale-out |
| 36 | Solve timer | Supersedes the `served_at` stamp in amendment 28: `GET /practice/next` is now a fully pure read. The workspace calls idempotent `POST /problems/{id}/open` on mount, which stamps `served_at` once — browser prefetch can no longer start the clock |
| 37 | CLI containment | The coding-agent CLI runs with agent tools disabled (exact flags live in `LLM_ARGS`) and its cwd set to a fresh empty temp dir per call, so generation can neither read nor write the server workspace |

### 2.3 Review amendments, round 3 (2026-07-27)

| # | Area | Decision |
|---|------|----------|
| 38 | Judge protocol & escape | Test inputs are **streamed one at a time** — the container never holds an input it hasn't run, so private inputs can't be exfiltrated ahead of execution. The child bootstrap installs a seccomp filter denying process creation, `setsid`/`setpgid`, `ptrace`, and `kill` before user code runs (a re-`setsid` grandchild can never exist); the executor additionally sweeps `/proc` after every test |
| 39 | Value contract | §8.4 defines the closed type grammar for signatures (JSON-representable scalars + nested lists, nullable markers), representation rules for trees/lists/graphs (plain lists, no custom node classes in v1), float tolerance, and type-strict comparison. Builder output is schema-rejected outside the grammar |
| 40 | CLI containment, honest version | Supersedes 37's claim: an empty cwd + read-only sandbox does not stop absolute-path reads. The adapter passes a **sanitized allowlist environment** (no server secrets) and hard no-tools CLI config; an optional containerized CLI mode (`LLM_CONTAINER=1`) provides a genuine boundary for hosted deployments. Defense-in-depth note: no user-controlled text ever enters a generation prompt |
| 41 | Open-gated delivery | Supersedes 36's split: `GET /practice/next` returns only a **stub** (`problem_id`, no statement); `POST /problems/{id}/open` atomically stamps `served_at` and returns the full `ProblemView` — the statement is unobtainable pre-open, and run/submit/hints 409 until opened. The timer and the content are now the same atom |
| 42 | Failed-generation cleanup | When a job goes `failed`, its `problems` row (if any) is marked `failed` in the same transaction — a dead `building` row must not reserve its type/shape forever |

## 3. Repo layout

```
leetmind/
├── apps/
│   ├── web/                  # existing frontend, moved from repo root
│   └── server/
│       ├── pyproject.toml    # uv-managed; fastapi, uvicorn, asyncpg, pydantic, PyJWT, sse-starlette
│       ├── src/leetmind/
│       │   ├── main.py       # app factory, lifespan (pool + worker), CORS
│       │   ├── config.py     # env settings (pydantic-settings)
│       │   ├── auth.py       # Supabase JWT verification dependency
│       │   ├── db.py         # asyncpg pool + query helpers + migration runner
│       │   ├── taxonomy.py   # the 20 types + the shape list (constants)
│       │   ├── elo.py        # pure: expected score, performance score, K schedule
│       │   ├── selection.py  # pure: type scoring, shortlist, probe policy
│       │   ├── llm.py        # CLI subprocess adapter (claude -p / codex exec)
│       │   ├── planner.py    # step 1: shortlist → plan JSON
│       │   ├── builder.py    # step 2: plan → full problem JSON
│       │   ├── verify.py     # reference solution vs generated tests, repair loop
│       │   ├── worker.py     # job claim loop, stage machine, SSE event emission
│       │   ├── judge.py      # docker run orchestration + server-side comparator (§8.2)
│       │   ├── routes/       # practice.py, problems.py, execution.py, hints.py, progress.py, events.py, health.py
│       │   └── schemas.py    # pydantic response/request models (the wire contract)
│       ├── judge/
│       │   ├── Dockerfile    # leetmind-judge image (python:3.12-slim + runner)
│       │   └── runner.py     # in-container executor: child-per-test, no secrets held (§8.2)
│       ├── migrations/       # 0001_init.sql, ... plain SQL, applied in order
│       └── tests/
├── docker-compose.yml        # server + judge image build; postgres for the test suite
├── package.json              # pnpm workspace root (web + codegen script)
└── PLAN_BACKEND.md
```

Repo restructure is Phase 0: first commit the pending backend deletion as its own commit, then
`git mv` the frontend into `apps/web`, then scaffold `apps/server`.

## 4. Data model

All tables in one schema, owned by the server's migrations (Supabase Auth's `auth.users` provides
user ids; we never write to it).

```sql
-- 20 rows, seeded by migration. slug is the stable Elo key.
CREATE TABLE problem_types (
  slug        text PRIMARY KEY,
  name        text NOT NULL,
  ordinal     int  NOT NULL
);

CREATE TABLE ratings (
  user_id     uuid NOT NULL,
  type_slug   text NOT NULL REFERENCES problem_types(slug),
  rating      real NOT NULL DEFAULT 1200,
  attempts    int  NOT NULL DEFAULT 0,        -- resolved problems only; the evidence gate
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, type_slug)
);
-- rows created lazily: all 20 on first authenticated request

CREATE TYPE problem_status AS ENUM
  ('building', 'ready', 'active', 'solved', 'given_up', 'failed');

CREATE TABLE problems (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  status             problem_status NOT NULL,
  primary_type       text NOT NULL REFERENCES problem_types(slug),
  support_types      text[] NOT NULL DEFAULT '{}',
  shape              text NOT NULL,                -- from the fixed shape list (invariant I4)
  problem_rating     int  NOT NULL,                -- target rating set by the planner
  is_probe           boolean NOT NULL DEFAULT false,
  title              text NOT NULL,
  statement_md       text NOT NULL,                -- includes worked examples = public tests
  signature          jsonb NOT NULL,               -- typed per the §8.4 value contract
  starter_code       text NOT NULL,
  public_tests       jsonb NOT NULL,               -- [{input:[...], expected}]
  private_tests      jsonb NOT NULL,               -- never serialized to the client
  hints              jsonb NOT NULL,               -- 4 rungs: orientation/conceptual/structural/outline
  reference_solution text NOT NULL,                -- revealed only on give-up
  complexity         jsonb NOT NULL,               -- {time, space}  e.g. {"time":"O(n log n)",...}
  par_minutes        int  NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  served_at          timestamptz,                  -- stamped once by POST /problems/{id}/open
                                                   --   (workspace mount), never on promotion
  resolved_at        timestamptz
);
CREATE INDEX ON problems (user_id, status);
-- the queue invariant, enforced by the database (amendment 27):
CREATE UNIQUE INDEX one_active_per_user ON problems (user_id) WHERE status = 'active';
CREATE UNIQUE INDEX one_ready_per_user  ON problems (user_id) WHERE status = 'ready';

CREATE TABLE executions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  problem_id  uuid NOT NULL REFERENCES problems(id),
  user_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('run', 'submit')),  -- post-demotion kind
  code        text NOT NULL,
  passed      boolean NOT NULL,
  results     jsonb NOT NULL,     -- per-test outcomes as returned to the client
  duration_ms int NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hint_reveals (
  problem_id  uuid NOT NULL REFERENCES problems(id),
  rung        int  NOT NULL CHECK (rung BETWEEN 1 AND 4),
  revealed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (problem_id, rung)
);

CREATE TABLE rating_updates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL,
  type_slug         text NOT NULL,
  problem_id        uuid NOT NULL UNIQUE REFERENCES problems(id),  -- Elo can never apply twice
  rating_before     real NOT NULL,
  rating_after      real NOT NULL,
  problem_rating    int  NOT NULL,
  expected_score    real NOT NULL,
  performance_score real NOT NULL,
  k_factor          real NOT NULL,
  metrics           jsonb NOT NULL,   -- {runs, submissions, hints_revealed, minutes, gave_up}
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE job_status AS ENUM ('queued', 'planning', 'building', 'verifying', 'ready', 'failed');

CREATE TABLE generation_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  status        job_status NOT NULL DEFAULT 'queued',
  problem_id    uuid REFERENCES problems(id),   -- set once the build starts
  plan_json     jsonb,                          -- persisted planner output; later stages, repair,
                                                --   and reservation lookups resume from it
  repair_count  int NOT NULL DEFAULT 0,
  error         text,
  lease_token   uuid,                           -- fencing token; every stage write requires a match
  heartbeat_at  timestamptz,                    -- refreshed every 60 s while a stage runs;
                                                --   lease is stale (reclaimable) after 5 min silent
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON generation_jobs (status, created_at);
```

**Queue invariant:** per user, at most one `active` problem, at most one `ready`, and
(`ready` exists OR a non-terminal job exists) whenever the user has ever practiced. The
"at most one" halves are database-enforced by the partial unique indexes above; the liveness
half is maintained at exactly three mutation points — the resolution transaction, worker job
completion, and `POST /practice/replenish` — every one of which runs under the per-user
advisory lock `pg_advisory_xact_lock(hashtextextended(user_id::text, 0))` (the uuid must be
hashed to the function's bigint key; a collision merely over-serializes two users, never
corrupts), so concurrent requests serialize instead of racing.

## 5. Taxonomy and shapes

Seeded constants in `taxonomy.py` (also the migration seed). Types (20):

`arrays_hashing, two_pointers, sliding_window, binary_search, stack, queue_deque, linked_list,
trees, bst, heap_priority_queue, tries, backtracking, graphs_bfs_dfs, graphs_advanced,
dp_1d, dp_2d, greedy, intervals, bit_manipulation, math_geometry`

Shapes (the premise skeletons rotated LRU per type, invariant I4):

`optimize_subarray, count_structures, kth_element, min_max_window, path_search, decision_feasibility,
construct_output, simulate_process, pairing_matching, partition_grouping, query_answering, transform_encode`

## 6. Learner model

All pure functions in `elo.py` / `selection.py`; every constant below lives in one tunables
module and is expected to be tweaked (see §13).

### 6.1 Rating update

On resolution (solve or give-up) of a problem with primary type `t`:

```
E = 1 / (1 + 10^((problem_rating − rating_t) / 400))      # expected score
S = 0                                                      # give-up / solution revealed
S = clamp(1 − hint_pen − submit_pen − run_pen − time_pen,  # solve
          0.30, 1.0)
K = 40 if attempts_t < 5 else 24 if attempts_t < 15 else 16
rating_t += K · (S − E)
attempts_t += 1
```

Penalties (solve only):

| Metric | Penalty |
|---|---|
| Hints: rung 1 / 2 / 3 / 4 revealed | 0.05 / 0.10 / 0.15 / 0.25 cumulative, capped at 0.40 |
| Failed submissions beyond the first | 0.05 each, capped at 0.15 |
| Runs beyond 6 | 0.01 each, capped at 0.05 |
| Time over par | 0.15 · clamp((minutes − par) / (2·par), 0, 1) |

Properties (deliberate): a low-rated user solving far above their rating gains big (E ≈ 0.1 →
+0.9·K); failing far above costs almost nothing; a sloppy, hint-heavy solve of a problem far
*below* the user's rating can lose a few points (S < E) — performance below expectation is
allowed to cost, and the breakdown makes it explainable. Support types never move.

Time is server wall-clock: `resolved_at − served_at`, capped at 4× par so an abandoned tab
doesn't nuke the score.

### 6.2 Selection scoring (deterministic, invariants by construction)

For each type, with `evidenced = attempts > 0`:

```
weakness   = evidenced ? max(0, (1400 − rating) / 400) : 0        # I2: gate on evidence
probe_need = evidenced ? 0 : 1                                     # I1: unevidenced dominates
staleness  = min(days_since_last_resolved / 14, 1)                 # unseen lately drifts up
repetition = count of type in last 8 resolved problems / 8         # I3

score = 1.0·weakness + 1.5·probe_need + 0.4·staleness − 1.2·repetition
```

Shortlist = top 3 by score. While **any** type is unevidenced, at least every second generation
must shortlist only unevidenced types (coverage-first probe phase); probe problems get
`is_probe = true`, `problem_rating = 1000`, and no support types (nothing evidenced to lean on).

Support-type candidates (passed to the planner, which picks 0–2): evidenced types with
`rating ≥ max(rating_t + 100, 1300)`.

**Reservation rule (amendment 30):** the repetition window and the shape-LRU count *pending*
work too — `active`/`ready`/`building` problems and the `plan_json` of every non-terminal job —
so concurrently running jobs (e.g. a new user's initial two) can never select the same type or
shape.

Target-rating band for non-probes: `[rating_t − 50, rating_t + 150]` — the planner places the
problem inside it, biased high when the recent trend on that type is positive.

### 6.3 Difficulty scale (v1 limitation, amendment 29)

Nothing in v1 measures whether a generated problem is *actually* as hard as its
`problem_rating`; the Elo scale is anchored by prompt discipline, not data. Two mitigations:

1. **Deterministic rubric** — planner and builder prompts both carry this table and must justify
   the rating against it:

   | Band | Structural requirement |
   |---|---|
   | ≤ 1000 | direct application of the type's basic pattern; one loop / one structure; no twist |
   | 1000–1200 | the standard technique plus one small twist or extra bookkeeping |
   | 1200–1400 | a non-obvious invariant, or two techniques composed; the naive approach is clearly too slow |
   | 1400–1600 | a multi-step insight; tight constraints; adversarial edge cases |
   | 1600+ | layered insights or an unusual reformulation of a known pattern |

2. **Recalibration dataset** — every `rating_updates` row stores `problem_rating`,
   `expected_score`, and `performance_score`, which is exactly the data needed to fit true
   difficulty from aggregate outcomes later. Empirical recalibration itself is v2 (§15).

## 7. Generation pipeline

### 7.1 Job lifecycle

`worker.py` runs as an asyncio task inside the FastAPI lifespan:

```
loop:
  job = SELECT … FROM generation_jobs j
        WHERE j.status NOT IN ('ready','failed')
          AND (j.lease_token IS NULL OR j.heartbeat_at < now() − interval '5 minutes')
          AND NOT EXISTS (SELECT 1 FROM generation_jobs o        -- amendment 31: per-user
                WHERE o.user_id = j.user_id AND o.id <> j.id      -- planning is serial, so
                  AND o.status NOT IN ('ready','failed')          -- reservations are always
                  AND o.lease_token IS NOT NULL                   -- committed before the next
                  AND o.heartbeat_at >= now() − interval '5 minutes')  -- planner reads them
        ORDER BY j.created_at LIMIT 1 FOR UPDATE SKIP LOCKED
  if none: sleep 2s; continue
  claim: lease_token = new uuid, heartbeat_at = now()
  while a stage runs, a sibling task refreshes heartbeat_at every 60 s
  every stage write is fenced:  UPDATE … WHERE id = $job AND lease_token = $token
    (a reclaimed job's old worker can no longer write anything — no double processing)
  stages:
    queued    → planning   : selection scoring (incl. reservations §6.2) + planner CLI call;
                             result persisted to plan_json BEFORE the status advances
    planning  → building   : builder CLI call → problem row (status 'building');
                             resumes from plan_json, never re-plans
    building  → verifying  : judge runs reference AND brute solutions per §7.4
    verifying → ready      : differential passes → under the per-user advisory lock:
                             no active problem exists → problem becomes 'active'
                             (served_at stamped later by POST /problems/{id}/open);
                             else 'ready'. Job 'ready'.
              → building   : any failure → repair prompt with the failing cases,
                             repair_count += 1 (max 3, then one full regenerate from the
                             same plan_json; then job 'failed', AND its problems row, if
                             any, marked 'failed' in the same transaction — a dead
                             'building' row must not reserve its type/shape (§6.2))
  each transition: fenced UPDATE + NOTIFY user's SSE channel
```

Enqueue points (each under the per-user advisory lock, each topping up only what the queue
invariant is missing): the resolution transaction; worker job completion; and
`POST /practice/replenish` (new-user bootstrap — two probe jobs — and self-heal).

A `failed` job is retried by enqueueing a fresh job (new planner roll) from the replenish path,
so one bad generation never wedges a user.

### 7.2 Step 1 — planner

Input: full Elo profile (all 20 types: rating, attempts, last-resolved-at), the top-3 shortlist
with per-type LRU shape, support-type candidates, titles + premises of the last 8 problems
plus all pending reservations (anti-repetition context), the target band, and the difficulty
rubric (§6.3).

One CLI call. Output (JSON-schema-validated):

```json
{
  "primary_type": "dp_1d",            // MUST be from the shortlist — else reject & re-ask once
  "support_types": ["arrays_hashing"],
  "shape": "count_structures",        // must be that type's LRU shape
  "problem_rating": 1180,             // must be inside the band
  "premise": "2–3 sentence original scenario …",
  "rationale": "one sentence for logs"
}
```

Code validates every field against the constraints; one re-ask on violation, then fall back to a
deterministic plan (shortlist head, LRU shape, band midpoint, generic premise request) so the
pipeline never stalls on a chatty model.

### 7.3 Step 2 — builder

Input: the plan, the §8.4 value contract (signatures outside its grammar are schema-rejected),
counts (3–4 public tests, 8–12 private tests including edge cases), hint-ladder rubric,
par-time guidance, difficulty rubric (§6.3).

Output (JSON-schema-validated): `title, statement_md, signature, starter_code, public_tests,
private_tests, hints[4], reference_solution, input_generator, complexity {time, space},
par_minutes` — where `input_generator` is a pure `generate(seed) -> inputs` function producing
small random valid inputs (small enough for a naive solution). The generator only produces
*inputs*; it can never bias an expected output (see §7.4 gate 3).

**Oracle call (amendment 32):** after the build, a *separate* CLI call receives **only the
statement and signature** — not the reference solution, not the tests, not the builder
conversation — and returns `brute_solution`, a deliberately naive but obviously-correct
implementation. Independence is the point: a wrong expected output now requires the same
mistake to be made twice, from the statement alone.

### 7.4 Verification — independent-oracle differential (amendments 24, 32, 33)

`verify.py` runs everything in the **same judge image** users get, but under its own wall clock
— `VERIFY_WALL`, default 300 s (amendment 33: fifty random cases × two solutions with a 10 s
oracle cap cannot fit an interactive timeout, and nobody is waiting on verification). Three
gates, all mandatory:

1. **Reference vs authored tests** — the reference solution must pass 100% of public + private
   tests (2 s per test).
2. **Oracle vs authored tests** — the independently-generated brute oracle must pass them too
   (10 s per test — naive is fine; the generator keeps inputs small).
3. **Three-way agreement** — on every authored input, builder-expected = reference = oracle; on
   50 seeded random inputs from `input_generator`, reference = oracle. The **agreed value** is
   what gets stored as the expected output — no single artifact's claim is ever trusted alone.
   Any disagreement, crash, or timeout fails the gate.

A failure at any gate produces a repair prompt containing the disagreeing cases and observed
outputs; bounded loop per §7.1. A wrong expected output can now only survive if two solutions
written from the statement alone, in separate calls, share the same bug on the same input. The
residual risk — a genuinely ambiguous *statement* misread the same way twice — is accepted and
mitigated by the statement-clarity instructions in both prompts. A problem that never verifies
is never seen by a user.

### 7.5 LLM CLI adapter

`llm.py` exposes `async def complete(prompt: str, schema: type[BaseModel]) -> BaseModel`:

- Spawns the configured CLI via `asyncio.create_subprocess_exec`, prompt on stdin/argv.
- `LLM_CLI=claude` (default): `claude -p --output-format json --model claude-sonnet-5`;
  the adapter unwraps the CLI's JSON envelope, then parses the model's JSON body.
- `LLM_CLI=codex`: `codex exec …` with the equivalent parse.
- Exact argv templates are config (`LLM_ARGS`), so flags can change without code.
- Hard timeout (`LLM_TIMEOUT_S`, default 600), one retry on parse failure with the validation
  error appended.
- **Containment (amendments 37, 40):** every invocation runs with the CLI's agent tools hard-
  disabled (exact flags live in `LLM_ARGS`), cwd set to a fresh empty temp dir per call, and a
  **sanitized allowlist environment** — only what the CLI needs to run and authenticate
  (`PATH`, `HOME`, terminal basics); server secrets (`DATABASE_URL`, `SUPABASE_JWT_SECRET`, …)
  are never in the child env. Honesty note: cwd + a read-only sandbox alone would not stop
  absolute-path reads, which is why the no-tools config and env sanitization are the real
  controls; `LLM_CONTAINER=1` optionally wraps the CLI in its own network-only container (no
  volume mounts beyond the temp dir + CLI auth dir) for a genuine boundary on hosted deploys.
  Defense-in-depth context: no user-controlled text ever enters a generation prompt — the
  profile is numbers and every title/premise in the anti-repetition context is model-authored.
- Tests stub this module with recorded fixture outputs; no live CLI in CI.

## 8. Judge

### 8.1 Sandbox

One image, `leetmind-judge` (`python:3.12-slim` + `judge/runner.py`). Per execution:

```
docker run --rm -i --name exec-{execution_id} \
  --network none --read-only --tmpfs /tmp:size=64m,noexec \
  --memory 256m --memory-swap 256m --cpus 1 --pids-limit 64 \
  --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges \
  leetmind-judge
```

The protocol is a bidirectional stream (amendment 38): the handshake on stdin carries user code
+ signature + per-test limit, then the server writes **one test input at a time** and reads one
result line back before sending the next — expected outputs never enter the container, and
neither does any input that hasn't run yet. Results are capped at 1 MB total, then truncated. The server side (`judge.py`) wraps the
subprocess in `asyncio.wait_for` (interactive wall 60 s; verification uses `VERIFY_WALL` per
§7.4) and on expiry runs `docker kill exec-{execution_id}` — the deterministic name guarantees
cleanup kills the right container even if the subprocess handle is gone. No docker SDK — plain
subprocess to the docker CLI.

Throughput guards: a global asyncio semaphore caps concurrent judge containers
(`JUDGE_CONCURRENCY`, default 4; excess executions queue), each user may have at most one
execution in flight (`409` otherwise), and submitted code is capped at 64 KB. These guards are
process-local, which is fine because v1 **mandates a single server process**
(`uvicorn --workers 1`, amendment 35); scaling out requires making them database-backed first
(§15).

### 8.2 In-container executor, server-side comparator (amendments 23, 34)

Two principles. First, user code never shares a process with anything that must survive it.
Second — the stronger one — **no secret ever enters the container**: expected outputs,
public/private labels, and verdict logic live only in the server-side comparator (`judge.py`),
so there is nothing inside the sandbox to steal, and sabotaging the sandbox from within is
self-harm, not escape.

- The container runs `runner.py` as a dumb **executor**. The handshake gives it user code, the
  function signature, and the per-test limit; after that it reads **one test input at a time**
  from stdin and answers each with one result line on stdout —
  `{value | error + truncated traceback | timeout, printed (4 KB cap), duration_ms}` — before
  the next input is sent. No expected outputs, no labels, and no future inputs ever exist
  in-container (amendment 38): there is nothing to steal even mid-run.
- Per test, the executor spawns a **fresh child interpreter in its own session/process group**
  (`setsid`). The child loads the user code (exception → `error`), calls the function under
  `redirect_stdout`, and prints its result JSON. Fresh interpreter per test = no state leaks
  between tests.
- The child bootstrap installs a minimal **seccomp-BPF filter** immediately before user code
  runs, denying process creation (`fork`/`vfork`/process-`clone`), `setsid`/`setpgid`,
  `ptrace`, and `kill` — a grandchild that re-`setsid`s out of the group kill can never be
  created, and the executor cannot be signalled (amendment 38). Consequence: user code cannot
  spawn processes or threads; fine for v1 algorithm problems and stated in the workspace.
- The executor enforces the per-test limit with `wait(timeout)`, then **kills the child's whole
  process group**, then sweeps `/proc` and kills any surviving same-UID pid that isn't itself —
  belt and braces under `--pids-limit 64`. An alarm the child cancels is irrelevant; the kill
  comes from outside.
- A child that signals or kills the same-UID executor, or a memory bomb that takes down the
  container, only destroys its own run: the server wall-timeout fires, the container dies by
  name, verdict `error`/`timeout`. Ptrace probing finds nothing, because nothing secret is
  there.
- The server-side **comparator** drives the stream: it sends the next input only after judging
  the previous result (comparison rules per §8.4), assigns `pass | wrong_answer | error |
  timeout`, and at the first private-test failure simply stops sending and kills the container
  (privates are ordered after publics; public failures never stop the stream). The comparator —
  never the container — decides what the client learns.

### 8.3 Verdict semantics

Both actions require the problem to have been opened (`served_at` set) — `409` otherwise
(amendment 41): the timer and access to execution are the same gate.

- **Run**: public tests only. Full per-test detail. Never recorded as a submission.
- **Submit**: public first. Any public failure → the execution is recorded with
  `kind = 'run'` (demotion), response says so, no submission consequences. All public pass →
  `kind = 'submit'`; private suite runs. First private failure → response includes that case's
  input, expected output, and the user's output; submission recorded as failed. All private
  pass → **solved**: the resolution transaction runs under `pg_advisory_xact_lock(user_id)`,
  re-reads the problem `FOR UPDATE` and requires it still `active` (a concurrent duplicate
  resolves to a no-op conflict, and `rating_updates.problem_id UNIQUE` makes double-Elo
  impossible even past a bug), then applies the Elo update (§6.1), marks the problem `solved`,
  promotes the on-deck problem to `active` (its `served_at` stays NULL until the client opens it),
  enqueues the replacement job, and returns the full rating-update breakdown.

### 8.4 The value contract (amendment 39)

The single type system shared by the builder, the judge, and the frontend — the seam where they
could otherwise silently disagree. Lives in `schemas.py`; the builder's output is
schema-rejected if a signature leaves it.

- **Type grammar:** `T ::= int | float | bool | str | T? | T[]` — scalars, a nullable marker,
  and arbitrarily nested lists. Nothing else in v1: no dicts, no tuples, no custom classes.
- **Structures by convention, not by class:** linked lists are value lists (`int[]`); binary
  trees are level-order lists with nulls (`int?[]`); graphs are adjacency lists (`int[][]`) or
  edge lists. The statement must state the representation; the starter code receives plain
  lists. Custom `TreeNode`-style classes are v2.
- **Transport:** the grammar is exactly the JSON-representable subset, so one encoding serves
  the API, the `jsonb` columns, and the executor stream — no custom serialization anywhere.
- **Comparison rules (the comparator's law):** type-strict deep equality — `bool` never equals
  `int`, `1` never equals `"1"`, `None` only equals `None`. Lists are ordered unless the
  signature's return carries `order_insensitive: true` (compared as multisets). Floats compare
  with tolerance `1e-6` (absolute or relative, whichever is looser) and only where the declared
  type is `float` — an `int` return producing `2.0` is a `wrong_answer`, not a rounding case.

## 9. API surface

All under `/api`, JWT-authenticated except `/health`. Pydantic models in `schemas.py` are the
contract, with two problem views: `ProblemView` (unresolved — private tests, unrevealed hints,
and both solutions are not fields of the model, so they cannot leak by construction) and
`ResolvedProblemView` (only produced once status ∈ `solved`/`given_up` — adds the reference
solution, the full hint ladder, and the private tests for post-mortem study). Every
problem-scoped query filters `WHERE id = $1 AND user_id = $auth_user` — a foreign problem id is
a 404, checked in one shared dependency, not per-route.

| Method & path | Purpose / response |
|---|---|
| `GET /health` | liveness: db + docker + worker heartbeat |
| `GET /api/me` | profile: per-type `{slug, name, rating, attempts, evidenced}` |
| `GET /api/practice/next` | **Fully pure read** returning a **stub only** (amendments 36, 41): `{state:'active', problem_id, opened}` — never the statement — or `{state:'generating', job:{status, repair_count}}`, or `{state:'stalled'}` when no problem and no live job exists |
| `POST /api/practice/replenish` | bootstrap + self-heal: under the per-user advisory lock, tops the queue up to the invariant (new user: two probe jobs). Idempotent. The client calls it on first load and whenever `next` reports `stalled` |
| `GET /api/problems/{id}` | requires the problem opened (`409 not_opened` before). `ProblemView` while unresolved: statement, signature, starter code, public tests, revealed hints, complexity. `ResolvedProblemView` after resolution: adds reference solution, full hint ladder, private tests |
| `POST /api/problems/{id}/open` | **atomically** stamps `served_at` on first call **and returns the `ProblemView`** — the statement is unobtainable any other way pre-open, so the timer and the content are one atom; idempotent afterwards. Prefetching `next` reveals nothing and starts nothing |
| `POST /api/problems/{id}/run` | `{code}` → per-public-test results (sync) |
| `POST /api/problems/{id}/submit` | `{code}` → verdict per §8.3; on solve includes `rating_update` breakdown `{type_slug, rating_before, rating_after, delta, problem_rating, expected_score, performance_score, k_factor, metrics}` |
| `POST /api/problems/{id}/hints/{rung}` | requires the problem opened; reveals rung n (requires 1..n−1 revealed) → hint text; recorded server-side |
| `POST /api/problems/{id}/give-up` | S=0 resolution; returns reference solution + rating_update; promotes + enqueues |
| `GET /api/progress` | rating history per type from `rating_updates` + recent resolved problems |
| `GET /api/events` | SSE: generation job transitions for the authenticated user (`queued/planning/building/verifying/ready/failed`), heartbeat comments every 15 s. Consumed with fetch-based streaming (native `EventSource` cannot send the bearer header) |

CORS: allow the web origin only. Auth: `Authorization: Bearer <supabase JWT>` verified with
`SUPABASE_JWT_SECRET` (HS256, `aud=authenticated`). The frontend's no-auth single-user mode is
dropped — Supabase is required in both apps.

Request limits: JSON bodies capped at 128 KB, `code` fields at 64 KB, one in-flight execution
per user (409 on a second concurrent run/submit).

## 10. Contract codegen

- `apps/server`: `python -m leetmind.openapi > openapi.json` (offline app-factory dump, no
  running server needed).
- Root script `pnpm gen:api`: runs the dump, then `openapi-typescript openapi.json -o
  apps/web/src/shared/api-types.d.ts`.
- The frontend's hand-written zod contract in `src/shared/` is deleted; `src/lib/api.ts` becomes
  a thin typed fetch wrapper over the generated types. CI runs `gen:api` and fails on diff, so
  the checked-in types can't drift from the server.

## 11. Frontend rewiring (seam only)

- Move the app to `apps/web`; root becomes the pnpm workspace.
- Replace `src/shared/*` with generated types; rewrite `src/lib/api.ts` against §9.
- Point the SSE hook at `/api/events` with the new event payload, reimplemented over fetch
  streaming (not native `EventSource`, which can't send the Authorization header).
- Call `POST /api/practice/replenish` on first load and on a `stalled` state from `next`.
- Fetch problem content via `POST /api/problems/{id}/open` when the workspace mounts: `next`
  only supplies the stub id; `open` returns the content and starts the timer atomically.
- Drop the C++ language toggle (Python only); Monaco stays.
- Run/Submit buttons keep their existing semantics (they already match decision 16).
- Show the `rating_update` breakdown on solve/give-up (the data is in the response; rendering can
  be a minimal panel — no redesign).
- Fix whatever else `tsc` flags. No visual or UX redesign.

## 12. Testing

| Layer | Approach |
|---|---|
| `elo.py`, `selection.py` | Pure unit tests: update properties (upset asymmetry, penalty caps, K decay), all four invariants I1–I4 as explicit test cases, probe-phase behavior |
| Judge | Real Docker: pass/WA/error/timeout/memory-bomb/fork-bomb/network-attempt fixtures; output-cap truncation; kill-by-name on wall timeout; §8.4 comparison-rule fixtures (bool-vs-int, float tolerance, order-insensitive, nullable trees); **escape attempts** (cancel the alarm; attempt `fork`/`clone`/`setsid`/`ptrace`/`kill` — denied by seccomp; monkeypatch builtins) must yield plain `error`/`timeout` verdicts; the streamed protocol never has a future input in-container to leak |
| Worker + pipeline | Real scratch Postgres (compose), stubbed `llm.py` fixtures: full job lifecycle, repair loop, planner-violation fallback, lease reclaim after simulated crash, **fencing** (a stale lease token cannot write), resume-from-`plan_json`, two queued jobs for one user never plan concurrently, differential verify catches a seeded wrong-expected-output fixture, queue invariant |
| API | httpx against the app with real Postgres: auth + ownership 404s, practice next/replenish flows, `open` atomicity (statement unavailable and run/submit 409 before it, idempotent after), run/submit/demotion/reveal, hint gating, give-up, response models never leak private fields; **races**: concurrent submits produce exactly one `rating_update`, concurrent replenishes produce no duplicate jobs, `GET practice/next` performs no writes |
| E2E | Existing Playwright smoke re-pointed at the new stack (real server, stubbed LLM via fixture mode flag) |

## 13. Tunables (single module, expected to change)

`DEFAULT_RATING=1200 · K=(40,24,16) @ (<5,<15,≥15) attempts · S_floor=0.30 · hint/submit/run/time
penalty table §6.1 · probe_rating=1000 · band=(−50,+150) · shortlist=3 · repetition window=8 ·
staleness=14d · support threshold=max(t+100,1300) · public=3–4 · private=8–12 · repair_max=3 ·
per-test 2s (oracle 10s) · interactive wall 60s · verify wall 300s · mem 256m ·
random diff cases=50 · float tol=1e-6 · judge concurrency=4 ·
code max=64 KB · body max=128 KB · LLM timeout 600s · heartbeat 60s / lease stale 5 min`

## 14. Implementation phases

Each phase lands green (typecheck + tests) before the next starts.

- **Phase 0 — restructure & scaffold.** Commit the pending backend deletion. Move frontend to
  `apps/web`, root workspace. Scaffold `apps/server` (uv, FastAPI, config, asyncpg pool,
  migration runner, `0001_init.sql` with schema + taxonomy seed), auth dependency, `/health`,
  compose file. *Accept:* web dev server runs from new location; `GET /health` green against
  Supabase; migrations idempotent.
- **Phase 1 — judge.** Image, streamed executor protocol + child seccomp filter, server-side
  comparator with the §8.4 comparison rules, sandbox flags, concurrency semaphore,
  named-container cleanup. *Accept:* full judge matrix — including the escape-attempt and
  §8.4 fixtures — passes against real Docker.
- **Phase 2 — learner model.** `elo.py`, `selection.py`, `ratings` lazy-init, `/api/me`.
  *Accept:* unit suite incl. I1–I4 green.
- **Phase 3 — generation pipeline.** `llm.py` (tools-off, temp-dir cwd) + prompts +
  `planner.py`/`builder.py`/`verify.py` (input generator + separate oracle call), worker loop
  with fenced leases, heartbeats, and per-user claim serialization, jobs, `/api/events` SSE.
  *Accept:* stubbed-CLI lifecycle + fencing + serialization tests green; one live manual
  end-to-end generation produces a differentially-verified problem.
- **Phase 4 — practice API.** `practice/next` + `replenish` + `open`, problem views,
  run/submit/hints/give-up/progress, resolution transaction with advisory locking. *Accept:*
  API integration suite green, incl. no-leak model tests and the race tests.
- **Phase 5 — contract & frontend.** OpenAPI dump, codegen, delete zod contract, rewrite client
  + SSE hook, drop C++, breakdown panel, re-point Playwright smoke. *Accept:* `tsc` clean,
  smoke green against the real stack.

## 15. Out of scope (v1)

Hosting/TLS/domains · C++ or additional languages · rating decay over time · admin/review UI ·
observability beyond structured logs + `/health` · multi-device concurrency guarantees beyond
last-write-wins · empirical difficulty recalibration from aggregate outcomes (§6.3) ·
multi-process / horizontal scaling (v1 guards are process-local by design; DB-backed guards
come first, amendment 35) · the frontend UX redesign.
