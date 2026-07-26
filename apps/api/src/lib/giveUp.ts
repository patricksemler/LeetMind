// The row-locked mastery-update transaction body behind `POST /api/problems/:versionId/give-up`
// (routes/hints.ts). Pulled out so the mastery math is testable without booting Fastify, but the
// caller is still responsible for running this INSIDE the same `withTransaction` it always ran in
// — the row-lock ordering below only holds if nothing else in that transaction touches
// `user_concept_state` for this user first.
import type { PoolClient } from "pg";
import {
  getConceptStateForUpdate,
  insertHintEvent,
  insertLearningEvent,
  queryOneWith,
  upsertConceptState,
  type LearningEventRow,
  type UserConceptStateRow,
} from "@leetmind/db";
import { newId } from "@leetmind/shared";
import { scheduleReview, updateConcepts, type ConceptChange } from "@leetmind/learner";
import { defaultConceptStateRow } from "./candidatePool.js";

function snapshotStates(states: Record<string, UserConceptStateRow>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(states).map(([id, s]) => [
      id,
      {
        rating: s.rating,
        uncertainty: s.uncertainty,
        review_interval_days: s.review_interval_days,
        review_ease: s.review_ease,
        review_reps: s.review_reps,
      },
    ]),
  );
}

export interface GiveUpTransactionResult {
  changes: ConceptChange[];
  explanation: string;
  outcome: number;
}

/**
 * Records the editorial reveal and, unless this exact give-up was already recorded (idempotent
 * replay), applies the mastery hit and writes the `give_up` learning event.
 *
 * Must run inside the same transaction/connection the caller already opened: the concept-state
 * read-modify-write below is row-locked (see `getConceptStateForUpdate`'s doc comment,
 * @leetmind/db) and in a globally consistent sorted order — the same read-modify-write-without-a-
 * lock shape that caused the confirmed-live mastery lost-update race elsewhere (QA-PLAN.md §2.2).
 */
export async function runGiveUpTransaction(
  client: PoolClient,
  params: {
    userId: string;
    versionId: string;
    idempotencyKey: string;
    conceptIds: string[];
    weights: { id: string; weight: number }[];
    problemRating: number;
    activeMs: number | null | undefined;
    correlationId?: string;
  },
): Promise<GiveUpTransactionResult> {
  const { userId, versionId, idempotencyKey, conceptIds, weights, problemRating, activeMs, correlationId } = params;

  await insertHintEvent(client, {
    id: newId(),
    user_id: userId,
    problem_version_id: versionId,
    level: "editorial",
  });

  const existing = await queryOneWith<LearningEventRow>(
    client,
    "select * from learning_events where idempotency_key = $1",
    [idempotencyKey],
  );
  if (existing) {
    const evidence = existing.evidence as { changes?: ConceptChange[]; explanation?: string };
    return {
      changes: evidence?.changes ?? [],
      explanation: evidence?.explanation ?? "",
      outcome: existing.outcome,
    };
  }

  // Row-locked (see getConceptStateForUpdate's doc comment, @leetmind/db) and in a globally
  // consistent sorted order — the same read-modify-write-without-a-lock shape that caused
  // the confirmed-live mastery lost-update race elsewhere (QA-PLAN.md §2.2).
  const stateMap: Record<string, UserConceptStateRow> = {};
  for (const id of [...conceptIds].sort()) {
    stateMap[id] = (await getConceptStateForUpdate(client, userId, id)) ?? defaultConceptStateRow(userId, id);
  }

  const beforeSnapshot = snapshotStates(stateMap);

  const update = updateConcepts({
    states: stateMap,
    weights,
    problemRating,
    outcome: 0,
    evidenceWeight: 1,
    highestHint: "editorial",
  });

  const now = new Date();
  for (const change of update.changes) {
    const old = stateMap[change.concept_id];
    if (!old) continue;
    const review = scheduleReview(old, 0, now);
    const newState: UserConceptStateRow = {
      ...old,
      rating: change.after_rating,
      uncertainty: change.after_uncertainty,
      attempts: old.attempts + 1,
      current_streak: 0,
      total_active_ms: old.total_active_ms + (activeMs ?? 0),
      last_practiced_at: now,
      next_review_at: review.next_review_at,
      review_interval_days: review.review_interval_days,
      review_ease: review.review_ease,
      review_reps: review.review_reps,
    };
    await upsertConceptState(client, newState);
    stateMap[change.concept_id] = newState;
  }

  const afterSnapshot = snapshotStates(stateMap);

  await insertLearningEvent(client, {
    id: newId(),
    user_id: userId,
    problem_version_id: versionId,
    submission_id: null,
    kind: "give_up",
    outcome: 0,
    evidence: { changes: update.changes, explanation: update.explanation, expected: update.expected },
    before_state: beforeSnapshot,
    after_state: afterSnapshot,
    idempotency_key: idempotencyKey,
    correlation_id: correlationId,
  });

  return { changes: update.changes, explanation: update.explanation, outcome: 0 };
}
