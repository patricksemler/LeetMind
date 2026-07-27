# LeetMind — Implementation Contracts (normative)

This document is **normative for all implementation work**. `PLAN.md` says _what_ and _why_;
this document says _exactly which names, shapes, and files_. When implementing, do not invent
alternative names for anything defined here. If something is genuinely missing, implement the
smallest thing consistent with the conventions below and note it in your report.

---

## 0. Repo layout

```
LeetMind/
  package.json                 # pnpm workspace root, scripts only
  pnpm-workspace.yaml
  tsconfig.base.json
  .env.example
  .gitignore
  docker-compose.yml
  docker-compose.metrics.yml   # M5 profile
  apps/
    web/                       # React + Vite + Monaco + Tailwind
    api/                       # Fastify HTTP + SSE
    judge/                     # judge coordinator + sandbox workers
  packages/
    shared/                    # @leetmind/shared  — types, zod schemas, logger, config, ids
    db/                        # @leetmind/db      — pg pool, migration runner, migrations/, seeds/
    queue/                     # @leetmind/queue   — Postgres job queue (TS side)
    sandbox/                   # @leetmind/sandbox — docker run wrapper
    learner/                   # @leetmind/learner — Glicko-lite engine, SM-2, outcome scoring (pure)
  content/                     # Python (uv) content plane
    pyproject.toml
    leetmind_content/
      config.py logging.py db.py queue.py models.py
      harness/                 # harness codegen + runner bundles
      generation/              # claude -p invoker, prompts
      verification/            # six-stage gate
      workers/                 # generate/verify worker entrypoints, replenishment
    tests/
  docker/
    runner-python/Dockerfile
    runner-cpp/Dockerfile
    api.Dockerfile judge.Dockerfile web.Dockerfile content.Dockerfile
  docs/
  scripts/
```

TypeScript packages are ESM (`"type": "module"`), target ES2022, `moduleResolution: "bundler"`
for web and `"nodenext"`+`"module": "nodenext"` for node packages. Node packages import each other
by package name (`@leetmind/shared`), resolved through pnpm workspace links, and are consumed as
**TypeScript source via `tsx` in dev**; each package also has a `build` script (`tsc -p .`) emitting
to `dist/`. Package `exports` point at `./src/index.ts` under the `"development"` condition and
`./dist/index.js` otherwise; keep it simple — a plain `"main": "src/index.ts"` plus `tsx`/`tsc`
is acceptable and preferred over clever conditional exports.

**Resolution rule (decided during M0 integration):** workspace packages resolve to **TypeScript
source**, not `dist/`. Every package's `exports` map is
`{ ".": { "types": "./src/index.ts", "default": "./src/index.ts" } }`.
Rationale: a `"default": "./dist/index.js"` condition makes every consumer depend on build order
and fails confusingly against a stale or absent `dist/`. Services run under `tsx`, which compiles
workspace TS directly, and `tsc --noEmit` type-checks through the same path. `build` scripts still
exist and must keep working, but nothing at dev or test time may depend on their output.

---

## 1. Conventions

- **IDs**: ULID strings everywhere (`ulid` on npm, `python-ulid` in Python). Column type `text`.
- **Time**: `timestamptz`, always UTC. Durations in **ms** as integers unless a column name says otherwise.
- **Correlation IDs**: every inbound HTTP request gets `correlation_id` (from `x-correlation-id`
  header or a fresh ULID). It is propagated request → job row → execution → learning event, and
  appears in **every** structured log line. TS: `AsyncLocalStorage` in `@leetmind/shared`.
  Python: `contextvars`.
- **Logging**: single-line JSON to stdout. Required fields:
  `ts, level, service, msg, correlation_id?, job_id?, submission_id?, worker_id?`.
  TS uses `pino`; Python uses `structlog` configured for JSON. No `console.log` / `print` in
  service code.
- **Errors**: TS `AppError` in shared with `code`, `httpStatus`, `details`. API returns
  `{ error: { code, message, details? }, correlation_id }`.
- **Config**: parsed once at startup with zod (TS) / pydantic-settings (Python). Missing required
  env vars must fail loudly at boot, never at first use.
- **Money/rating numbers**: ratings are `double precision`, displayed rounded.
- **No secrets in sandbox images.** Ever.

### Single-user mode

No auth in v1. `SINGLE_USER_ID` env (default ULID seeded by migration:
`00000000000000000000000001`, handle `local`). Every user-owned table still carries `user_id`.
API resolves the current user from config, not from the request.

---

## 2. Environment variables (`.env.example` must list all of these)

| Var                            | Default                                                | Used by                                 |
| ------------------------------ | ------------------------------------------------------ | --------------------------------------- |
| `DATABASE_URL`                 | `postgres://leetmind:leetmind@localhost:5432/leetmind` | all                                     |
| `PGPOOL_MAX`                   | `10`                                                   | all                                     |
| `LOG_LEVEL`                    | `info`                                                 | all                                     |
| `NODE_ENV`                     | `development`                                          | ts                                      |
| `API_PORT`                     | `8080`                                                 | api                                     |
| `API_HOST`                     | `0.0.0.0`                                              | api                                     |
| `WEB_PORT`                     | `5173`                                                 | web                                     |
| `VITE_API_BASE`                | `http://localhost:8080`                                | web                                     |
| `SINGLE_USER_ID`               | `00000000000000000000000001`                           | api, judge, content                     |
| `JUDGE_WORKER_ID`              | hostname+pid                                           | judge                                   |
| `JUDGE_CONCURRENCY`            | `2`                                                    | judge                                   |
| `QUEUE_LEASE_SECONDS`          | `30`                                                   | queue                                   |
| `QUEUE_HEARTBEAT_MS`           | `10000`                                                | queue                                   |
| `QUEUE_REAPER_INTERVAL_MS`     | `5000`                                                 | queue                                   |
| `QUEUE_POLL_INTERVAL_MS`       | `500`                                                  | queue                                   |
| `SANDBOX_PYTHON_IMAGE`         | `leetmind/runner-python:1`                             | judge, content                          |
| `SANDBOX_CPP_IMAGE`            | `leetmind/runner-cpp:1`                                | judge                                   |
| `SANDBOX_MEMORY_MB`            | `256`                                                  | sandbox                                 |
| `SANDBOX_CPUS`                 | `1.0`                                                  | sandbox                                 |
| `SANDBOX_PIDS_LIMIT`           | `64`                                                   | sandbox                                 |
| `SANDBOX_WALL_TIMEOUT_MS`      | `10000`                                                | sandbox                                 |
| `SANDBOX_OUTPUT_LIMIT_BYTES`   | `65536`                                                | sandbox                                 |
| `SANDBOX_WORK_DIR`             | `/tmp/leetmind-sandbox`                                | sandbox                                 |
| `DOCKER_BIN`                   | `docker`                                               | sandbox                                 |
| `CONTENT_WORKER_ID`            | hostname+pid                                           | content                                 |
| `GENERATOR_INVOKER`            | `claude`                                               | content (`claude` \| `codex` \| `stub`) |
| `CLAUDE_BIN`                   | `claude`                                               | content                                 |
| `GENERATOR_TIMEOUT_MS`         | `600000`                                               | content                                 |
| `GENERATOR_MAX_SCHEMA_RETRIES` | `2`                                                    | content                                 |
| `BUFFER_LOW_WATERMARK`         | `3`                                                    | content                                 |
| `REPLENISH_INTERVAL_MS`        | `60000`                                                | content                                 |
| `VERIFY_DIFFERENTIAL_CASES`    | `200`                                                  | content                                 |

---

## 3. Database schema (authoritative DDL summary)

Migrations live in `packages/db/migrations/NNN_name.sql`, applied in lexical order by a custom
runner (`packages/db/src/migrate.ts`, `pnpm db:migrate`) against a `schema_migrations(version text
primary key, applied_at timestamptz)` table, each file in its own transaction. **No ORM.** Plain
SQL + `pg`.

Tables and their columns (types are Postgres; `not null` unless marked `?`):

- **users**: `id pk`, `handle unique`, `auth_user_id text unique?` (Supabase Auth subject; null on
  the legacy pre-accounts row until claimed), `email text?`, `created_at`,
  `settings jsonb default '{}'`
- **concepts**: `id pk` (slug), `name`, `description default ''`, `misconceptions jsonb default '[]'`,
  `min_rating int default 800`, `max_rating int default 2400`, `sort_order int default 0`
- **concept_edges**: `parent_id fk concepts`, `child_id fk concepts`, pk(parent,child)
- **user_concept_state**: pk(`user_id`,`concept_id`); `rating double precision default 1200`,
  `uncertainty double precision default 350`, `attempts int`, `solves int`, `unassisted_solves int`,
  `skips int`, `current_streak int`, `best_streak int`, `total_active_ms bigint`,
  `hint_counts jsonb default '{}'`, `error_counts jsonb default '{}'`, `last_practiced_at?`,
  `next_review_at?`, `review_interval_days double precision default 1`,
  `review_ease double precision default 2.5`, `review_reps int default 0`,
  `mastered_at?` (set once when all five mastery clauses first hold, **never cleared** — see §8
  "Explicit mastery"), `updated_at`
- **problems**: `id pk`, `internal_name`, `created_at`, `retired_at?`
- **problem_versions**: `id pk`, `problem_id fk`, `version int`, `state`
  (`candidate|verifying|approved|rejected|retired`), `content jsonb` (the **full** ProblemVersion,
  including server-only fields), `title`, `difficulty_rating int`,
  `difficulty_confidence default 'generated'`, `expected_min_minutes int?`,
  `expected_max_minutes int?`, `comparator default 'exact'`, `provenance jsonb default '{}'`,
  `rejected_reason?`, `created_at`, `approved_at?`; unique(`problem_id`,`version`);
  index on (`state`,`difficulty_rating`)
  `problem_versions` also carries `shape?` — what the problem asks the solver to PRODUCE
  (`find_pair|count_occurrences|find_extremum|check_property|build_output|in_place_transform|`
  `simulate_process|partition_group|path_or_order|optimize_value`), orthogonal to the concept that
  solves it. Null for anything approved before 007; selection must degrade, never assume.
- **problem_concepts**: `problem_version_id fk cascade`, `concept_id fk`, `role`
  (`primary|secondary`), `weight double precision`; pk(version,concept)
- **verification_reports**: `id pk`, `problem_version_id fk cascade`, `passed bool`, `failed_stage?`,
  `stages jsonb`, `seeds jsonb default '[]'`, `counterexample jsonb?`,
  `solution_hashes jsonb default '{}'`, `duration_ms int?`, `correlation_id?`, `created_at`
- **submissions**: `id pk`, `user_id fk`, `problem_version_id fk`, `baseline_item_id?` (legacy;
  never written since 007), `mode` (`run|submit|transcribe`), `language` (`python|cpp`), `source`,
  `source_hash`, `status` (`created|queued|assigned|compiling|running|completed|cancelled`),
  `verdict?`, `passed_tests int default 0`, `total_tests int default 0`, `runtime_ms int?`,
  `memory_kb int?`, `failure jsonb?`, `public_results jsonb?` (per-public-test outcomes),
  `active_ms int?`, `paste_detected bool default false` (transcribe only; advisory, never a gate),
  `custom_input jsonb?` (legacy; never written), `idempotency_key text unique?`,
  `correlation_id?`, `created_at`, `completed_at?`
- **execution_attempts**: `id pk`, `submission_id fk cascade`, `attempt int`, `worker_id`,
  `image_digest?`, `language_version?`, `flags?`, `limits jsonb`, `usage jsonb?`, `per_test jsonb?`,
  `exit_code int?`, `started_at`, `finished_at?`
- **hint_events**: `id pk`, `user_id fk`, `problem_version_id fk`, `level`
  (`l1_orientation|l2_conceptual|l3_structural|outline|editorial`), `created_at`;
  unique(user,version,level)
- **learning_events**: `id pk`, `user_id fk`, `problem_version_id?`, `submission_id?`, `kind`
  (`submission|skip|give_up|diagnostic|review|decay`), `outcome double precision`, `evidence jsonb`,
  `before_state jsonb`, `after_state jsonb`, `idempotency_key text unique?`, `correlation_id?`,
  `created_at`
- **scheduled_followups**: `id pk`, `user_id fk`, `concept_id fk`,
  `origin_problem_version_id fk`, `kind` (`reinforce|transfer`), `origin_trigger`
  (`editorial_revealed|consecutive_failures`), `target_rating int`, `shape_match` (`same|different`),
  `origin_shape?`, `rationale default ''`, `due_at`, `served_problem_version_id?`, `served_at?`,
  `satisfied_at?`, `created_at`; unique(`user_id`,`origin_problem_version_id`,`kind`).
  The debts owed after a teaching episode — see §8 "Teaching mode".
- **baseline_sessions** / **baseline_items**: RETAINED AS READ-ONLY HISTORY. The baseline product
  surface was removed in 007 (see §8 "Cold start"); nothing writes these tables any more, but
  `submissions.baseline_item_id` and historical `learning_events` still reference them, so they are
  not dropped. Columns unchanged from 003/005.
- **model_runs**: `id pk`, `kind` (`generate|repair`), `invoker`, `model?`, `prompt_version`,
  `request jsonb`, `duration_ms int?`, `output_hash?`, `input_tokens int?`, `output_tokens int?`,
  `cost_usd double precision?`, `problem_version_id?`, `status` (`ok|schema_error|invoke_error`),
  `error?`, `correlation_id?`, `created_at`
- **jobs**: `id pk`, `kind`, `priority int default 100`, `payload jsonb`, `status default 'queued'`
  (`queued|leased|done|failed|dead|cancelled`), `attempts int default 0`,
  `max_attempts int default 3`, `run_at timestamptz default now()`, `lease_expires_at?`,
  `leased_by?`, `last_error?`, `idempotency_key text unique?`, `correlation_id?`, `created_at`,
  `updated_at`; index (`status`,`kind`,`priority`,`run_at`), index (`status`,`lease_expires_at`)
- **worker_heartbeats**: `worker_id pk`, `kind`, `last_seen_at`, `meta jsonb default '{}'`

Migration files:

- `001_init.sql` — everything above.
- `002_seed_taxonomy.sql` — concepts + edges + the single local user (idempotent `on conflict do nothing`).

### Concept taxonomy seed (ids are fixed — other code references them)

`arrays_hashing`, `two_pointers`, `sliding_window`, `stacks_queues`, `binary_search`,
`linked_list`, `trees_bst`, `heaps_pq`, `tries`, `graph_traversal`, `graph_structure`,
`shortest_paths`, `backtracking`, `dp_1d`, `dp_2d`, `greedy`, `intervals`, `bit_manipulation`,
`math_geometry`, `sorting`.

Edges (parent → child) per PLAN §4:
`arrays_hashing→two_pointers`, `two_pointers→sliding_window`, `sliding_window→stacks_queues`,
`arrays_hashing→binary_search`, `arrays_hashing→sorting`, `arrays_hashing→trees_bst`,
`linked_list→trees_bst`, `trees_bst→heaps_pq`, `trees_bst→tries`, `trees_bst→graph_traversal`,
`graph_traversal→graph_structure`, `graph_structure→shortest_paths`,
`graph_traversal→backtracking`, `backtracking→dp_1d`, `dp_1d→dp_2d`, `arrays_hashing→greedy`,
`sorting→intervals`, `arrays_hashing→bit_manipulation`, `arrays_hashing→math_geometry`,
`arrays_hashing→linked_list`.

---

## 4. `@leetmind/shared` — the type surface

Everything in this section is **exported from `packages/shared/src/index.ts`** and defined with
**zod**; TypeScript types are `z.infer` of the schemas. Python mirrors these as pydantic models in
`content/leetmind_content/models.py` with **identical field names**.

### 4.1 Signature / type system

```ts
type ParamType =
  | "int"
  | "float"
  | "bool"
  | "str"
  | `list[${string}]` // nested, e.g. "list[list[int]]"
  | "TreeNode"
  | "ListNode" // M3
  | "TreeNode?"
  | "ListNode?"; // nullable roots
export const SignatureSchema = z.object({
  name: z.string(), // camelCase function name
  params: z.array(z.object({ name: z.string(), type: ParamTypeSchema })),
  returns: ParamTypeSchema,
});
```

Encodings (JSON, both directions, identical in TS and Python):

- `TreeNode` → level-order array with `null` holes, LeetCode style: `[1,2,3,null,null,4,5]`
- `ListNode` → plain array: `[1,2,3]`
- everything else → the obvious JSON

### 4.2 ProblemVersion

```ts
export const ProblemVersionSchema = z.object({
  problem_id: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  internal_name: z.string(),
  statement_md: z.string(),
  constraints_md: z.string(),
  signature: SignatureSchema,
  examples: z
    .array(z.object({ args: z.array(z.unknown()), expected: z.unknown(), explanation: z.string() }))
    .min(1),
  concepts: z
    .array(
      z.object({
        id: z.string(),
        role: z.enum(["primary", "secondary"]),
        weight: z.number().min(0).max(1),
      }),
    )
    .min(1),
  difficulty: z.object({
    rating: z.number().int(),
    confidence: z.enum(["generated", "verified", "calibrated"]),
  }),
  expected_active_minutes: z.tuple([z.number().int(), z.number().int()]),
  target_complexity: z.object({ time: z.string(), space: z.string() }),
  reference_solution_py: z.string(),
  brute_force_py: z.string(),
  input_generator_py: z.string(),
  comparator: z.enum(["exact", "float_tol", "unordered", "checker_py"]),
  checker_py: z.string().optional(),
  hidden_tests: z.array(TestCaseSchema).default([]), // SERVER ONLY
  mutants_py: z.array(z.string()).default([]), // SERVER ONLY
  hints: z.object({
    l1_orientation: z.string(),
    l2_conceptual: z.string(),
    l3_structural: z.string(),
    outline: z.string(),
    editorial_md: z.string(),
  }),
  provenance: z.object({
    mode: z.enum(["novel", "template", "composed"]),
    model: z.string(),
    prompt_version: z.string(),
    generated_at: z.string(),
  }),
  state: z.enum(["candidate", "verifying", "approved", "rejected", "retired"]),
});

export const TestCaseSchema = z.object({
  args: z.array(z.unknown()),
  expected: z.unknown(),
  origin: z.enum(["example", "random", "boundary", "adversarial"]),
  seed: z.number().int().optional(),
});
```

**`PublicProblem`** is the ONLY problem shape the API may serialize to a client:
`{ problem_version_id, problem_id, version, title, statement_md, constraints_md, signature,
   examples, difficulty_rating, expected_active_minutes, target_complexity: {time, space},
   comparator, starter_code: {python, cpp},
   hint_levels_available: string[], concepts_revealed: null | Concept[] }`
`target_complexity` is public **before** the solve — it's shown in the statement as the bar to aim
for, and states how good a solution must be without hinting at what achieves it.
`concepts_revealed` is `null` until the user solves or gives up. There is a single exported
function `toPublicProblem(row)` in `@leetmind/shared` and **nothing else may build this object.**

### 4.3 Verdicts and statuses

```ts
export const Verdict = z.enum([
  "accepted",
  "wrong_answer",
  "compilation_error",
  "runtime_error",
  "time_limit",
  "memory_limit",
  "output_limit",
  "internal_error",
  "cancelled",
]);
export const SubmissionStatus = z.enum([
  "created",
  "queued",
  "assigned",
  "compiling",
  "running",
  "completed",
  "cancelled",
]);
export const Language = z.enum(["python", "cpp"]);
```

### 4.4 Job kinds, payloads, priorities

```ts
export const JobKind = z.enum(["judge", "verify", "generate"]);
export const JOB_PRIORITY = { judge: 10, verify: 50, generate: 100 } as const; // lower = sooner
```

Payloads:

- `judge`: `{ submission_id, mode: 'run'|'submit', language, problem_version_id, user_id }`
- `verify`: `{ problem_version_id, correlation_id }`
- `generate`: `{ request: GenerationRequest, correlation_id }`

`GenerationRequest`:

```ts
{ concepts: [{id, weight}], target_rating: number, rating_tolerance: number,
  expected_minutes: [number, number], target_complexity?: {time, space},
  required_patterns: string[], forbidden_patterns: string[],
  similarity_exclusions: string[],       // recent titles / mechanic summaries
  comparator_hint?: string, allow_types: string[], prompt_version: string }
```

Idempotency keys:

- judge job: `judge:<submission_id>`
- verify job: `verify:<problem_version_id>`
- generate job: `generate:<concept_key>:<rating_band>:<slot_index>`
- learning event: `le:<submission_id>` / `le:skip:<baseline_item_id>` / `le:diag:<baseline_item_id>`
  (the two baseline forms are legacy — no new events of those kinds are written since 007)

### 4.5 SSE events

Endpoint `GET /api/submissions/:id/events` (text/event-stream). Named events:

| event      | data                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `status`   | `{ submission_id, status, at }`                                                                                                        |
| `progress` | `{ submission_id, passed, total }`                                                                                                     |
| `verdict`  | `{ submission_id, verdict, passed_tests, total_tests, runtime_ms, memory_kb, failure? }`                                               |
| `mastery`  | `{ submission_id, changes: [{concept_id, before_rating, after_rating, before_uncertainty, after_uncertainty}], outcome, explanation }` |
| `ping`     | `{ at }` every 15s                                                                                                                     |

Transport: Postgres `LISTEN/NOTIFY` on channel **`leetmind_events`**. Notify payload must stay
under 7900 bytes and has shape `{ type, submission_id?, user_id?, ...small fields }`. The API holds
one dedicated `pg` client for `LISTEN` and fans out in-process. Judge/content workers emit via
`select pg_notify('leetmind_events', $1)` **inside the same transaction** as the state write.

**Post-solve reveal (added after M1 — the web build found no defined channel for it).** On an
`accepted` submit, the client needs the editorial and target complexity, which until then were
server-only. Do NOT smuggle these through `failure` (a verdict is not a failure). The `verdict`
event and `GET /api/submissions/:id` both carry an explicit optional field:

```ts
reveal?: {
  editorial_md: string,
  target_complexity: { time: string, space: string },
  concepts: { id: string, name: string, role: string, weight: number }[],
}
```

`reveal` is present **only** when the user has earned it — an accepted submission for that problem
version, or a recorded give-up. It is absent on every other response. The same allowlist discipline
as `toPublicProblem` applies: build it in one place and never spread the raw content object.

**Run vs submit differ only in which tests execute.**

| mode     | tests                                                                        |
| -------- | ---------------------------------------------------------------------------- |
| `run`    | the problem's public `examples`, exactly as printed in the statement         |
| `submit` | those same public examples **plus** `hidden_tests`, deduped by argument list |

Submit is a strict superset on purpose: "solved" must mean the solution satisfied everything the
user can see _and_ everything they cannot, and the reported totals have to make that visible. A
`run` never marks a problem solved and never writes a mastery event, however many examples pass.

Public tests are ordered first, so `first_failing_test_index` names a case the user can read
whenever an example is what broke.

User-supplied `custom_input` was removed. `submissions.custom_input` remains on the table for
historical rows; new submissions never set it. The sandbox harness keeps its no-`expected`
capability (`status: 'completed'`, excluded from `passed_tests`/`total_tests`) — the verification
gate relies on it — but the app no longer produces such a test.

**`POST /api/hints` rejects `level: 'editorial'` with 400.** The editorial is reachable only through
`POST /api/problems/:versionId/give-up` (which records the `editorial` hint event itself) or by
solving. This keeps the give-up mastery consequence impossible to bypass by requesting the hint
level directly.

`failure` (safe diagnostics only — never leaks hidden expected values):
`{ kind, message, first_failing_test_index?, stderr_tail?, input_preview?, expected_preview?, actual_preview?, tests? }`

`submissions.public_results` (migration 006) carries the per-test outcome of every PUBLIC test, in
statement order: `[{ index, status, passed, actual? }]`. It is projected on `GET /api/submissions/:id`
and the SSE `verdict` event without sanitization, because it is public by construction — the judge
(`publicResults`) filters on test origin before building it. The workspace renders one case per
public example and marks each ✓/✗ from this array.

`tests` is `{ public_passed, public_total, hidden_passed, hidden_total }` — the pass counts split by
whether the user can see the test. `4/5` alone does not say whether the missing case is an example
on the page or a hidden one; the split does.

Preview fields are gated on the failing **test**, not on the mode. A public example's input and
expected output are printed in the problem statement, so withholding them on a submit-mode failure
hides nothing and leaves the user unable to tell which example broke — they are kept. A hidden
test's are stripped, at three independent layers (sandbox `previewFields`, the API's
`sanitizeFailure`, and the web `ResultsPanel`), each of which must positively establish the test is
public rather than assume it.
where the `*_preview` fields are populated **only** for `run` mode and for example-derived tests.

---

## 5. `@leetmind/queue` — Postgres job queue

Exported API:

```ts
class Queue {
  constructor(pool: Pool, opts?: { leaseSeconds?; workerId? });
  enqueue(
    client: PoolClient | Pool,
    job: { kind; payload; priority?; maxAttempts?; runAt?; idempotencyKey?; correlationId? },
  ): Promise<Job | null>; // null when key collided
  claim(kinds: JobKind[], workerId: string): Promise<Job | null>;
  heartbeat(jobId: string, workerId: string): Promise<boolean>; // false ⇒ lease lost, abort work
  ack(jobId: string, workerId: string): Promise<void>; // → done
  fail(jobId, workerId, error: string, opts?: { retryInMs? }): Promise<"retry" | "dead">;
  reapExpired(): Promise<number>; // requeue expired leases
  stats(): Promise<QueueStats>;
}
export function runWorker(opts: {
  queue;
  kinds;
  concurrency;
  handler;
  logger;
  signal;
}): Promise<void>;
```

Claim SQL (use exactly this shape):

```sql
update jobs set status='leased', attempts=attempts+1, leased_by=$2,
  lease_expires_at=now() + ($3 || ' seconds')::interval, updated_at=now()
where id = (select id from jobs where status='queued' and kind = any($1)
            and run_at <= now() order by priority asc, created_at asc
            for update skip locked limit 1)
returning *;
```

Rules:

- `enqueue` **must** accept a caller-supplied client so it joins the caller's transaction.
- Idempotency-key collision on enqueue → `on conflict (idempotency_key) do nothing`, return `null`.
- `fail` increments nothing (claim already did); when `attempts >= max_attempts` → `status='dead'`.
- Reaper requeues rows with `status='leased' and lease_expires_at < now()`, bumping nothing,
  so recovery is **< 10 s** with the default 30 s lease + 5 s reaper interval + heartbeats.
- Heartbeat returns false if the row is no longer leased by this worker — the handler must abort.
- Every worker upserts `worker_heartbeats` every `QUEUE_HEARTBEAT_MS`.

Python mirror: `content/leetmind_content/queue.py` with the same semantics
(`enqueue`, `claim`, `heartbeat`, `ack`, `fail`, `reap_expired`) using `psycopg` 3.

---

## 6. `@leetmind/sandbox` — execution substrate

```ts
export interface SandboxLimits {
  memoryMb;
  cpus;
  pidsLimit;
  wallTimeoutMs;
  outputLimitBytes;
}
export interface SandboxRequest {
  image: string;
  files: Record<string, string>; // relative path → contents, written into the bundle dir
  argv: string[]; // command inside the container
  limits: SandboxLimits;
  correlationId?: string;
}
export interface SandboxResult {
  exitCode: number | null;
  timedOut: boolean;
  oomKilled: boolean;
  stdout: string;
  stderr: string; // truncated to outputLimitBytes, with `truncated` flags
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  imageDigest: string | null;
  usage: { maxRssKb?: number };
}
export async function runSandboxed(req: SandboxRequest): Promise<SandboxResult>;
export async function resolveImageDigest(image: string): Promise<string | null>;
```

`docker run` flags (mandatory, in this order):

```
--rm --network none --read-only
--tmpfs /work:rw,size=64m,mode=1777,exec
-v <bundleDir>:/bundle:ro
--memory <memoryMb>m --memory-swap <memoryMb>m --cpus <cpus> --pids-limit <pidsLimit>
--cap-drop ALL --security-opt no-new-privileges
-u 65534:65534 -w /work
--label leetmind.sandbox=1
```

Wall timeout is enforced by the **host** (kill the `docker run` child, then `docker kill` by label
as a backstop). Stdout/stderr are capped by the host reader, not by the container.

`resolveImageDigest` shells `docker image inspect --format '{{index .RepoDigests 0}}'` and falls
back to `.Id`. Every `execution_attempts` row records the digest.

**Harness result protocol.** The in-container program prints arbitrary user output first, then a
single sentinel line, then one JSON object:

```
<<<LEETMIND_RESULT>>>
{"ok":true,"tests":[...],"compile":{...}}
```

The host parses the **last** occurrence of the sentinel. Anything before it is user output.
Per-test object:

```json
{"index":0,"status":"passed|failed|error|timeout","time_ms":1.2,"memory_kb":2048,
 "stdout":"...","error":"...","output":<json>}
```

The harness itself never emits `expected` for hidden tests; comparison happens **inside** the
container against the bundled expected values, and only the boolean plus a truncated `output`
comes back.

### 6.1 The sandbox CLI bridge (single implementation rule)

The Python content plane must execute reference/brute-force/mutant code under **exactly** the same
sandbox as user submissions. To guarantee that without a second implementation of the flag list,
`@leetmind/sandbox` ships a CLI and Python shells out to it:

```
node --import tsx packages/sandbox/src/cli.ts exec       # reads SandboxRequest JSON on stdin
                                                          # writes SandboxResult JSON on stdout
node --import tsx packages/sandbox/src/cli.ts exec-python # reads {signature,tests,comparator,
                                                          #        source,limits,image} on stdin
                                                          # writes the normalized execute result
```

Rules: JSON in / JSON out on stdin/stdout only, all logs to **stderr**, exit 0 on a successful
_execution attempt_ (even when the verdict is `wrong_answer`), non-zero only on infrastructure
failure. Python wraps this in `content/leetmind_content/sandbox.py` as
`run_python(signature, tests, comparator, source, limits) -> ExecuteResult`, resolving the repo
root from `LEETMIND_REPO_ROOT` or by walking up for `pnpm-workspace.yaml`.
**Python must never build `docker run` arguments itself.**

Images:

- `docker/runner-python/Dockerfile` — `python:3.12-slim`, no network at runtime, non-root, no pip
  packages beyond stdlib. Tag `leetmind/runner-python:1`.
- `docker/runner-cpp/Dockerfile` — `gcc:14` or `debian:bookworm` + `g++`, compiles with
  `g++ -std=c++20 -O2 -pipe -static-libstdc++`. Tag `leetmind/runner-cpp:1`.
  **Compilation needs its own, larger memory limit than execution** (`MIN_COMPILE_MEMORY_MB = 1024`;
  empirical floor ~768 MB). Measured during M4: `g++ -O2` against the vendored nlohmann/json header
  gets `cc1plus` SIGKILLed by the cgroup at the 256 MB execution limit, and because `--memory-swap`
  is pinned with no swap it surfaces as a **confusing assembler error rather than a clean OOM** —
  it looks like a codegen bug, not a resource limit. Compile and run are separate sandbox
  invocations with independent limits and wall timeouts for exactly this reason.

  **Measured, and the largest single latency cost in the C++ path.** The vendored 898 KB
  `nlohmann/json.hpp` dominates compile time: compiling the real generated bundle takes ~3.5 s,
  while an otherwise-identical translation unit with the header removed compiles in ~148 ms — which
  is itself indistinguishable from bare container startup (~143 ms, measured over 20 iterations
  with the production flag list). So C++ end-to-end latency is _header compilation_, not container
  or cgroup mechanics. Two obvious levers if C++ latency ever matters: bake a precompiled header
  into `leetmind/runner-cpp`, or swap to a lighter JSON parser for the harness. Neither is worth
  doing until someone is actually waiting on it — recorded here so the next person measures before
  optimizing the wrong thing.

- `scripts/build-images.sh` builds both.

---

## 7. Harness codegen

Lives in **Python**: `content/leetmind_content/harness/`. It is used by the content plane directly,
and by the **judge** through a small CLI so there is exactly one implementation:

```
python -m leetmind_content.harness.cli emit --language python --signature-json <path> --out <dir>
```

…but for judge-time simplicity the judge instead writes a **static runner** into the bundle and
passes signature + tests as JSON data files. That is the required design:

**Python bundle layout** (written by judge or content worker):

```
/bundle/runner.py        # static, language-generic driver (checked into packages/sandbox/runners/)
/bundle/signature.json   # Signature
/bundle/tests.json       # [{args, expected}] — expected present, never returned
/bundle/comparator.json  # {kind: 'exact'|'float_tol'|'unordered'|'checker_py', tol?: number}
/bundle/checker.py       # optional
/bundle/solution.py      # the user's (or reference/mutant) code
```

`runner.py` imports `solution.py`, resolves `signature.name`, decodes args (building `TreeNode`/
`ListNode` when the signature says so), runs each test with a per-test time budget, captures user
stdout, encodes the return value back to JSON, compares with the comparator, and emits the
sentinel protocol. It must handle: missing function, exceptions, recursion limit, and per-test
timeouts (via `signal.setitimer` on the main thread).

**C++ bundle (M4)** adds `main.cpp` generated from the signature by
`packages/sandbox/src/cpp/codegen.ts`, type-mapped: `int→long long`, `float→double`, `bool→bool`,
`str→std::string`, `list[T]→std::vector<T>`, `TreeNode→TreeNode*`, `ListNode→ListNode*`.
The bundle holds `solution.cpp` (user code, expected to define the method on `class Solution`),
`main.cpp`, `tests.json`, and a bundled single-header JSON parser at
`packages/sandbox/runners/cpp/json.hpp` (vendored, MIT — nlohmann/json single include).
Compile step runs in the sandbox first (`g++ ... -o /work/prog`), then execution; compile failure
maps to `compilation_error` with the g++ stderr surfaced (path-scrubbed).

---

## 8. `@leetmind/learner` — mastery engine (pure functions, no I/O)

```ts
export function expectedSuccess(userRating: number, problemRating: number): number;
export function blendedRating(
  state: Record<conceptId, { rating; uncertainty }>,
  weights: { id; weight }[],
): { rating; uncertainty };
export function outcomeScore(input: {
  verdict: Verdict | null;
  gaveUp: boolean;
  skipped: "inability" | "preference" | null;
  highestHint: HintLevel | null;
  activeMs: number;
  expectedMinutes: [number, number];
  substantiveSubmissions: number;
  compileErrors: number;
}): { outcome: number; evidenceWeight: number; breakdown: Record<string, number> };
export function updateConcepts(input: {
  states: Record<conceptId, ConceptState>;
  weights: { id; weight }[];
  problemRating: number;
  outcome: number;
  evidenceWeight: number;
}): { changes: ConceptChange[]; explanation: string };
export function scheduleReview(
  state: ConceptState,
  outcome: number,
  now: Date,
): {
  next_review_at: Date;
  review_interval_days: number;
  review_ease: number;
  review_reps: number;
};
export function decayUncertainty(state: ConceptState, now: Date): ConceptState;

// Cold start (src/coldstart.ts) — the first COLD_START_PROBLEM_COUNT problems.
export function nextColdStartStep(
  orderedConcepts: string[],
  history: ColdStartHistoryEntry[],
): { concept_id: string | null; target_rating: number; rationale: string; done: boolean };

// Teaching mode (src/teaching.ts).
export function shouldTeach(recentNewestFirst: TeachingAttempt[]): {
  teach: boolean;
  trigger: "editorial_revealed" | "consecutive_failures" | null;
  reason: string;
};
export function planFollowUps(input: {
  conceptId: string;
  originRating: number;
  now: Date;
}): FollowUpPlan[];

// Explicit mastery (src/mastery.ts).
export function isMastered(input: {
  state: ConceptState;
  band: ConceptBand;
  evidence: MasteryEvidence;
}): {
  mastered: boolean;
  criteria: MasteryCriterion[];
  met: number;
  total: number;
  summary: string;
};
```

Numbers (fixed, do not improvise):

- `expectedSuccess = 1 / (1 + 10 ** ((problemRating - userRating) / 400))`
- Hint caps: `l1 → 0.9`, `l2 → 0.75`, `l3 → 0.6`, `outline → 0.4`, `editorial/give-up → 0.0`
- Base outcome: accepted `1.0`; wrong answer with ≥1 substantive submission `0.15`;
  give-up / abandon `0.0`; skip(inability) `0.0` at `evidenceWeight 0.5`;
  skip(preference) → **no learning event at all**
- Time modifier: `±0.1`, linear — solving under the low band adds `+0.1`, over 2× the high band
  subtracts `0.1`
- Submission-count modifier: `−0.02` per substantive submission beyond the first, floor `−0.08`
- Outcome clamped to `[0, 1]`
- `K = 16 + 32 * (uncertainty − 50) / (350 − 50)` clamped to `[16, 48]`
- Per-problem rating swing capped at `±64` before weight split
- Uncertainty update: `u' = sqrt(1 / (1/u² + evidenceWeight / 180²))`, floor `50`, ceiling `350`
- Inactivity growth: `u' = min(350, sqrt(u² + (daysIdle * 3)²))`
- SM-2: `ease' = clamp(ease + (0.1 − (1 − outcome) * (0.5 + (1 − outcome) * 0.4)), 1.3, 2.8)`;
  `outcome ≥ 0.6` → `interval' = reps === 0 ? 1 : reps === 1 ? 4 : round(interval * ease)`,
  `reps++`; else `interval' = 1, reps = 0`
- Compile-only failures never reach `updateConcepts`; they increment
  `error_counts.compilation` and only produce an event once ≥3 in a rolling problem.
- A `submit` whose failing case is a **public example** never reaches `updateConcepts` either, and
  never enters the attempt history (`listSubmissionsForVersion`): the case is printed in the
  statement and `Run` executes it, so failing it is not evidence about a concept. Such an attempt
  is treated as a run throughout. The predicate is `failedPublicCase` (@leetmind/shared) — keyed on
  `failure.failing_test.origin`, so a failure with no case at all (a compile error) is unaffected
  and keeps the rule above.

**Cold start (no baseline).** There is no onboarding probe and no `needs_baseline` gate: a new
user's first `GET /api/practice/next` returns a problem. For their first `COLD_START_PROBLEM_COUNT`
(6) resolved attempts, difficulty comes from a stepping rule rather than from `scoreCandidate` —
start at `1050` (deliberately below the 1200 seed), `+120` per solve, `−220` per skip or give-up,
clamped to `[800, 2000]`, accumulating across the whole history. One concept per problem, walking
the taxonomy's `sort_order`. The asymmetry is intentional: being handed something far too hard is
what makes someone quit, and `SWING_CAP` (64) makes plain Elo far too slow to recover from a bad
seed. The phase is derived from the learning-event count on every request — there is no session row.

**Teaching mode.** Two triggers, both in `shouldTeach`: the editorial was revealed (give-up), or
`TEACHING_FAILURE_STREAK` (2) consecutive non-solves on one concept. Either way the solution is
shown and the user must submit a `transcribe`-mode submission — which runs the full hidden suite so
they see it pass, but writes **no learning event**, because the reveal has already been scored at
outcome 0 and copying it out must not hand that back. `GET /api/practice/next` returns the same
problem until an accepted transcription exists, so the step cannot be skipped by reloading. An
episode is _derived_, never stored as status: it is open iff `scheduled_followups` rows exist for
the problem and no accepted `transcribe` submission does.

Each episode owes two follow-ups, both planned at reveal time (so abandoning the first cannot skip
the second): a `reinforce` — same concept, same `shape`, `origin_rating − 150`, due immediately —
and a `transfer` — same concept, **different** `shape`, same rating, due in 3 days. A follow-up is
settled by being _attempted_, not passed. Due follow-ups outrank ordinary selection.

**Explicit mastery.** A rating alone cannot distinguish three unaided solves over three weeks from
one four-hint solve yesterday; both reach 1500. `isMastered` requires all five of: rating ≥
`min_rating + 0.7 * (max_rating − min_rating)` for that concept's own band; `uncertainty ≤ 100`;
≥3 solves with **no hint of any level**; across ≥3 distinct problems; spanning ≥7 days. Evaluated
by the judge after the rating update, written to `user_concept_state.mastered_at`, and never
cleared.

**Target band (settled in M1, do not re-derive):** the 65–80% success band lies **below** the
user's rating on both edges, because both targets are above the 50% coin-flip point. For a 1500
user the band is `[1259, 1392]` with an ideal near `1332` — verified:
`expectedSuccess(1500, 1392) = 0.651`, `expectedSuccess(1500, 1259) = 0.800`. A band straddling
the user's rating would be wrong; a rating-matched problem is a 50% proposition, which is harder
than the training target. M3's overload role is what deliberately pushes above the band.

**Explainability requirement:** `updateConcepts` returns a human sentence, and the caller writes it
into `learning_events.evidence.explanation`. Every mastery change is reconstructable from
`before_state`/`after_state`.

---

## 9. HTTP API surface (`apps/api`)

All routes are JSON, prefix `/api`, and every response carries `x-correlation-id`.

| Method | Path                               | Body / query                                                                  | Response                                                                                           |
| ------ | ---------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| GET    | `/health`                          |                                                                               | `{ ok, version, db: 'up'                                                                           | 'down' }` |
| GET    | `/api/problems/next`               | `?concept=&rating=`                                                           | `{ problem: PublicProblem, rationale: string, evidence: object }`                                  |
| GET    | `/api/problems/:versionId`         |                                                                               | `{ problem: PublicProblem }`                                                                       |
| GET    | `/api/problems/:versionId/reveal`  |                                                                               | `Reveal` (§4.5) once earned — 404 until then                                                       |
| POST   | `/api/submissions`                 | `{ problem_version_id, language, source, mode, active_ms?, paste_detected? }` | `{ submission_id, status }`                                                                        |
| GET    | `/api/submissions/:id`             |                                                                               | `{ submission }` (safe projection)                                                                 |
| GET    | `/api/submissions/:id/events`      |                                                                               | SSE                                                                                                |
| POST   | `/api/hints`                       | `{ problem_version_id, level }`                                               | `{ level, text, penalty_cap, next_level_penalty }`                                                 |
| GET    | `/api/hints/:versionId`            |                                                                               | `{ taken, available, penalties, texts, editorial_md \| null, solutions \| null, transcribed }`     |
| POST   | `/api/problems/:versionId/give-up` | `{ active_ms? }`                                                              | `{ editorial_md, solutions, concepts, teaching, mastery_change }`                                  |
| GET    | `/api/progress`                    |                                                                               | concept mastery, reviews due, stats, records, history                                              |
| GET    | `/api/system/stats`                |                                                                               | queue depth/waits, workers, verdicts, buffer depth, gen pass rate, dead jobs                       |
| GET    | `/api/me`                          |                                                                               | `{ user: { id, handle, email } }`                                                                  |
| GET    | `/api/practice/next`               |                                                                               | `{ problem \| null, generating \| null, teaching \| null, followup \| null, rationale, evidence }` |
| POST   | `/api/generate-now`                | `{ concepts, target_rating }`                                                 | `{ job_id }` (M3 escape hatch)                                                                     |
| GET    | `/api/concepts`                    |                                                                               | `{ concepts, edges }`                                                                              |

**Hard rule:** the API never selects `problem_versions.content` into a response without passing it
through `toPublicProblem`. Hidden tests, solutions, generator, mutants, and un-taken hints must not
appear in any payload.

`POST /api/submissions` writes the submission row **and** enqueues the judge job in one
transaction, then returns. Never wait for the verdict.

---

## 10. Verification gate (`content/leetmind_content/verification/`)

Six blocking stages, run in order; first failure short-circuits and writes a
`verification_reports` row with `passed=false, failed_stage=<name>`.

| #   | name           | module                  | fails when                                                                                                                           |
| --- | -------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `schema`       | `stage_schema.py`       | pydantic parse fails; hint L1/L2 contain code fences or named algorithms; constraints unparseable; concept weights don't sum to ~1.0 |
| 2   | `compile`      | `stage_compile.py`      | reference or brute force fails to import/run a smoke case in the sandbox                                                             |
| 3   | `differential` | `stage_differential.py` | reference ≠ brute force on any of `VERIFY_DIFFERENTIAL_CASES` seeded inputs (record seeds; shrink the counterexample)                |
| 4   | `boundary`     | `stage_boundary.py`     | derived boundary cases (empty/min/max/dupes/extremes/negatives) + declared adversarial cases disagree or exceed limits               |
| 5   | `examples`     | `stage_examples.py`     | any public example is not reproduced by the reference                                                                                |
| 6   | `mutation`     | `stage_mutation.py`     | any provided mutant **survives** the hidden suite built in stages 3–4                                                                |

Stage results append to `stages jsonb`:
`{stage, status: 'passed'|'failed'|'skipped', duration_ms, details: {...}}`.
On success the worker writes `hidden_tests` into `content`, sets `state='approved'`,
`approved_at=now()`, and populates `problem_concepts`. On failure `state='rejected'` and
`rejected_reason` is set. **No human approval step exists.**

Banned-word list for hint stage 1 (L1/L2): `dynamic programming`, `dp`, `two pointer`,
`sliding window`, `binary search`, `union find`, `dfs`, `bfs`, `memo`, `trie`, `heap`,
`topological`, `backtrack`, `greedy`, `dijkstra`, `kadane`, `monotonic` — plus any ``` fence.

---

## 11. Generation (`content/leetmind_content/generation/`)

- `invoker.py`: `Invoker` protocol with `invoke(prompt: str, *, timeout_ms: int) -> InvokeResult`.
  Implementations: `ClaudeInvoker` (`claude -p <prompt> --output-format json`, subprocess, no
  shell), `CodexInvoker` (stub raising NotImplemented but wired into the factory), `StubInvoker`
  (deterministic fixture output for tests / offline dev — **required**, since CI has no model).
  Selected by `GENERATOR_INVOKER`.
- `prompts/v1.py`: `PROMPT_VERSION = 'v1'` and a builder taking `GenerationRequest` → prompt text
  that demands a single JSON object matching ProblemVersion, with explicit field docs, the neutral
  story requirement, similarity exclusions, and forbidden algorithm names in early hints.
- Schema failure → retry up to `GENERATOR_MAX_SCHEMA_RETRIES` with the pydantic error text appended.
- Every invocation writes a `model_runs` row, including failures.

Replenishment (`workers/replenish.py`): every `REPLENISH_INTERVAL_MS`, compute target
concept×band cells from `user_concept_state` (weak concepts, due reviews, next overload step),
count approved-and-unattempted problems per cell, and enqueue `generate` jobs for cells below
`BUFFER_LOW_WATERMARK`, using idempotency key `generate:<concept>:<band>:<slot>` so restarts don't
pile up duplicates. Bands are 200-wide, keyed by floor(rating/200)*200.

---

## 12. Web (`apps/web`)

React 19 + Vite + TypeScript + Tailwind v4 + `@monaco-editor/react`. Routes (react-router):
`/` (practice), `/problem/:versionId`, `/progress`, `/concepts`, `/login`, `/signup`.
State: TanStack Query for reads, plain `EventSource` for SSE.
Shared types imported from `@leetmind/shared` — the web app must never redeclare API shapes.

Workspace requirements: statement/constraints/examples pane; Monaco with language select and
starter code; Run (custom input) + Submit; live status + per-test progress from SSE; verdict panel
with runtime/memory and safe diagnostics; hint ladder showing the penalty **before** taking each
hint; give-up → editorial; active-time tracking that pauses on `visibilitychange`/blur and can be
visually hidden while still measuring.

---

## 13. Test database isolation (MANDATORY — a data-loss defect was found here)

Several test suites ran `truncate table jobs, model_runs, verification_reports, …` against
`DATABASE_URL`, which defaults to the **development** database. Since LeetMind's whole premise is a
tool the author uses daily, running the test suite silently destroyed real practice history. That
is a correctness bug in the tests, not an inconvenience.

Rules:

1. **Tests never read `DATABASE_URL`.** They read **`TEST_DATABASE_URL`**, defaulting to
   `postgres://leetmind:leetmind@localhost:5432/leetmind_test`. That database exists and is
   migrated; recreate with `createdb leetmind_test && DATABASE_URL=…/leetmind_test pnpm db:migrate`.
2. **A guard makes misconfiguration impossible.** Before any destructive fixture runs, assert the
   target database name matches `/(^|_)test$/`. If it does not, **fail the test run loudly** with a
   message naming the database — never truncate, never silently continue. This is defence in depth:
   an operator who exports the wrong `TEST_DATABASE_URL` must get a failed test run, not a wiped
   database. Every language gets the same guard:
   - TS: `assertTestDatabase(url)` exported from `@leetmind/db`.
   - Python: `assert_test_database(url)` in `content/leetmind_content/db.py`.
3. **Prefer creating and cleaning up only your own rows** over truncating shared tables at all
   (`apps/judge/test/helpers.ts` already does this and is the model to copy). Truncation is a last
   resort, and only ever inside the guard.
4. Suites that spin up their own throwaway container (`packages/queue`) are already safe and need
   no change beyond the guard.
5. CI and local runs must be able to execute the full suite repeatedly with **zero effect** on the
   dev database.

**Known limitation, and the concrete fix (M4).** The Python fixtures assume _exclusive_ ownership of
the test database — two concurrent `pytest` processes against the same `leetmind_test` deadlock on
each other's truncates. That was tolerable pre-M4 (one suite at a time) but is incompatible with
M4's chaos/concurrency suite (`apps/judge/test/chaos/`), which deliberately runs many real workers —
including separate OS processes — in parallel against a live Postgres. `content/` is out of scope
for the M4 reliability agent (owned by a concurrently-working agent on a connection-pool fix), so
this section specifies the fix precisely enough to implement without further design work, rather
than implementing it.

_Chosen mechanism: schema-per-`pytest-xdist`-worker, not database-per-process._ Postgres schemas are
namespaces within one database — cheap to create/drop, and every existing connection string /
`TEST_DATABASE_URL` / CI secret keeps pointing at the same `leetmind_test` database unchanged. A
database-per-process design (`leetmind_test_gw0`, `leetmind_test_gw1`, ...) also works and trivially
satisfies the existing `assertTestDatabase`/`assert_test_database` name-pattern guard (any suffix
still ends in `_test`), but needs `CREATE DATABASE` privilege, N times the connection pool
bookkeeping, and a dynamic `DATABASE_URL` per worker — schema-per-worker gets the same isolation
for less machinery and is the one to build first; fall back to database-per-process only if some
fixture turns out to depend on session-level state that a schema boundary can't isolate (e.g. an
extension installed database-wide).

Concrete mechanism:

1. `pytest-xdist` (already the standard way to parallelize pytest; add it as a dev dependency if not
   present) sets `PYTEST_XDIST_WORKER` in each worker process's environment (`"gw0"`, `"gw1"`, ...;
   unset when running plain `pytest` with no `-n` flag).
2. A session-scoped autouse fixture in `content/tests/conftest.py` computes
   `schema = f"pytest_{os.environ['PYTEST_XDIST_WORKER']}"` when that env var is set, or falls back
   to `"public"` (today's behavior, unchanged) when it isn't — so a plain single-process `pytest`
   run needs no new setup and stays exactly as fast/simple as today.
3. Still call `assert_test_database(TEST_DATABASE_URL)` first, unconditionally (the schema split is
   _in addition to_ that guard, not a replacement for it — a worker-scoped schema inside the
   _development_ database would still be a data-loss bug waiting to happen).
4. `CREATE SCHEMA IF NOT EXISTS {schema}`, then run the **same** migrations
   (`packages/db/migrations/*.sql`, via whatever runner `content/leetmind_content/db.py` already
   uses to reach Postgres) with `search_path` set to `{schema}, public` for that worker's
   connections — either via `SET search_path` on each new connection, or by encoding
   `options=-csearch_path%3D{schema}` in the DSN passed to `psycopg`. Every table, sequence, and
   truncate a worker's fixtures touch now resolves inside its own schema; `TRUNCATE` in worker gw0
   can never block or interleave with worker gw1's truncate of a same-named table, because they are
   different relations in different schemas — the deadlock this section originally documented
   becomes structurally impossible rather than merely less likely.
5. Teardown is optional and idempotent either way: `DROP SCHEMA {schema} CASCADE` at session end for
   a clean slate, or just leave it — the next run's `CREATE SCHEMA IF NOT EXISTS` plus a fresh
   migration pass makes a stale leftover schema self-healing, never a data-loss risk (it's isolated
   from every other schema by construction).

_This generalizes beyond Python._ While building M4's chaos suite, the same class of collision was
observed directly on the **TypeScript** side even though nothing in `apps/judge`/`apps/api`'s own
vitest suites deadlocks the way `pytest`'s truncate-based fixtures do: `apps/judge/test/chaos/`'s
claim-storm and reaper-idempotence tests enqueue against the shared `jobs` table (whose `kind`
column is restricted by a DB `CHECK` constraint to `'judge' | 'verify' | 'generate'`, so — unlike
Python's per-table truncation — there is no way to namespace a synthetic value to dodge collision)
and added a guard, `assertNoStrayJobs()`
(`apps/judge/test/chaos/chaos-helpers.ts`), that fails loudly rather than silently double-processing
a row it doesn't own. That guard _did_ fire during real verification runs of this milestone, when
another agent's concurrently-running test process was enqueuing `'generate'`-kind jobs against the
same `leetmind_test` database at the same time. `packages/queue`'s own suite already avoids this
entirely (it spins up a dedicated throwaway Postgres container on its own port, per `packages/queue/
src/test-fixture.ts` — CONTRACTS §13 rule 4), but `apps/api` and `apps/judge` do not: every
`pnpm --filter <pkg> test` invocation is a separate OS process sharing one `leetmind_test` database
with zero isolation between processes (vitest's own `fileParallelism: false` only serializes test
_files_ within one process, not across processes). The same schema-per-worker mechanism above
applies directly: each TS suite's `testSetup.ts` should derive a schema name from an analogous
worker/process identifier (there is no `pytest-xdist`-style env var for vitest across separate
`pnpm --filter` invocations, so this would need to be a new convention — e.g. a `TEST_WORKER_ID` env
var CI sets per parallel job, or a fallback derived from `process.pid`), `CREATE SCHEMA IF NOT
EXISTS` + migrate + `SET search_path` before any test runs, exactly as above. This is scoped out of
M4 (not requested, and `apps/api`/`apps/judge`'s vitest bootstrapping is arguably not this agent's
file boundary either) but is recorded here since it's now a _confirmed_, not merely theoretical, gap
— multi-agent / multi-process development sessions against one shared `leetmind_test` database will
keep tripping over it until it's fixed the same way on both sides.

## 14. Definition of done, per agent

Every implementation agent must, before reporting success:

1. `pnpm -w typecheck` clean for TS work (`tsc --noEmit` across the workspace), or
   `uv run ruff check . && uv run mypy leetmind_content` clean-ish for Python work.
2. Any tests it added actually run and pass (`pnpm -w test` / `uv run pytest`).
3. Not modify files outside its stated scope. If a shared file needs a change, report it instead.
4. Report: files created, deviations from this doc, and anything it could not verify.
