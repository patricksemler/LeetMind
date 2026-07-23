import type { PoolClient } from "pg";
import { query, queryOne, queryOneWith } from "./pool.js";
import type { ConceptEdgeRow, ConceptRow, UserConceptStateRow } from "./types.js";

export async function listConcepts(): Promise<ConceptRow[]> {
  return query<ConceptRow>("select * from concepts order by sort_order asc, id asc");
}

export async function listConceptEdges(): Promise<ConceptEdgeRow[]> {
  return query<ConceptEdgeRow>("select * from concept_edges order by parent_id asc, child_id asc");
}

/**
 * `client` is optional and additive (existing pool-level callers are unaffected): pass the
 * caller's transaction client when this is read from inside `withTransaction`, so the read joins
 * that transaction instead of checking out a second connection from the pool — a second
 * connection cannot see the transaction's own uncommitted writes (see `applyMastery` in
 * apps/judge/src/mastery.ts, which threads its `client` through here for exactly this reason).
 */
export async function getConceptState(
  userId: string,
  conceptId: string,
  client?: PoolClient,
): Promise<UserConceptStateRow | null> {
  const sql = "select * from user_concept_state where user_id = $1 and concept_id = $2";
  const params = [userId, conceptId];
  return client ? queryOneWith<UserConceptStateRow>(client, sql, params) : queryOne<UserConceptStateRow>(sql, params);
}

/**
 * Row-locks `user_concept_state` for update within the caller's transaction. Every mastery
 * consequence (a judge verdict, a give-up, a skip) follows a read-modify-write shape: read the
 * current rating/uncertainty, compute a new value, write it back. Without a lock, two concurrent
 * transactions touching the same user+concept both read the same `before_rating`, and whichever
 * commits second silently clobbers the first's write — a lost update (confirmed live via a
 * double-submit race: one delta lost, counters double-incremented, the audit trail disagreeing
 * with the final state). `SELECT ... FOR UPDATE` blocks the second transaction until the first
 * commits, so it reads the already-updated row instead of a stale one. Every concept for the
 * single seeded user already has a `user_concept_state` row from migration time (see
 * `002_seed_taxonomy.sql`), so there is no "insert races insert" case to also worry about here.
 */
export async function getConceptStateForUpdate(
  client: PoolClient,
  userId: string,
  conceptId: string,
): Promise<UserConceptStateRow | null> {
  return queryOneWith<UserConceptStateRow>(
    client,
    "select * from user_concept_state where user_id = $1 and concept_id = $2 for update",
    [userId, conceptId],
  );
}

export async function listConceptStates(userId: string): Promise<UserConceptStateRow[]> {
  return query<UserConceptStateRow>(
    "select ucs.* from user_concept_state ucs join concepts c on c.id = ucs.concept_id where ucs.user_id = $1 order by c.sort_order asc",
    [userId],
  );
}

/**
 * Upserts a full `user_concept_state` row (the shape written by the learner engine after every
 * mastery update). Must run inside the caller's transaction so it lands atomically with the
 * `learning_events` row that justifies it.
 */
export async function upsertConceptState(client: PoolClient, state: UserConceptStateRow): Promise<UserConceptStateRow> {
  const sql = `
    insert into user_concept_state (
      user_id, concept_id, rating, uncertainty, attempts, solves, unassisted_solves, skips,
      current_streak, best_streak, total_active_ms, hint_counts, error_counts,
      last_practiced_at, next_review_at, review_interval_days, review_ease, review_reps, updated_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now()
    )
    on conflict (user_id, concept_id) do update set
      rating = excluded.rating,
      uncertainty = excluded.uncertainty,
      attempts = excluded.attempts,
      solves = excluded.solves,
      unassisted_solves = excluded.unassisted_solves,
      skips = excluded.skips,
      current_streak = excluded.current_streak,
      best_streak = excluded.best_streak,
      total_active_ms = excluded.total_active_ms,
      hint_counts = excluded.hint_counts,
      error_counts = excluded.error_counts,
      last_practiced_at = excluded.last_practiced_at,
      next_review_at = excluded.next_review_at,
      review_interval_days = excluded.review_interval_days,
      review_ease = excluded.review_ease,
      review_reps = excluded.review_reps,
      updated_at = now()
    returning *
  `;
  const row = await queryOneWith<UserConceptStateRow>(client, sql, [
    state.user_id,
    state.concept_id,
    state.rating,
    state.uncertainty,
    state.attempts,
    state.solves,
    state.unassisted_solves,
    state.skips,
    state.current_streak,
    state.best_streak,
    state.total_active_ms,
    JSON.stringify(state.hint_counts),
    JSON.stringify(state.error_counts),
    state.last_practiced_at,
    state.next_review_at,
    state.review_interval_days,
    state.review_ease,
    state.review_reps,
  ]);
  if (!row) {
    throw new Error(`upsertConceptState: failed to read back state for ${state.user_id}/${state.concept_id}`);
  }
  return row;
}
