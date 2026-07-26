import type { PoolClient } from "pg";
import { query, queryOne, queryOneWith } from "./pool.js";
import type {
  ExecutionAttemptRow,
  Language,
  SubmissionFailure,
  SubmissionMode,
  SubmissionRow,
  SubmissionStatus,
  Verdict,
} from "./types.js";

export interface NewSubmissionInput {
  id: string;
  user_id: string;
  problem_version_id: string;
  baseline_item_id?: string | null;
  mode: SubmissionMode;
  language: Language;
  source: string;
  source_hash: string;
  status?: SubmissionStatus;
  custom_input?: unknown | null;
  active_ms?: number | null;
  idempotency_key?: string | null;
  correlation_id?: string | null;
}

/** Inserts a submission row. Callers own id generation and typically run this in the same transaction as `Queue.enqueue`. */
export async function insertSubmission(client: PoolClient, row: NewSubmissionInput): Promise<SubmissionRow> {
  const sql = `
    insert into submissions (
      id, user_id, problem_version_id, baseline_item_id, mode, language, source, source_hash,
      status, custom_input, active_ms, idempotency_key, correlation_id
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
    )
    returning *
  `;
  const inserted = await queryOneWith<SubmissionRow>(client, sql, [
    row.id,
    row.user_id,
    row.problem_version_id,
    row.baseline_item_id ?? null,
    row.mode,
    row.language,
    row.source,
    row.source_hash,
    row.status ?? "created",
    row.custom_input === undefined ? null : JSON.stringify(row.custom_input),
    row.active_ms ?? null,
    row.idempotency_key ?? null,
    row.correlation_id ?? null,
  ]);
  if (!inserted) {
    throw new Error(`insertSubmission: insert of ${row.id} returned no row`);
  }
  return inserted;
}

export async function getSubmission(id: string): Promise<SubmissionRow | null> {
  return queryOne<SubmissionRow>("select * from submissions where id = $1", [id]);
}

/**
 * The most recent submission this user made against a problem version, or `null`. Backs hydrating
 * the workspace on mount/reload — without this, refreshing mid-submission (or reopening a problem
 * you already have a result for) loses the verdict with no recovery: the backend has it, but the
 * client only ever tracked the active submission id in local React state (confirmed live).
 */
export async function getLatestSubmission(userId: string, versionId: string): Promise<SubmissionRow | null> {
  return queryOne<SubmissionRow>(
    "select * from submissions where user_id = $1 and problem_version_id = $2 order by created_at desc limit 1",
    [userId, versionId],
  );
}

/**
 * True if this user has a `submit`-mode submission on this problem version that hasn't reached a
 * terminal status yet. Used to reject a give-up while a judge job is in flight (409) — without
 * this, a give-up racing an in-flight accept applies mastery consequences in both directions for
 * the same evidence (confirmed live).
 */
/** Whether the user has any scored (non-practice contexts filter separately) accepted submit-mode
 * submission on this version — the server-side "already solved" signal. */
export async function hasAcceptedSubmission(userId: string, versionId: string): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    `select exists(
       select 1 from submissions
        where user_id = $1 and problem_version_id = $2 and mode = 'submit' and verdict = 'accepted'
     ) as exists`,
    [userId, versionId],
  );
  return row?.exists ?? false;
}

export async function hasInFlightSubmission(userId: string, versionId: string): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    `select exists(
       select 1 from submissions
        where user_id = $1 and problem_version_id = $2 and mode = 'submit'
          and status not in ('completed', 'cancelled')
     ) as exists`,
    [userId, versionId],
  );
  return row?.exists ?? false;
}

export async function updateSubmissionStatus(
  client: PoolClient,
  id: string,
  status: SubmissionStatus,
): Promise<SubmissionRow> {
  const row = await queryOneWith<SubmissionRow>(
    client,
    "update submissions set status = $2 where id = $1 returning *",
    [id, status],
  );
  if (!row) {
    throw new Error(`updateSubmissionStatus: no submission with id ${id}`);
  }
  return row;
}

export interface CompleteSubmissionResult {
  verdict: Verdict;
  passed_tests: number;
  total_tests: number;
  runtime_ms?: number | null;
  memory_kb?: number | null;
  failure?: SubmissionFailure | null;
}

/** Terminal write for a judged submission: sets status='completed', the verdict, and completed_at. */
export async function completeSubmission(
  client: PoolClient,
  id: string,
  result: CompleteSubmissionResult,
): Promise<SubmissionRow> {
  const sql = `
    update submissions
    set status = 'completed',
        verdict = $2,
        passed_tests = $3,
        total_tests = $4,
        runtime_ms = $5,
        memory_kb = $6,
        failure = $7,
        completed_at = now()
    where id = $1
    returning *
  `;
  const row = await queryOneWith<SubmissionRow>(client, sql, [
    id,
    result.verdict,
    result.passed_tests,
    result.total_tests,
    result.runtime_ms ?? null,
    result.memory_kb ?? null,
    result.failure ? JSON.stringify(result.failure) : null,
  ]);
  if (!row) {
    throw new Error(`completeSubmission: no submission with id ${id}`);
  }
  return row;
}

export interface NewExecutionAttemptInput {
  id: string;
  submission_id: string;
  attempt: number;
  worker_id: string;
  image_digest?: string | null;
  language_version?: string | null;
  flags?: string | null;
  limits: Record<string, unknown>;
  usage?: Record<string, unknown> | null;
  per_test?: unknown[] | null;
  exit_code?: number | null;
  finished_at?: Date | null;
}

export async function insertExecutionAttempt(
  client: PoolClient,
  row: NewExecutionAttemptInput,
): Promise<ExecutionAttemptRow> {
  const sql = `
    insert into execution_attempts (
      id, submission_id, attempt, worker_id, image_digest, language_version, flags,
      limits, usage, per_test, exit_code, finished_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
    )
    returning *
  `;
  const inserted = await queryOneWith<ExecutionAttemptRow>(client, sql, [
    row.id,
    row.submission_id,
    row.attempt,
    row.worker_id,
    row.image_digest ?? null,
    row.language_version ?? null,
    row.flags ?? null,
    JSON.stringify(row.limits),
    row.usage ? JSON.stringify(row.usage) : null,
    row.per_test ? JSON.stringify(row.per_test) : null,
    row.exit_code ?? null,
    row.finished_at ?? null,
  ]);
  if (!inserted) {
    throw new Error(`insertExecutionAttempt: insert of ${row.id} returned no row`);
  }
  return inserted;
}

export async function listRecentSubmissions(userId: string, limit: number): Promise<SubmissionRow[]> {
  return query<SubmissionRow>(
    "select * from submissions where user_id = $1 order by created_at desc limit $2",
    [userId, limit],
  );
}
