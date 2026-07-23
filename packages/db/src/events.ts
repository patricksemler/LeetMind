import type { PoolClient } from "pg";
import { query, queryOneWith, queryWith } from "./pool.js";
import type { HintEventRow, HintLevel, LearningEventKind, LearningEventRow } from "./types.js";

export interface NewLearningEventInput {
  id: string;
  user_id: string;
  problem_version_id?: string | null;
  submission_id?: string | null;
  kind: LearningEventKind;
  outcome: number;
  evidence: Record<string, unknown>;
  before_state: Record<string, unknown>;
  after_state: Record<string, unknown>;
  idempotency_key?: string | null;
  correlation_id?: string | null;
}

/**
 * Inserts an append-only learning_events row. Returns `null` (instead of throwing) when
 * `idempotency_key` collides with an existing row — the at-least-once judge/queue delivery model
 * relies on this to guarantee one mastery update per submission.
 */
export async function insertLearningEvent(
  client: PoolClient,
  row: NewLearningEventInput,
): Promise<LearningEventRow | null> {
  const sql = `
    insert into learning_events (
      id, user_id, problem_version_id, submission_id, kind, outcome, evidence,
      before_state, after_state, idempotency_key, correlation_id
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
    )
    on conflict (idempotency_key) do nothing
    returning *
  `;
  return queryOneWith<LearningEventRow>(client, sql, [
    row.id,
    row.user_id,
    row.problem_version_id ?? null,
    row.submission_id ?? null,
    row.kind,
    row.outcome,
    JSON.stringify(row.evidence),
    JSON.stringify(row.before_state),
    JSON.stringify(row.after_state),
    row.idempotency_key ?? null,
    row.correlation_id ?? null,
  ]);
}

export async function listLearningEvents(userId: string, limit: number): Promise<LearningEventRow[]> {
  return query<LearningEventRow>(
    "select * from learning_events where user_id = $1 order by created_at desc limit $2",
    [userId, limit],
  );
}

export interface NewHintEventInput {
  id: string;
  user_id: string;
  problem_version_id: string;
  level: HintLevel;
}

/**
 * Records a hint being taken. Idempotent on (user_id, problem_version_id, level): returns `null`
 * instead of throwing if this level was already taken for this problem.
 */
export async function insertHintEvent(client: PoolClient, row: NewHintEventInput): Promise<HintEventRow | null> {
  const sql = `
    insert into hint_events (id, user_id, problem_version_id, level)
    values ($1, $2, $3, $4)
    on conflict (user_id, problem_version_id, level) do nothing
    returning *
  `;
  return queryOneWith<HintEventRow>(client, sql, [row.id, row.user_id, row.problem_version_id, row.level]);
}

/**
 * `client` is optional and additive (existing pool-level callers are unaffected): pass the
 * caller's transaction client when this is read from inside `withTransaction`, so the read joins
 * that transaction instead of checking out a second connection from the pool — a second
 * connection cannot see the transaction's own uncommitted writes (see `applyMastery` in
 * apps/judge/src/mastery.ts, which threads its `client` through here for exactly this reason).
 */
export async function listHintEvents(
  userId: string,
  versionId: string,
  client?: PoolClient,
): Promise<HintEventRow[]> {
  const sql = "select * from hint_events where user_id = $1 and problem_version_id = $2 order by created_at asc";
  const params = [userId, versionId];
  return client ? queryWith<HintEventRow>(client, sql, params) : query<HintEventRow>(sql, params);
}
