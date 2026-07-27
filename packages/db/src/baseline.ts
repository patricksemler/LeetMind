// Query helpers for `baseline_sessions` / `baseline_items` (migration 003, CONTRACTS.md §3, §9).
//
// Replaces the former workouts.ts. The workout ladder is gone; what remains is the adaptive
// baseline — a short, skippable probe that seeds honest per-concept ratings before the practice
// loop takes over. A baseline session grows one item at a time (see `advanceBaseline` in
// apps/api/src/routes/baseline.ts), so completion is owned by that stepper rather than inferred
// here from "every item is terminal".
import type { PoolClient } from "pg";
import { query, queryOne, queryOneWith } from "./pool.js";
import type { BaselineItemRow, BaselineItemState, BaselineSessionRow } from "./types.js";

export interface NewBaselineSessionInput {
  id: string;
  user_id: string;
  rationale?: Record<string, unknown>;
}

export async function insertBaselineSession(
  client: PoolClient,
  row: NewBaselineSessionInput,
): Promise<BaselineSessionRow> {
  const sql = `
    insert into baseline_sessions (id, user_id, rationale)
    values ($1, $2, $3)
    returning *
  `;
  const inserted = await queryOneWith<BaselineSessionRow>(client, sql, [
    row.id,
    row.user_id,
    JSON.stringify(row.rationale ?? {}),
  ]);
  if (!inserted) {
    throw new Error(`insertBaselineSession: insert of ${row.id} returned no row`);
  }
  return inserted;
}

export interface NewBaselineItemInput {
  id: string;
  baseline_session_id: string;
  position: number;
  problem_version_id: string;
  rationale?: string;
  selection_evidence?: Record<string, unknown>;
}

export async function insertBaselineItem(
  client: PoolClient,
  row: NewBaselineItemInput,
): Promise<BaselineItemRow> {
  const sql = `
    insert into baseline_items (id, baseline_session_id, position, problem_version_id, rationale, selection_evidence)
    values ($1, $2, $3, $4, $5, $6)
    returning *
  `;
  const inserted = await queryOneWith<BaselineItemRow>(client, sql, [
    row.id,
    row.baseline_session_id,
    row.position,
    row.problem_version_id,
    row.rationale ?? "",
    JSON.stringify(row.selection_evidence ?? {}),
  ]);
  if (!inserted) {
    throw new Error(`insertBaselineItem: insert of ${row.id} returned no row`);
  }
  return inserted;
}

/** This user's most recent `status='active'` baseline session, or `null`. */
export async function getActiveBaselineSession(userId: string): Promise<BaselineSessionRow | null> {
  return queryOne<BaselineSessionRow>(
    `select * from baseline_sessions where user_id = $1 and status = 'active' order by created_at desc limit 1`,
    [userId],
  );
}

/** This user's most recent baseline session in ANY state — what the practice gate checks to
 * decide whether onboarding has already happened (a completed baseline is the normal case). */
export async function getLatestBaselineSession(userId: string): Promise<BaselineSessionRow | null> {
  return queryOne<BaselineSessionRow>(
    `select * from baseline_sessions where user_id = $1 order by created_at desc limit 1`,
    [userId],
  );
}

export async function getBaselineSession(id: string): Promise<BaselineSessionRow | null> {
  return queryOne<BaselineSessionRow>("select * from baseline_sessions where id = $1", [id]);
}

export async function listBaselineItems(sessionId: string): Promise<BaselineItemRow[]> {
  return query<BaselineItemRow>(
    "select * from baseline_items where baseline_session_id = $1 order by position asc",
    [sessionId],
  );
}

export async function getBaselineItem(id: string): Promise<BaselineItemRow | null> {
  return queryOne<BaselineItemRow>("select * from baseline_items where id = $1", [id]);
}

/**
 * `state='active'`, stamping `started_at` the first time only (idempotent re-start no-ops rather
 * than erroring) — CONTRACTS.md §9 intended-query comment for `POST /api/baseline-items/:id/start`.
 */
export async function startBaselineItem(
  client: PoolClient,
  id: string,
): Promise<BaselineItemRow | null> {
  return queryOneWith<BaselineItemRow>(
    client,
    `update baseline_items
        set state = case when state = 'pending' then 'active' else state end,
            started_at = coalesce(started_at, now())
      where id = $1
      returning *`,
    [id],
  );
}

export interface CompleteBaselineItemInput {
  state: BaselineItemState;
  active_ms?: number | null;
}

/**
 * Terminal write for a baseline item (solved / skipped_* / gave_up), stamping `completed_at`.
 * Guarded to only fire from a non-terminal state (`pending`/`active`) — without this, re-skipping
 * (or re-completing) an already-terminal item silently rewrites it, e.g.
 * `skipped_inability -> skipped_preference` with a fresh `completed_at`, confirmed live. Returns
 * `null` (a no-op) once the item is already terminal, same as "row not found".
 *
 * Deliberately does NOT complete the session: a baseline appends its next adaptive item only after
 * the current one resolves, so "every item is terminal" means "ready for the next probe", not
 * "done". `advanceBaseline` owns that decision.
 */
export async function completeBaselineItem(
  client: PoolClient,
  id: string,
  input: CompleteBaselineItemInput,
): Promise<BaselineItemRow | null> {
  return queryOneWith<BaselineItemRow>(
    client,
    `update baseline_items
        set state = $2,
            active_ms = coalesce($3, active_ms),
            completed_at = now()
      where id = $1
        and state in ('pending', 'active')
      returning *`,
    [id, input.state, input.active_ms ?? null],
  );
}

/** Marks a baseline session `completed` (idempotent: only ever transitions from `active`). */
export async function completeBaselineSession(
  client: PoolClient,
  id: string,
): Promise<BaselineSessionRow | null> {
  return queryOneWith<BaselineSessionRow>(
    client,
    `update baseline_sessions set status = 'completed', completed_at = now() where id = $1 and status = 'active' returning *`,
    [id],
  );
}

/** Marks a baseline session `abandoned` (idempotent: only ever transitions from `active`) — used
 * when a fresh baseline is started while one is still open, so `getActiveBaselineSession`'s "most
 * recent active" query never has more than one candidate. */
export async function abandonBaselineSession(
  client: PoolClient,
  id: string,
): Promise<BaselineSessionRow | null> {
  return queryOneWith<BaselineSessionRow>(
    client,
    `update baseline_sessions set status = 'abandoned' where id = $1 and status = 'active' returning *`,
    [id],
  );
}
