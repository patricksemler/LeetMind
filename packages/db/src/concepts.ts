import type { PoolClient } from "pg";
import { query, queryOne, queryOneWith, queryWith } from "./pool.js";
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
  return client
    ? queryOneWith<UserConceptStateRow>(client, sql, params)
    : queryOne<UserConceptStateRow>(sql, params);
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
export async function upsertConceptState(
  client: PoolClient,
  state: UserConceptStateRow,
): Promise<UserConceptStateRow> {
  const sql = `
    insert into user_concept_state (
      user_id, concept_id, rating, uncertainty, attempts, solves, unassisted_solves, skips,
      current_streak, best_streak, total_active_ms, hint_counts, error_counts,
      last_practiced_at, next_review_at, review_interval_days, review_ease, review_reps,
      mastered_at, updated_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now()
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
      -- coalesce, not overwrite: mastery is sticky (migration 007). A caller that builds its
      -- update from a state row read before mastery was awarded must not be able to revoke it.
      mastered_at = coalesce(user_concept_state.mastered_at, excluded.mastered_at),
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
    state.mastered_at,
  ]);
  if (!row) {
    throw new Error(
      `upsertConceptState: failed to read back state for ${state.user_id}/${state.concept_id}`,
    );
  }
  return row;
}

/**
 * The evidence `isMastered` (packages/learner/src/mastery.ts) needs for one concept, plus that
 * concept's own difficulty band.
 *
 * "Unassisted" is defined here as **no hint event of any level** on that problem — not "no
 * editorial". Someone who took an orientation hint solved a different, easier problem than the one
 * posed, and mastery is the one claim strict enough to care about the difference. (The rating model
 * takes the softer view, capping the outcome by hint level rather than discarding it; that is
 * correct for a running estimate and wrong for a durable claim.)
 *
 * `mode = 'submit'` excludes `transcribe` rows for free — a copied-out editorial is never evidence.
 */
export async function conceptMasteryEvidence(
  client: PoolClient,
  userId: string,
  conceptId: string,
): Promise<{
  unassistedSolves: number;
  distinctProblems: number;
  firstUnassistedSolveAt: Date | null;
  lastUnassistedSolveAt: Date | null;
  band: { min_rating: number; max_rating: number } | null;
}> {
  const rows = await queryWith<{
    unassisted_solves: number;
    distinct_problems: number;
    first_at: Date | null;
    last_at: Date | null;
    min_rating: number | null;
    max_rating: number | null;
  }>(
    client,
    `select
       count(s.id)::int                        as unassisted_solves,
       count(distinct s.problem_version_id)::int as distinct_problems,
       min(s.completed_at)                     as first_at,
       max(s.completed_at)                     as last_at,
       max(c.min_rating)                       as min_rating,
       max(c.max_rating)                       as max_rating
     from concepts c
     left join problem_concepts pc
       on pc.concept_id = c.id and pc.role = 'primary'
     left join submissions s
       on s.problem_version_id = pc.problem_version_id
      and s.user_id = $1
      and s.mode = 'submit'
      and s.verdict = 'accepted'
      and not exists (
        select 1 from hint_events he
         where he.user_id = s.user_id
           and he.problem_version_id = s.problem_version_id
      )
     where c.id = $2`,
    [userId, conceptId],
  );

  const row = rows[0];
  return {
    unassistedSolves: row?.unassisted_solves ?? 0,
    distinctProblems: row?.distinct_problems ?? 0,
    firstUnassistedSolveAt: row?.first_at ?? null,
    lastUnassistedSolveAt: row?.last_at ?? null,
    band:
      row && row.min_rating !== null && row.max_rating !== null
        ? { min_rating: row.min_rating, max_rating: row.max_rating }
        : null,
  };
}
