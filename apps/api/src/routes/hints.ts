import type { FastifyInstance } from "fastify";
import {
  completeWorkoutItem,
  getApprovedProblemVersion,
  getConceptStateForUpdate,
  getWorkoutItem,
  hasInFlightSubmission,
  insertHintEvent,
  insertLearningEvent,
  listHintEvents,
  query,
  queryOneWith,
  upsertConceptState,
  withTransaction,
  type ConceptRow,
  type LearningEventRow,
  type UserConceptStateRow,
} from "@algolift/db";
import {
  badRequest,
  conflict,
  GiveUpRequest,
  HINT_PENALTY_CAPS,
  HintLevel,
  learningEventKey,
  newId,
  notFound,
  ProblemVersionSchema,
  TakeHintRequest,
  type ConceptChange,
} from "@algolift/shared";
import { scheduleReview, updateConcepts } from "@algolift/learner";
import type { Deps } from "../deps.js";
import { requireId } from "../server.js";

/** The rungs reachable through `POST /api/hints`. `editorial` is deliberately excluded — it is
 * only ever taken via `POST /api/problems/:versionId/give-up`, which is the "give up" action, not
 * an incremental hint. */
const HINT_RUNGS = ["l1_orientation", "l2_conceptual", "l3_structural", "outline"] as const;

function penaltiesRecord(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const level of HintLevel.options) out[level] = HINT_PENALTY_CAPS[level];
  return out;
}

function defaultConceptStateRow(userId: string, conceptId: string): UserConceptStateRow {
  return {
    user_id: userId,
    concept_id: conceptId,
    rating: 1200,
    uncertainty: 350,
    attempts: 0,
    solves: 0,
    unassisted_solves: 0,
    skips: 0,
    current_streak: 0,
    best_streak: 0,
    total_active_ms: 0,
    hint_counts: {},
    error_counts: {},
    last_practiced_at: null,
    next_review_at: null,
    review_interval_days: 1,
    review_ease: 2.5,
    review_reps: 0,
    updated_at: new Date(),
  };
}

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

export function registerHintRoutes(fastify: FastifyInstance, deps: Deps): void {
  const userId = deps.config.singleUserId;

  fastify.post("/api/hints", async (request, reply) => {
    const body = TakeHintRequest.parse(request.body);

    if (body.level === "editorial") {
      throw badRequest(
        "The editorial hint is taken via POST /api/problems/:versionId/give-up, not POST /api/hints",
      );
    }

    const versionRow = await getApprovedProblemVersion(body.problem_version_id);
    if (!versionRow) throw notFound("Problem version not found or not approved");
    const content = ProblemVersionSchema.parse(versionRow.content);

    const rungIndex = HINT_RUNGS.indexOf(body.level as (typeof HINT_RUNGS)[number]);
    const hintEvents = await listHintEvents(userId, body.problem_version_id);
    const taken = new Set(hintEvents.map((h) => h.level));

    if (!taken.has(body.level)) {
      for (let i = 0; i < rungIndex; i += 1) {
        const prerequisite = HINT_RUNGS[i];
        if (prerequisite && !taken.has(prerequisite)) {
          throw badRequest(`Hints must be taken in order — take "${prerequisite}" before "${body.level}"`, {
            requested: body.level,
            missing_prerequisite: prerequisite,
          });
        }
      }

      await withTransaction((client) =>
        insertHintEvent(client, {
          id: newId(),
          user_id: userId,
          problem_version_id: body.problem_version_id,
          level: body.level,
        }),
      );
    }

    const nextLevel = HINT_RUNGS[rungIndex + 1] ?? "editorial";

    reply.send({
      level: body.level,
      text: content.hints[body.level],
      penalty_cap: HINT_PENALTY_CAPS[body.level],
      next_level_penalty: HINT_PENALTY_CAPS[nextLevel],
    });
  });

  fastify.get<{ Params: { versionId: string } }>("/api/hints/:versionId", async (request, reply) => {
    const versionId = requireId(request.params.versionId, "versionId");
    const versionRow = await getApprovedProblemVersion(versionId);
    if (!versionRow) throw notFound("Problem version not found or not approved");

    const hintEvents = await listHintEvents(userId, versionId);
    const taken = hintEvents.map((h) => h.level);
    const nextRung = HINT_RUNGS.find((l) => !taken.includes(l));

    reply.send({
      taken,
      available: nextRung ? [nextRung] : [],
      penalties: penaltiesRecord(),
    });
  });

  fastify.post<{ Params: { versionId: string } }>(
    "/api/problems/:versionId/give-up",
    async (request, reply) => {
      const versionId = requireId(request.params.versionId, "versionId");
      const body = GiveUpRequest.parse(request.body ?? {});
      const correlationId = request.correlationId;

      const versionRow = await getApprovedProblemVersion(versionId);
      if (!versionRow) throw notFound("Problem version not found or not approved");
      const content = ProblemVersionSchema.parse(versionRow.content);

      // Reject a give-up while a judge job is in flight for this problem version (409): without
      // this, a give-up racing an in-flight accept applies mastery consequences in both
      // directions for the same evidence — confirmed live (solve +7.4, give-up -12.6, correct
      // resubmit -11.8, every time).
      if (await hasInFlightSubmission(userId, versionId)) {
        throw conflict("A submission for this problem is still being judged — wait for it to finish before giving up.");
      }

      const conceptIds = content.concepts.map((c) => c.id);
      const idempotencyKey = learningEventKey({ kind: "give_up", userId, problemVersionId: versionId });

      if (body.workout_item_id) {
        const item = await getWorkoutItem(body.workout_item_id);
        if (!item) throw notFound("Workout item not found");
      }

      const result = await withTransaction(async (client) => {
        await insertHintEvent(client, {
          id: newId(),
          user_id: userId,
          problem_version_id: versionId,
          level: "editorial",
        });

        // Completes the item even on an idempotent replay — `completeWorkoutItem` no-ops once
        // already terminal, so this is safe to call unconditionally. Previously `workout_item_id`
        // was parsed and never used at all: the item never reached `gave_up`, which meant the
        // diagnostic's pending-items guard could never pass and the flow stalled permanently
        // (confirmed live).
        if (body.workout_item_id) {
          await completeWorkoutItem(client, body.workout_item_id, {
            state: "gave_up",
            active_ms: body.active_ms ?? null,
          });
        }

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

        // Row-locked (see getConceptStateForUpdate's doc comment, @algolift/db) and in a globally
        // consistent sorted order — the same read-modify-write-without-a-lock shape that caused
        // the confirmed-live mastery lost-update race elsewhere (QA-PLAN.md §2.2).
        const stateMap: Record<string, UserConceptStateRow> = {};
        for (const id of [...conceptIds].sort()) {
          stateMap[id] = (await getConceptStateForUpdate(client, userId, id)) ?? defaultConceptStateRow(userId, id);
        }

        const beforeSnapshot = snapshotStates(stateMap);
        const weights = content.concepts.map((c) => ({ id: c.id, weight: c.weight }));

        const update = updateConcepts({
          states: stateMap,
          weights,
          problemRating: content.difficulty.rating,
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
            total_active_ms: old.total_active_ms + (body.active_ms ?? 0),
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
      });

      const conceptRows =
        conceptIds.length > 0
          ? await query<ConceptRow>("select * from concepts where id = any($1)", [conceptIds])
          : [];

      reply.send({
        editorial_md: content.hints.editorial_md,
        concepts: conceptRows,
        mastery_change: {
          changes: result.changes,
          outcome: result.outcome,
          explanation: result.explanation,
        },
      });
    },
  );
}
