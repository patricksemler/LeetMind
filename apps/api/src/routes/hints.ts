import type { FastifyInstance } from "fastify";
import {
  getApprovedProblemVersion,
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
  GiveUpRequest,
  HINT_PENALTY_CAPS,
  HintLevel,
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

      const conceptIds = content.concepts.map((c) => c.id);
      // Not built via `learningEventKey()` from @algolift/shared: that builder's union type only
      // covers 'submission'/'skip'/'diagnostic' idempotency keys (docs/CONTRACTS.md §4.4 lists
      // the same three) and has no 'give_up' case, even though `learning_events.kind` itself does
      // include 'give_up'. Scoped by user+version, `le:`-prefixed to match the existing
      // convention.
      const idempotencyKey = `le:give_up:${userId}:${versionId}`;

      const result = await withTransaction(async (client) => {
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

        const stateRows = await Promise.all(
          conceptIds.map((id) =>
            queryOneWith<UserConceptStateRow>(
              client,
              "select * from user_concept_state where user_id = $1 and concept_id = $2",
              [userId, id],
            ),
          ),
        );
        const stateMap: Record<string, UserConceptStateRow> = {};
        conceptIds.forEach((id, i) => {
          stateMap[id] = stateRows[i] ?? defaultConceptStateRow(userId, id);
        });

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
