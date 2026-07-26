/**
 * `scheduled_followups` repository (migration 007) — the reinforce/transfer debts owed after a
 * teaching episode. See `packages/learner/src/teaching.ts` for what the pair is and why both are
 * planned at reveal time.
 */

import type { PoolClient } from "pg";
import { query, queryOneWith, queryWith } from "./pool.js";
import type {
  FollowUpKind,
  ProblemShape,
  ScheduledFollowupRow,
  ShapeMatch,
  TeachingTrigger,
} from "./types.js";

export interface NewFollowupInput {
  id: string;
  user_id: string;
  concept_id: string;
  origin_problem_version_id: string;
  kind: FollowUpKind;
  origin_trigger: TeachingTrigger;
  target_rating: number;
  shape_match: ShapeMatch;
  origin_shape?: ProblemShape | null;
  rationale?: string;
  due_at: Date;
}

/**
 * Inserts one follow-up debt, returning `null` when this (user, origin, kind) already exists.
 *
 * Null-on-conflict rather than throwing, for the same reason `insertLearningEvent` does it: the
 * judge delivers at-least-once, so the transcription handler that queues these can and will run
 * twice for one transcription. The unique constraint is the correctness boundary; this is just the
 * ergonomic surface over it.
 */
export async function insertFollowup(
  client: PoolClient,
  row: NewFollowupInput,
): Promise<ScheduledFollowupRow | null> {
  return queryOneWith<ScheduledFollowupRow>(
    client,
    `insert into scheduled_followups (
       id, user_id, concept_id, origin_problem_version_id, kind, origin_trigger,
       target_rating, shape_match, origin_shape, rationale, due_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (user_id, origin_problem_version_id, kind) do nothing
     returning *`,
    [
      row.id,
      row.user_id,
      row.concept_id,
      row.origin_problem_version_id,
      row.kind,
      row.origin_trigger,
      row.target_rating,
      row.shape_match,
      row.origin_shape ?? null,
      row.rationale ?? "",
      row.due_at,
    ],
  );
}

/**
 * The follow-up this user owes right now, or `null`.
 *
 * Ordering is `kind` then `due_at`: `reinforce` sorts before `transfer` alphabetically, which is
 * also the order they should be served — a reinforce is due the instant it is created and is meant
 * to be the very next problem, whereas a transfer sitting due from a previous episode can wait one
 * more problem. Among equals, the oldest debt goes first.
 *
 * An already-served-but-unsatisfied row is returned again with its `served_problem_version_id`
 * intact, so reloading the page re-serves the *same* problem instead of consuming a second one.
 */
export async function dueFollowup(userId: string, now: Date): Promise<ScheduledFollowupRow | null> {
  const rows = await query<ScheduledFollowupRow>(
    `select * from scheduled_followups
      where user_id = $1
        and satisfied_at is null
        and due_at <= $2
      order by kind asc, due_at asc
      limit 1`,
    [userId, now],
  );
  return rows[0] ?? null;
}

/** Every unsettled debt for this user, newest first — for `/api/progress` and `/system`. */
export async function listPendingFollowups(userId: string): Promise<ScheduledFollowupRow[]> {
  return query<ScheduledFollowupRow>(
    `select * from scheduled_followups
      where user_id = $1 and satisfied_at is null
      order by due_at asc`,
    [userId],
  );
}

/** Pins a concrete problem to a debt, so a reload doesn't hand out a different one. No-ops if
 * something already pinned one (last writer would otherwise orphan the first problem). */
export async function markFollowupServed(
  client: PoolClient,
  id: string,
  problemVersionId: string,
): Promise<ScheduledFollowupRow | null> {
  return queryOneWith<ScheduledFollowupRow>(
    client,
    `update scheduled_followups
        set served_problem_version_id = $2, served_at = now()
      where id = $1 and served_problem_version_id is null
      returning *`,
    [id, problemVersionId],
  );
}

/**
 * Settles any debt this problem was serving.
 *
 * Settled by *attempt*, not by success: a failed transfer answers the question the transfer was
 * asked to answer ("did the teaching stick?") just as informatively as a passed one, and re-owing
 * it on failure would trap a struggling user in an unbounded loop of the same debt. The mastery
 * model is what carries the consequence of the failure; this table only tracks that the question
 * was put.
 */
export async function satisfyFollowupsForProblem(
  client: PoolClient,
  userId: string,
  problemVersionId: string,
): Promise<ScheduledFollowupRow[]> {
  return queryWith<ScheduledFollowupRow>(
    client,
    `update scheduled_followups
        set satisfied_at = now()
      where user_id = $1
        and served_problem_version_id = $2
        and satisfied_at is null
      returning *`,
    [userId, problemVersionId],
  );
}
