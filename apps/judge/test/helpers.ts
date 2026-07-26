// Test-only DB seeding helpers, shared by every apps/judge integration test. Every test problem
// gets a freshly-generated ULID id and is torn down (including any submissions/execution
// attempts/learning events it produced) at the end of the test that created it — this suite runs
// against the SAME live Postgres instance other agents/tests may be using, so nothing here ever
// truncates a shared table; it only ever touches rows it created itself, plus (transiently,
// restored afterwards) the single seeded local user's `user_concept_state` row for the one
// concept these tests exercise.
import { Client } from "pg";
import {
  getConceptState,
  getSubmission,
  getBaselineItem,
  insertHintEvent,
  insertProblemConcepts,
  insertProblemVersion,
  insertSubmission,
  insertBaselineSession,
  insertBaselineItem,
  query,
  upsertConceptState,
  withTransaction,
  type SubmissionRow,
  type SubmissionStatus,
  type UserConceptStateRow,
  type BaselineItemRow,
} from "@leetmind/db";
import {
  DEFAULT_SINGLE_USER_ID,
  loadBaseConfig,
  loadJudgeConfig,
  loadSandboxConfig,
  newId,
  type JudgeJobPayload,
  type ProblemVersion,
  type Signature,
} from "@leetmind/shared";
import type { Job, Logger as QueueLogger, WorkerContext } from "@leetmind/queue";
import { buildJudgeDeps, type JudgeDeps } from "../src/deps.js";

export const TEST_USER_ID = DEFAULT_SINGLE_USER_ID;
export const TEST_CONCEPT_ID = "arrays_hashing";

export async function isDatabaseReachable(): Promise<boolean> {
  const config = loadBaseConfig();
  const client = new Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

export async function isDockerReachable(): Promise<boolean> {
  const { execSync } = await import("node:child_process");
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface SeedProblemOpts {
  hiddenTests?: { args: unknown[]; expected: unknown; origin?: "example" | "random" | "boundary" | "adversarial" }[];
  examples?: { args: unknown[]; expected: unknown; explanation?: string }[];
  signature?: Signature;
  expectedActiveMinutes?: [number, number];
  difficultyRating?: number;
  comparator?: "exact" | "float_tol" | "unordered" | "checker_py";
  checkerPy?: string;
}

export interface SeededProblem {
  problemId: string;
  versionId: string;
  content: ProblemVersion;
}

const DEFAULT_SIGNATURE: Signature = {
  name: "solve",
  params: [
    { name: "a", type: "int" },
    { name: "b", type: "int" },
  ],
  returns: "int",
};

/** Inserts a `problems` + `problem_versions` (state='approved') + `problem_concepts` row, all
 * pointed at the single seeded taxonomy concept `arrays_hashing` so the FK on `problem_concepts`
 * is satisfiable without inventing new concept rows. */
export async function seedApprovedProblem(opts: SeedProblemOpts = {}): Promise<SeededProblem> {
  const problemId = newId();
  const versionId = newId();
  const signature = opts.signature ?? DEFAULT_SIGNATURE;
  const examples = (opts.examples ?? [{ args: [1, 2], expected: 3, explanation: "1 + 2 = 3" }]).map((e) => ({
    args: e.args,
    expected: e.expected,
    explanation: e.explanation ?? "",
  }));
  const hiddenTests = (
    opts.hiddenTests ?? [
      { args: [1, 2], expected: 3, origin: "example" as const },
      { args: [10, -3], expected: 7, origin: "random" as const },
      { args: [0, 0], expected: 0, origin: "boundary" as const },
    ]
  ).map((t) => ({ args: t.args, expected: t.expected, origin: t.origin ?? "random" }));

  const content: ProblemVersion = {
    problem_id: problemId,
    version: 1,
    title: "Test Problem",
    internal_name: `test-problem-${versionId}`,
    statement_md: "Return the sum of two integers.",
    constraints_md: "-1000 <= a, b <= 1000",
    signature,
    examples,
    concepts: [{ id: TEST_CONCEPT_ID, role: "primary", weight: 1 }],
    difficulty: { rating: opts.difficultyRating ?? 1200, confidence: "generated" },
    expected_active_minutes: opts.expectedActiveMinutes ?? [2, 6],
    target_complexity: { time: "O(1)", space: "O(1)" },
    reference_solution_py: "def solve(a, b):\n    return a + b\n",
    brute_force_py: "def solve(a, b):\n    return a + b\n",
    input_generator_py: "",
    comparator: opts.comparator ?? "exact",
    checker_py: opts.checkerPy,
    hidden_tests: hiddenTests,
    mutants_py: [],
    hints: {
      l1_orientation: "Think about what operation combines two numbers.",
      l2_conceptual: "Consider the arithmetic operator that combines two quantities.",
      l3_structural: "Return a plus b directly.",
      outline: "return a + b",
      editorial_md: "# Editorial\nAdd the two numbers and return the result.",
    },
    provenance: { mode: "novel", model: "test-fixture", prompt_version: "v1", generated_at: new Date().toISOString() },
    state: "approved",
  };

  await query("insert into problems (id, internal_name) values ($1, $2)", [problemId, content.internal_name]);
  await withTransaction((client) =>
    insertProblemVersion(client, {
      id: versionId,
      problem_id: problemId,
      version: 1,
      state: "approved",
      content: content as unknown as Record<string, unknown>,
      title: content.title,
      difficulty_rating: content.difficulty.rating,
      difficulty_confidence: "generated",
      expected_min_minutes: content.expected_active_minutes[0],
      expected_max_minutes: content.expected_active_minutes[1],
      comparator: content.comparator,
      provenance: content.provenance,
    }),
  );
  await withTransaction((client) =>
    insertProblemConcepts(client, versionId, [{ id: TEST_CONCEPT_ID, role: "primary", weight: 1 }]),
  );

  return { problemId, versionId, content };
}

/** Removes everything a `seedApprovedProblem` + any submissions against it produced. Order
 * matters: `learning_events.submission_id` and `submissions.problem_version_id` have no
 * `on delete cascade`, so children must go before parents. */
export async function teardownProblem(problem: SeededProblem): Promise<void> {
  await query("delete from hint_events where problem_version_id = $1", [problem.versionId]);
  await query("delete from learning_events where problem_version_id = $1", [problem.versionId]);
  await query("delete from jobs where kind = 'judge' and payload->>'problem_version_id' = $1", [problem.versionId]);
  await query("delete from submissions where problem_version_id = $1", [problem.versionId]);
  await query("delete from problem_concepts where problem_version_id = $1", [problem.versionId]);
  await query("delete from problem_versions where id = $1", [problem.versionId]);
  await query("delete from problems where id = $1", [problem.problemId]);
}

export interface InsertSubmissionOpts {
  versionId: string;
  source: string;
  mode?: "run" | "submit";
  status?: SubmissionStatus;
  customInput?: unknown;
  activeMs?: number;
  correlationId?: string;
  baselineItemId?: string;
}

/** Inserts a submission the way apps/api's POST /api/submissions does: status defaults to
 * `queued` (CONTRACTS §4.5 — `created -> queued` already happened by the time a judge job would
 * see it). */
export async function insertTestSubmission(opts: InsertSubmissionOpts): Promise<SubmissionRow> {
  const id = newId();
  return withTransaction((client) =>
    insertSubmission(client, {
      id,
      user_id: TEST_USER_ID,
      problem_version_id: opts.versionId,
      mode: opts.mode ?? "submit",
      language: "python",
      source: opts.source,
      source_hash: "test-fixture",
      status: opts.status ?? "queued",
      custom_input: opts.customInput ?? null,
      active_ms: opts.activeMs ?? 0,
      correlation_id: opts.correlationId ?? null,
      baseline_item_id: opts.baselineItemId ?? null,
    }),
  );
}

export async function reloadSubmission(id: string): Promise<SubmissionRow> {
  const row = await getSubmission(id);
  if (!row) throw new Error(`test fixture: submission ${id} vanished`);
  return row;
}

export async function snapshotConceptState(conceptId = TEST_CONCEPT_ID): Promise<UserConceptStateRow> {
  const row = await getConceptState(TEST_USER_ID, conceptId);
  if (!row) throw new Error(`test fixture: no user_concept_state for ${TEST_USER_ID}/${conceptId} (taxonomy seed missing?)`);
  return row;
}

export async function restoreConceptState(snapshot: UserConceptStateRow): Promise<void> {
  await withTransaction((client) => upsertConceptState(client, snapshot));
}

export async function countLearningEvents(submissionId: string): Promise<number> {
  const rows = await query<{ count: string }>("select count(*)::text as count from learning_events where submission_id = $1", [
    submissionId,
  ]);
  return Number(rows[0]?.count ?? 0);
}

export async function countExecutionAttempts(submissionId: string): Promise<number> {
  const rows = await query<{ count: string }>(
    "select count(*)::text as count from execution_attempts where submission_id = $1",
    [submissionId],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Inserts a standalone `baseline_sessions` + `baseline_items` row for `versionId`, torn down by
 * the caller via `deleteTestBaselineSession` (no cascade from `teardownProblem`, which only knows
 * about the problem/submission tables). */
export async function insertTestBaselineItem(versionId: string): Promise<BaselineItemRow> {
  return withTransaction(async (client) => {
    const session = await insertBaselineSession(client, { id: newId(), user_id: TEST_USER_ID });
    return insertBaselineItem(client, {
      id: newId(),
      baseline_session_id: session.id,
      position: 0,
      problem_version_id: versionId,
    });
  });
}

export async function deleteTestBaselineSession(sessionId: string): Promise<void> {
  await query(
    "update submissions set baseline_item_id = null where baseline_item_id in (select id from baseline_items where baseline_session_id = $1)",
    [sessionId],
  );
  await query("delete from baseline_sessions where id = $1", [sessionId]);
}

export async function reloadBaselineItem(id: string): Promise<BaselineItemRow> {
  const row = await getBaselineItem(id);
  if (!row) throw new Error(`test fixture: baseline item ${id} vanished`);
  return row;
}

/** Records a give-up the way `POST /api/problems/:versionId/give-up` does at its core — inserts
 * the `editorial` hint_event that both `hasGivenUp` (@leetmind/db) and this test suite's
 * "practice" assertions key off of. */
export async function recordGiveUp(versionId: string): Promise<void> {
  await withTransaction((client) =>
    insertHintEvent(client, { id: newId(), user_id: TEST_USER_ID, problem_version_id: versionId, level: "editorial" }),
  );
}

// --- handler-invocation fakes ------------------------------------------------------------------

/** A no-op structural logger satisfying `@leetmind/queue`'s `Logger` interface, quiet by default
 * so test output isn't drowned in judge log lines. */
export function silentLogger(): QueueLogger {
  const noop = () => {};
  const logger: QueueLogger = { debug: noop, info: noop, warn: noop, error: noop };
  logger.child = () => logger;
  return logger;
}

export function makeJudgeJob(payload: JudgeJobPayload, overrides: Partial<Job<JudgeJobPayload>> = {}): Job<JudgeJobPayload> {
  const now = new Date();
  return {
    id: newId(),
    kind: "judge",
    priority: 10,
    payload,
    status: "leased",
    attempts: 1,
    max_attempts: 3,
    run_at: now,
    lease_expires_at: new Date(now.getTime() + 30_000),
    leased_by: "test-worker",
    last_error: null,
    idempotency_key: `judge:${payload.submission_id}`,
    correlation_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/** Inserts a real `jobs` row backing a synthetic `Job` object built by `makeJudgeJob` — needed
 * since `handleJudgeJob` now verifies lease ownership against the `jobs` table itself (`for
 * update`, mutually exclusive with the reaper — QA-PLAN.md §3 "reaper vs. active worker") before
 * writing a terminal verdict; a `Job` object with no backing row is indistinguishable from one
 * whose lease was already reassigned. `on conflict (id) do nothing` makes this safe to call more
 * than once for the same job id. */
export async function insertTestJudgeJob(job: Job<JudgeJobPayload>, leasedBy: string): Promise<void> {
  await query(
    `insert into jobs (id, kind, priority, payload, status, attempts, max_attempts, run_at, lease_expires_at, leased_by, idempotency_key, correlation_id)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (id) do nothing`,
    [
      job.id,
      job.kind,
      job.priority,
      JSON.stringify(job.payload),
      job.status,
      job.attempts,
      job.max_attempts,
      job.run_at,
      job.lease_expires_at,
      leasedBy,
      job.idempotency_key,
      job.correlation_id,
    ],
  );
}

/** `makeJudgeJob` + `insertTestJudgeJob` in one call, leased by `deps.config.judgeWorkerId` (the
 * same worker id `handleJudgeJob`'s lease-ownership check reads) — what every integration test
 * that drives the handler directly should use instead of the bare `makeJudgeJob`. */
export async function makeLeasedJudgeJob(
  deps: JudgeDeps,
  payload: JudgeJobPayload,
  overrides: Partial<Job<JudgeJobPayload>> = {},
): Promise<Job<JudgeJobPayload>> {
  const job = makeJudgeJob(payload, { leased_by: deps.config.judgeWorkerId, ...overrides });
  await insertTestJudgeJob(job, deps.config.judgeWorkerId);
  return job;
}

/** Builds a `WorkerContext` whose `signal` never aborts and whose `heartbeat()` always succeeds,
 * unless overridden — used to drive `createJudgeHandler(...)`'s handler function directly in
 * tests without going through the real `runWorker` polling loop. */
export function makeCtx(overrides: Partial<WorkerContext> = {}): WorkerContext {
  return {
    signal: new AbortController().signal,
    heartbeat: async () => true,
    logger: silentLogger(),
    ...overrides,
  };
}

/** `JudgeDeps` for tests: real config/pool/queue, optionally with sandbox limits overridden
 * (e.g. a short `wallTimeoutMs` for the timeout test) so integration tests stay fast. */
export function testJudgeDeps(sandboxOverrides: Partial<ReturnType<typeof loadSandboxConfig>> = {}): JudgeDeps {
  const config = loadJudgeConfig();
  const sandbox = { ...loadSandboxConfig(), ...sandboxOverrides };
  return buildJudgeDeps(config, sandbox);
}

