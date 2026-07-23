// M3 workout endpoints (docs/CONTRACTS.md §9, PLAN.md §8). Assembly itself is pure and lives in
// `@algolift/learner`'s `assembleWorkout`/`assembleDiagnostic`/`nextDiagnosticStep`; this file's
// job is entirely DB glue: gather candidates + state, call the pure assembler, persist
// transactionally, and (for diagnostics) drive the adaptive one-item-at-a-time loop.
import type { FastifyInstance } from "fastify";
import {
  abandonWorkout,
  completeWorkout,
  completeWorkoutItem,
  getActiveWorkout,
  getConceptStateForUpdate,
  getProblemVersion,
  getWorkout,
  getWorkoutItem,
  insertLearningEvent,
  insertWorkout,
  insertWorkoutItem,
  listWorkoutItems,
  maxWorkoutItemPosition,
  query,
  queryOneWith,
  startWorkoutItem,
  upsertConceptState,
  withTransaction,
  type LearningEventRow,
  type UserConceptStateRow,
  type WorkoutItemRow,
  type WorkoutItemState,
  type WorkoutRow,
} from "@algolift/db";
import {
  CreateWorkoutRequest,
  learningEventKey,
  newId,
  notFound,
  SkipWorkoutItemRequest,
} from "@algolift/shared";
import {
  assembleDiagnostic,
  assembleWorkout,
  nextDiagnosticStep,
  scheduleReview,
  updateConcepts,
  type ConceptChange,
  type ConceptState,
  type DiagnosticHistoryEntry,
  type DiagnosticOutcome,
  type DiagnosticPlanStep,
} from "@algolift/learner";
import type { Deps } from "../deps.js";
import { requireId } from "../server.js";
import {
  findCandidateNear,
  loadConceptStates,
  loadWorkoutCandidatePool,
  parseContent,
  toWorkoutCandidate,
} from "../lib/workoutAssembly.js";

/** Concept clusters probed by a fresh diagnostic, in order — the taxonomy's own `sort_order`
 * (docs/CONTRACTS.md §3 concept seed) already lists foundational concepts first, so the first
 * `DIAGNOSTIC_CLUSTER_COUNT` rows give reasonable breadth without a second hand-picked list. */
const DIAGNOSTIC_CLUSTER_COUNT = 6;
interface WorkoutResponseShape extends WorkoutRow {
  items: WorkoutItemRow[];
}

function toWorkoutResponse(workout: WorkoutRow, items: WorkoutItemRow[]): WorkoutResponseShape {
  return { ...workout, items };
}

/** Problem version ids from this user's recent workouts (any state — including skipped/abandoned
 * items, which `listApprovedUnattempted` would otherwise happily re-offer since no `submission`
 * was ever recorded against them). Capped at ~5 workouts' worth of items, most recent first. */
async function recentProblemIds(userId: string): Promise<string[]> {
  const rows = await query<{ problem_version_id: string }>(
    `select wi.problem_version_id
       from workout_items wi
       join workouts w on w.id = wi.workout_id
      where w.user_id = $1
      order by w.created_at desc, wi.position asc
      limit 200`,
    [userId],
  );
  return rows.map((r) => r.problem_version_id);
}

/**
 * Writes an `inability` skip's mastery consequence — CONTRACTS.md §8: outcome 0 at evidenceWeight
 * 0.5 (lowers the estimate AND the uncertainty, never a demoralizing forced failure), idempotent
 * on `learningEventKey({kind:'skip', workoutItemId})`. Mirrors the give-up route's shape
 * (routes/hints.ts) exactly, including "second call returns the first call's own result".
 */
async function applyInabilitySkip(
  userId: string,
  item: WorkoutItemRow,
  activeMs: number,
  correlationId: string | undefined,
): Promise<{ changes: ConceptChange[]; outcome: number; explanation: string }> {
  const versionRow = await getProblemVersion(item.problem_version_id);
  if (!versionRow) {
    // Problem row vanished (shouldn't happen — FK integrity), but never throw on a skip.
    return { changes: [], outcome: 0, explanation: "" };
  }
  const content = parseContent(versionRow);
  const conceptIds = content.concepts.map((c) => c.id);
  const idempotencyKey = learningEventKey({ kind: "skip", workoutItemId: item.id });

  return withTransaction(async (client) => {
    const existing = await queryOneWith<LearningEventRow>(
      client,
      "select * from learning_events where idempotency_key = $1",
      [idempotencyKey],
    );
    if (existing) {
      const evidence = existing.evidence as { changes?: ConceptChange[]; explanation?: string };
      return { changes: evidence?.changes ?? [], explanation: evidence?.explanation ?? "", outcome: existing.outcome };
    }

    // Row-locked and in a globally consistent sorted order — see getConceptStateForUpdate's doc
    // comment (@algolift/db): the same read-modify-write-without-a-lock shape caused a confirmed-
    // live mastery lost-update race elsewhere (QA-PLAN.md §2.2).
    const stateMap: Record<string, UserConceptStateRow> = {};
    for (const id of [...conceptIds].sort()) {
      stateMap[id] = (await getConceptStateForUpdate(client, userId, id)) ?? {
        user_id: userId,
        concept_id: id,
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

    const beforeSnapshot = Object.fromEntries(
      Object.entries(stateMap).map(([id, s]) => [id, { rating: s.rating, uncertainty: s.uncertainty }]),
    );

    const weights = content.concepts.map((c) => ({ id: c.id, weight: c.weight }));
    const update = updateConcepts({
      states: stateMap,
      weights,
      problemRating: content.difficulty.rating,
      outcome: 0,
      evidenceWeight: 0.5,
    });

    const primaryConceptId = content.concepts.find((c) => c.role === "primary")?.id ?? weights[0]?.id;
    const now = new Date();
    for (const change of update.changes) {
      const old = stateMap[change.concept_id];
      if (!old) continue;
      const isPrimary = change.concept_id === primaryConceptId;
      const review = isPrimary ? scheduleReview(old as unknown as ConceptState, 0, now) : null;
      const newState: UserConceptStateRow = {
        ...old,
        rating: change.after_rating,
        uncertainty: change.after_uncertainty,
        attempts: old.attempts + 1,
        skips: old.skips + 1,
        current_streak: 0,
        total_active_ms: old.total_active_ms + activeMs,
        last_practiced_at: now,
        next_review_at: review ? review.next_review_at : old.next_review_at,
        review_interval_days: review ? review.review_interval_days : old.review_interval_days,
        review_ease: review ? review.review_ease : old.review_ease,
        review_reps: review ? review.review_reps : old.review_reps,
      };
      await upsertConceptState(client, newState);
      stateMap[change.concept_id] = newState;
    }

    const afterSnapshot = Object.fromEntries(
      Object.entries(stateMap).map(([id, s]) => [id, { rating: s.rating, uncertainty: s.uncertainty }]),
    );

    await insertLearningEvent(client, {
      id: newId(),
      user_id: userId,
      problem_version_id: item.problem_version_id,
      submission_id: null,
      kind: "skip",
      outcome: 0,
      evidence: { changes: update.changes, explanation: update.explanation, expected: update.expected },
      before_state: beforeSnapshot,
      after_state: afterSnapshot,
      idempotency_key: idempotencyKey,
      correlation_id: correlationId,
    });

    return { changes: update.changes, explanation: update.explanation, outcome: 0 };
  });
}

// --- diagnostic adaptive stepping ---------------------------------------------------------------

function diagnosticOutcomeOf(state: WorkoutItemState): DiagnosticOutcome | null {
  switch (state) {
    case "solved":
      return "solved";
    case "skipped_inability":
    case "skipped_preference":
      return "skipped";
    case "gave_up":
      return "failed";
    default:
      return null; // pending/active: not resolved yet
  }
}

/**
 * If `workout` is an active diagnostic whose current items are all resolved and the plan isn't
 * exhausted, resolves the next `nextDiagnosticStep` target against the approved pool and appends
 * a new `workout_item` (skipping past any plan step the pool can't fill, rather than getting
 * stuck). Marks the workout `completed` once the plan is exhausted or no candidate can be found
 * for any remaining step. Returns the up-to-date item list either way. This is the mechanism that
 * makes the diagnostic "one item at a time" (PLAN.md §8) without a dedicated "next item" endpoint:
 * the web client already refetches `GET /api/workouts/current` after every skip/solve.
 */
async function advanceDiagnosticIfNeeded(userId: string, workout: WorkoutRow, items: WorkoutItemRow[]): Promise<WorkoutItemRow[]> {
  if (workout.kind !== "diagnostic" || workout.status !== "active") return items;
  if (items.some((i) => i.state === "pending" || i.state === "active")) return items;

  const plan = (workout.rationale as { plan?: DiagnosticPlanStep[] }).plan ?? [];
  if (plan.length === 0) {
    await withTransaction((client) => completeWorkout(client, workout.id));
    return items;
  }

  const history: DiagnosticHistoryEntry[] = items
    .map((item) => {
      const evidence = item.selection_evidence as { concept_id?: string; target_rating?: number };
      const outcome = diagnosticOutcomeOf(item.state);
      if (!evidence.concept_id || evidence.target_rating === undefined || !outcome) return null;
      return { concept_id: evidence.concept_id, target_rating: evidence.target_rating, outcome };
    })
    .filter((h): h is DiagnosticHistoryEntry => h !== null);

  const excludeIds = new Set(items.map((i) => i.problem_version_id));
  let workingHistory = history;

  for (let attempt = 0; attempt < plan.length; attempt += 1) {
    const step = nextDiagnosticStep(plan, workingHistory);
    if (step.done || !step.concept_id) {
      await withTransaction((client) => completeWorkout(client, workout.id));
      return items;
    }

    const candidateRow = await findCandidateNear(userId, step.concept_id, step.target_rating, excludeIds);
    if (!candidateRow) {
      // Pool can't fill this step — treat it as an implicit skip and try the next plan concept,
      // rather than stalling the whole diagnostic on one thin concept.
      workingHistory = [...workingHistory, { concept_id: step.concept_id, target_rating: step.target_rating, outcome: "skipped" }];
      continue;
    }

    const candidate = toWorkoutCandidate(candidateRow);
    const position = (await maxWorkoutItemPosition(workout.id)) + 1;
    const newItem = await withTransaction((client) =>
      insertWorkoutItem(client, {
        id: newId(),
        workout_id: workout.id,
        position,
        role: "diagnostic",
        problem_version_id: candidateRow.id,
        rationale: step.rationale,
        selection_evidence: {
          concept_id: step.concept_id,
          target_rating: step.target_rating,
          difficulty_rating: candidateRow.difficulty_rating,
          expected_active_minutes: candidate?.expected_active_minutes,
          title: candidate?.title,
        },
      }),
    );
    return [...items, newItem];
  }

  // Every remaining plan concept was unfillable — end the diagnostic with whatever we have.
  await withTransaction((client) => completeWorkout(client, workout.id));
  return items;
}

export function registerWorkoutRoutes(fastify: FastifyInstance, deps: Deps): void {
  const userId = deps.config.singleUserId;

  // POST /api/workouts — assemble a new workout for the single user.
  fastify.post("/api/workouts", async (request, reply) => {
    const body = CreateWorkoutRequest.parse(request.body ?? {});
    const correlationId = request.correlationId;

    const [states, pool, recent, existingActive] = await Promise.all([
      loadConceptStates(userId),
      loadWorkoutCandidatePool(userId, { conceptId: body.focus_concept }),
      recentProblemIds(userId),
      getActiveWorkout(userId),
    ]);

    const assembled = assembleWorkout({
      candidates: pool,
      states,
      now: new Date(),
      targetMinutes: body.target_minutes,
      focusConcept: body.focus_concept,
      recentProblemIds: recent,
    });

    const { workout, items } = await withTransaction(async (client) => {
      if (existingActive) await abandonWorkout(client, existingActive.id);

      const workoutRow = await insertWorkout(client, {
        id: newId(),
        user_id: userId,
        kind: body.kind ?? "standard",
        rationale: { summary: assembled.rationale },
        estimated_minutes: assembled.estimated_minutes,
        target_minutes: body.target_minutes ?? null,
      });

      const itemRows: WorkoutItemRow[] = [];
      for (const [i, item] of assembled.items.entries()) {
        itemRows.push(
          await insertWorkoutItem(client, {
            id: newId(),
            workout_id: workoutRow.id,
            position: i,
            role: item.role,
            problem_version_id: item.problem_version_id,
            rationale: item.rationale,
            selection_evidence: item.selection_evidence,
          }),
        );
      }
      return { workout: workoutRow, items: itemRows };
    });

    void correlationId; // reserved: no workout-level correlation_id column exists to stamp yet.
    reply.status(201).send({ workout: toWorkoutResponse(workout, items) });
  });

  // GET /api/workouts/current — the single user's most recent active workout, with items, or
  // `{ workout: null }`. For an active diagnostic whose current items are all resolved, this is
  // also where the next adaptive item gets appended (see advanceDiagnosticIfNeeded).
  fastify.get("/api/workouts/current", async (_request, reply) => {
    const workout = await getActiveWorkout(userId);
    if (!workout) {
      reply.send({ workout: null });
      return;
    }

    let items = await listWorkoutItems(workout.id);
    items = await advanceDiagnosticIfNeeded(userId, workout, items);
    // The workout row itself may have just flipped to 'completed' inside advanceDiagnosticIfNeeded
    // — re-read by id so the response reflects that rather than the now-stale in-memory copy.
    const finalWorkout = (await getWorkout(workout.id)) ?? workout;

    reply.send({ workout: toWorkoutResponse(finalWorkout, items) });
  });

  // POST /api/workout-items/:id/start — set state='active', started_at=now() (idempotent no-op if
  // already active/beyond).
  fastify.post<{ Params: { id: string } }>("/api/workout-items/:id/start", async (request, reply) => {
    const id = requireId(request.params.id);
    const existing = await getWorkoutItem(id);
    if (!existing) throw notFound("Workout item not found");

    const item = await withTransaction((client) => startWorkoutItem(client, id));
    reply.send({ item: item ?? existing });
  });

  // POST /api/workout-items/:id/skip — reason='inability' writes the mastery consequence
  // (outcomeScore skip semantics, CONTRACTS.md §8); reason='preference' writes no learning event
  // at all. Never conflated (see applyInabilitySkip's doc comment).
  fastify.post<{ Params: { id: string } }>("/api/workout-items/:id/skip", async (request, reply) => {
    const id = requireId(request.params.id);
    const body = SkipWorkoutItemRequest.parse(request.body ?? {});
    const correlationId = request.correlationId;

    const existing = await getWorkoutItem(id);
    if (!existing) throw notFound("Workout item not found");

    if (body.reason === "preference") {
      const item = await withTransaction((client) =>
        completeWorkoutItem(client, id, { state: "skipped_preference", active_ms: body.active_ms ?? null }),
      );
      reply.send({ item: item ?? existing });
      return;
    }

    const masteryChange = await applyInabilitySkip(userId, existing, body.active_ms ?? 0, correlationId);
    const item = await withTransaction((client) =>
      completeWorkoutItem(client, id, { state: "skipped_inability", active_ms: body.active_ms ?? null }),
    );

    reply.send({
      item: item ?? existing,
      mastery_change: {
        changes: masteryChange.changes,
        outcome: masteryChange.outcome,
        explanation: masteryChange.explanation,
      },
    });
  });

  // POST /api/diagnostic/start — create a kind='diagnostic' workout, seeding only the first
  // resolvable item; subsequent items are chosen adaptively (see advanceDiagnosticIfNeeded, driven
  // from GET /api/workouts/current) rather than fixed up front (PLAN.md §8).
  fastify.post("/api/diagnostic/start", async (_request, reply) => {
    const [states, conceptRows, existingActive] = await Promise.all([
      loadConceptStates(userId),
      query<{ id: string }>("select id from concepts order by sort_order asc, id asc limit $1", [DIAGNOSTIC_CLUSTER_COUNT]),
      getActiveWorkout(userId),
    ]);

    const conceptIds = conceptRows.map((c) => c.id);
    const plan = assembleDiagnostic({ concepts: conceptIds, states, now: new Date() });

    const excludeIds = new Set<string>();
    let firstItem: { candidateRow: Awaited<ReturnType<typeof findCandidateNear>>; step: DiagnosticPlanStep } | null = null;
    let history: DiagnosticHistoryEntry[] = [];

    for (let attempt = 0; attempt < plan.steps.length; attempt += 1) {
      const step = nextDiagnosticStep(plan.steps, history);
      if (step.done || !step.concept_id) break;
      const candidateRow = await findCandidateNear(userId, step.concept_id, step.target_rating, excludeIds);
      if (candidateRow) {
        firstItem = { candidateRow, step: { concept_id: step.concept_id, target_rating: step.target_rating, rationale: step.rationale } };
        break;
      }
      history = [...history, { concept_id: step.concept_id, target_rating: step.target_rating, outcome: "skipped" }];
    }

    const workout = await withTransaction(async (client) => {
      if (existingActive) await abandonWorkout(client, existingActive.id);

      const workoutRow = await insertWorkout(client, {
        id: newId(),
        user_id: userId,
        kind: "diagnostic",
        rationale: { summary: plan.rationale, plan: plan.steps },
        estimated_minutes: null,
        target_minutes: null,
      });

      if (firstItem) {
        const candidate = toWorkoutCandidate(firstItem.candidateRow!);
        await insertWorkoutItem(client, {
          id: newId(),
          workout_id: workoutRow.id,
          position: 0,
          role: "diagnostic",
          problem_version_id: firstItem.candidateRow!.id,
          rationale: firstItem.step.rationale,
          selection_evidence: {
            concept_id: firstItem.step.concept_id,
            target_rating: firstItem.step.target_rating,
            difficulty_rating: firstItem.candidateRow!.difficulty_rating,
            expected_active_minutes: candidate?.expected_active_minutes,
            title: candidate?.title,
          },
        });
      } else {
        // No candidate anywhere in the whole plan — an (almost certainly dev-time) empty pool.
        // Never fabricate an item; the workout is created but immediately has nothing to do.
        await completeWorkout(client, workoutRow.id);
      }

      return workoutRow;
    });

    const items = await listWorkoutItems(workout.id);
    const finalWorkout = (await getWorkout(workout.id)) ?? workout;
    reply.status(201).send({ workout: toWorkoutResponse(finalWorkout, items) });
  });
}
