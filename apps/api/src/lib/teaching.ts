/**
 * DB glue for teaching mode. The decision itself is pure and lives in
 * `@leetmind/learner` (`shouldTeach` / `planFollowUps`); this file loads what those functions need
 * and persists what they produce.
 *
 * The one design decision worth stating here is how a teaching episode is *tracked*, because the
 * obvious answer — a `teaching_episodes` table with a status column — is the wrong one.
 *
 * An episode is instead **derived** from two facts already recorded for other reasons:
 *   1. the `scheduled_followups` rows written when the editorial was revealed, and
 *   2. whether an accepted `transcribe` submission exists for that problem.
 *
 * Open episode = (1) and not (2). This keeps the practice loop stateless in the way the rest of the
 * app already is — nothing to start, nothing to abandon, nothing to leave dangling if the user
 * closes the tab mid-episode — and it makes the "you must write it out before moving on" rule
 * server-authoritative for free: reloading the page re-derives the same open episode rather than
 * skipping past it.
 *
 * It also gives the cutover for free. Give-ups from before migration 007 have no follow-up rows, so
 * they are not retroactively open episodes demanding transcription of a problem the user finished
 * with weeks ago.
 */

import {
  insertFollowup,
  markFollowupServed,
  query,
  withTransaction,
  type ProblemShape,
  type ProblemVersionRow,
  type ScheduledFollowupRow,
  type TeachingTrigger,
} from "@leetmind/db";
import { newId } from "@leetmind/shared";
import {
  planFollowUps,
  shouldTeach,
  type TeachingAttempt,
  type TeachingDecision,
} from "@leetmind/learner";
import { findCandidateNear } from "./candidatePool.js";

/** How far back `shouldTeach` looks. It only ever reads the first `TEACHING_FAILURE_STREAK`
 * entries, so anything beyond a handful is wasted I/O. */
const RECENT_ATTEMPT_LIMIT = 5;

/**
 * This user's resolved attempts on `conceptId`, newest first, in the shape `shouldTeach` wants.
 *
 * Attributed by the problem's **primary** concept only. A problem that touches `two_pointers` at
 * weight 0.2 says almost nothing about whether the user needs to be taught two pointers, and
 * counting it would let two failures on unrelated problems trigger a teaching episode on a concept
 * neither of them was really about.
 */
export async function recentAttemptsForConcept(
  userId: string,
  conceptId: string,
): Promise<TeachingAttempt[]> {
  const rows = await query<{
    problem_version_id: string;
    kind: string;
    outcome: number;
    used_editorial: boolean;
  }>(
    `select le.problem_version_id,
            le.kind,
            le.outcome,
            exists (
              select 1 from hint_events he
               where he.user_id = le.user_id
                 and he.problem_version_id = le.problem_version_id
                 and he.level = 'editorial'
            ) as used_editorial
       from learning_events le
       join problem_concepts pc
         on pc.problem_version_id = le.problem_version_id
        and pc.role = 'primary'
      where le.user_id = $1
        and pc.concept_id = $2
        and le.kind in ('submission', 'give_up', 'skip')
      order by le.created_at desc
      limit $3`,
    [userId, conceptId, RECENT_ATTEMPT_LIMIT],
  );

  return rows.map((r) => ({
    concept_id: conceptId,
    // A `submission` event only reaches `learning_events` when it was substantive, so any positive
    // outcome means real progress was made. Give-ups and skips are written at outcome 0 and so
    // fall out here without needing to be special-cased by kind.
    solved: r.kind === "submission" && r.outcome > 0.2,
    usedEditorial: r.used_editorial,
  }));
}

export interface OpenEpisode {
  problem_version_id: string;
  trigger: TeachingTrigger;
  reason: string;
  /** Always false — an episode stops being open the moment this would be true. Carried so the
   * response shape does not have to special-case it. */
  transcribed: false;
}

/**
 * The teaching episode this user still owes a transcription for, or `null`.
 *
 * Ordered newest-first and limited to one: episodes are strictly sequential, because an open one
 * blocks practice from serving anything else.
 */
export async function openTeachingEpisode(userId: string): Promise<OpenEpisode | null> {
  const rows = await query<{
    origin_problem_version_id: string;
    origin_trigger: TeachingTrigger;
    rationale: string;
    created_at: Date;
  }>(
    `select sf.origin_problem_version_id,
            min(sf.origin_trigger) as origin_trigger,
            min(sf.created_at) as created_at
       from scheduled_followups sf
      where sf.user_id = $1
        and not exists (
          select 1 from submissions s
           where s.user_id = sf.user_id
             and s.problem_version_id = sf.origin_problem_version_id
             and s.mode = 'transcribe'
             and s.verdict = 'accepted'
        )
      group by sf.origin_problem_version_id
      order by created_at desc
      limit 1`,
    [userId],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    problem_version_id: row.origin_problem_version_id,
    trigger: row.origin_trigger,
    reason:
      row.origin_trigger === "editorial_revealed"
        ? "You needed the full solution for that one — type it out yourself before moving on."
        : "Two in a row on this concept, so here it is worked through. Type it out yourself before moving on.",
    transcribed: false,
  };
}

/** Whether the *next* problem on this concept should be taught from the start. */
export async function shouldTeachConcept(
  userId: string,
  conceptId: string,
): Promise<TeachingDecision> {
  return shouldTeach(await recentAttemptsForConcept(userId, conceptId));
}

/**
 * Records the reinforce/transfer debts owed by a teaching episode on `problemVersionId`.
 *
 * Idempotent through `scheduled_followups`' `(user_id, origin_problem_version_id, kind)` unique
 * key, so both entry points — a give-up and an explicit `POST /teach` — can call it without
 * checking whether the other already did.
 */
export async function queueFollowUps(input: {
  userId: string;
  conceptId: string;
  problemVersionId: string;
  problemRating: number;
  originShape: ProblemShape | null;
  trigger: TeachingTrigger;
  now?: Date;
}): Promise<ScheduledFollowupRow[]> {
  const now = input.now ?? new Date();
  const plans = planFollowUps({
    conceptId: input.conceptId,
    originRating: input.problemRating,
    now,
  });

  return withTransaction(async (client) => {
    const written: ScheduledFollowupRow[] = [];
    for (const plan of plans) {
      const row = await insertFollowup(client, {
        id: newId(),
        user_id: input.userId,
        concept_id: plan.concept_id,
        origin_problem_version_id: input.problemVersionId,
        kind: plan.kind,
        origin_trigger: input.trigger,
        target_rating: plan.target_rating,
        shape_match: plan.shape_match,
        origin_shape: input.originShape,
        rationale: plan.rationale,
        due_at: plan.due_at,
      });
      if (row) written.push(row);
    }
    return written;
  });
}

/**
 * Turns a follow-up debt into a real problem to serve, pinning it so a reload does not consume a
 * second one.
 *
 * Returns `null` when the pool holds nothing suitable — the caller treats that exactly like any
 * other empty band and commissions generation rather than dropping the debt.
 */
export async function resolveFollowupProblem(
  userId: string,
  followup: ScheduledFollowupRow,
  lookup: (id: string) => Promise<ProblemVersionRow | null>,
): Promise<ProblemVersionRow | null> {
  // Already pinned by an earlier request — serve the same problem again rather than a new one.
  if (followup.served_problem_version_id) {
    return lookup(followup.served_problem_version_id);
  }

  const candidate = await findCandidateNear(
    userId,
    followup.concept_id,
    followup.target_rating,
    // Never re-serve the problem that was taught, whatever the shape rules allow.
    new Set([followup.origin_problem_version_id]),
    followup.origin_shape
      ? { shape: followup.origin_shape, matchShape: followup.shape_match }
      : undefined,
  );
  if (!candidate) return null;

  await withTransaction((client) => markFollowupServed(client, followup.id, candidate.id));
  return candidate;
}
