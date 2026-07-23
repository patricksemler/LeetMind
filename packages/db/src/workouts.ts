// Query helpers for `workouts` / `workout_items` — M3 (CONTRACTS.md §3, §9). New file; does not
// touch any other repo's existing exports.
import type { PoolClient } from "pg";
import { query, queryOne, queryOneWith } from "./pool.js";
import type { WorkoutItemRole, WorkoutItemRow, WorkoutItemState, WorkoutKind, WorkoutRow } from "./types.js";

export interface NewWorkoutInput {
  id: string;
  user_id: string;
  kind?: WorkoutKind;
  rationale?: Record<string, unknown>;
  estimated_minutes?: number | null;
  target_minutes?: number | null;
}

export async function insertWorkout(client: PoolClient, row: NewWorkoutInput): Promise<WorkoutRow> {
  const sql = `
    insert into workouts (id, user_id, kind, rationale, estimated_minutes, target_minutes)
    values ($1, $2, $3, $4, $5, $6)
    returning *
  `;
  const inserted = await queryOneWith<WorkoutRow>(client, sql, [
    row.id,
    row.user_id,
    row.kind ?? "standard",
    JSON.stringify(row.rationale ?? {}),
    row.estimated_minutes ?? null,
    row.target_minutes ?? null,
  ]);
  if (!inserted) {
    throw new Error(`insertWorkout: insert of ${row.id} returned no row`);
  }
  return inserted;
}

export interface NewWorkoutItemInput {
  id: string;
  workout_id: string;
  position: number;
  role: WorkoutItemRole;
  problem_version_id: string;
  rationale?: string;
  selection_evidence?: Record<string, unknown>;
}

export async function insertWorkoutItem(client: PoolClient, row: NewWorkoutItemInput): Promise<WorkoutItemRow> {
  const sql = `
    insert into workout_items (id, workout_id, position, role, problem_version_id, rationale, selection_evidence)
    values ($1, $2, $3, $4, $5, $6, $7)
    returning *
  `;
  const inserted = await queryOneWith<WorkoutItemRow>(client, sql, [
    row.id,
    row.workout_id,
    row.position,
    row.role,
    row.problem_version_id,
    row.rationale ?? "",
    JSON.stringify(row.selection_evidence ?? {}),
  ]);
  if (!inserted) {
    throw new Error(`insertWorkoutItem: insert of ${row.id} returned no row`);
  }
  return inserted;
}

/** The single user's most recent `status='active'` workout, or `null`. */
export async function getActiveWorkout(userId: string): Promise<WorkoutRow | null> {
  return queryOne<WorkoutRow>(
    `select * from workouts where user_id = $1 and status = 'active' order by created_at desc limit 1`,
    [userId],
  );
}

export async function getWorkout(id: string): Promise<WorkoutRow | null> {
  return queryOne<WorkoutRow>("select * from workouts where id = $1", [id]);
}

export async function listWorkoutItems(workoutId: string): Promise<WorkoutItemRow[]> {
  return query<WorkoutItemRow>(
    "select * from workout_items where workout_id = $1 order by position asc",
    [workoutId],
  );
}

export async function getWorkoutItem(id: string): Promise<WorkoutItemRow | null> {
  return queryOne<WorkoutItemRow>("select * from workout_items where id = $1", [id]);
}

export async function listRecentWorkouts(userId: string, limit: number): Promise<WorkoutRow[]> {
  return query<WorkoutRow>(
    "select * from workouts where user_id = $1 order by created_at desc limit $2",
    [userId, limit],
  );
}

/** Highest `position` currently used by a workout's items — callers appending an adaptively-chosen
 * next diagnostic item use this + 1. */
export async function maxWorkoutItemPosition(workoutId: string): Promise<number> {
  const row = await queryOne<{ max: number | null }>(
    "select max(position) as max from workout_items where workout_id = $1",
    [workoutId],
  );
  return row?.max ?? -1;
}

/**
 * `state='active'`, stamping `started_at` the first time only (idempotent re-start no-ops rather
 * than erroring) — CONTRACTS.md §9 intended-query comment for `POST /api/workout-items/:id/start`.
 */
export async function startWorkoutItem(client: PoolClient, id: string): Promise<WorkoutItemRow | null> {
  return queryOneWith<WorkoutItemRow>(
    client,
    `update workout_items
        set state = case when state = 'pending' then 'active' else state end,
            started_at = coalesce(started_at, now())
      where id = $1
      returning *`,
    [id],
  );
}

export interface CompleteWorkoutItemInput {
  state: WorkoutItemState;
  active_ms?: number | null;
}

/**
 * Terminal write for a workout item (solved / skipped_* / gave_up), stamping `completed_at`.
 * Guarded to only fire from a non-terminal state (`pending`/`active`) — without this, re-skipping
 * (or re-completing) an already-terminal item silently rewrites it, e.g.
 * `skipped_inability -> skipped_preference` with a fresh `completed_at`, confirmed live. Returns
 * `null` (a no-op) once the item is already terminal, same as "row not found".
 */
export async function completeWorkoutItem(
  client: PoolClient,
  id: string,
  input: CompleteWorkoutItemInput,
): Promise<WorkoutItemRow | null> {
  return queryOneWith<WorkoutItemRow>(
    client,
    `update workout_items
        set state = $2,
            active_ms = coalesce($3, active_ms),
            completed_at = now()
      where id = $1
        and state in ('pending', 'active')
      returning *`,
    [id, input.state, input.active_ms ?? null],
  );
}

/** Marks a workout `completed` (idempotent: only ever transitions from `active`). Callers decide
 * "done" (e.g. every item resolved and no more adaptive steps remain). */
export async function completeWorkout(client: PoolClient, id: string): Promise<WorkoutRow | null> {
  return queryOneWith<WorkoutRow>(
    client,
    `update workouts set status = 'completed', completed_at = now() where id = $1 and status = 'active' returning *`,
    [id],
  );
}

/** Marks a workout `abandoned` (idempotent: only ever transitions from `active`) — used when a
 * new workout is started while one is already active, so `GET /api/workouts/current`'s "most
 * recent active" query never has more than one candidate. */
export async function abandonWorkout(client: PoolClient, id: string): Promise<WorkoutRow | null> {
  return queryOneWith<WorkoutRow>(
    client,
    `update workouts set status = 'abandoned' where id = $1 and status = 'active' returning *`,
    [id],
  );
}
