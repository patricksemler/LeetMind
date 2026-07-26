// Baseline endpoints (docs/CONTRACTS.md §9, PLAN.md §8). Replaces the removed workout routes.
//
// The baseline is the app's whole onboarding: a short adaptive probe across concept clusters whose
// purpose is to seed honest per-concept ratings, with skipping treated as real evidence rather
// than a failure. Planning is pure and lives in `@leetmind/learner` (`assembleBaseline` /
// `nextBaselineStep`); this file is DB glue — resolve the next planned target against the approved
// pool, persist transactionally, and drive the one-item-at-a-time loop.
import type { FastifyInstance } from "fastify";
import {
  abandonBaselineSession,
  completeBaselineItem,
  completeBaselineSession,
  getActiveBaselineSession,
  getBaselineItem,
  getBaselineSession,
  getConceptStateForUpdate,
  getProblemVersion,
  insertBaselineItem,
  insertBaselineSession,
  insertLearningEvent,
  listBaselineItems,
  query,
  queryOneWith,
  queryWith,
  startBaselineItem,
  upsertConceptState,
  withTransaction,
  type BaselineItemRow,
  type BaselineItemState,
  type BaselineSessionRow,
  type LearningEventRow,
  type UserConceptStateRow,
} from "@leetmind/db";
import { learningEventKey, newId, notFound, SkipBaselineItemRequest } from "@leetmind/shared";
import {
  assembleBaseline,
  BASELINE_ITEM_COUNT,
  nextBaselineStep,
  scheduleReview,
  updateConcepts,
  type BaselineHistoryEntry,
  type BaselineOutcome,
  type BaselinePlanStep,
  type ConceptChange,
  type ConceptState,
} from "@leetmind/learner";
import type { Deps } from "../deps.js";
import { requireId } from "../server.js";
import { findCandidateNear, loadConceptStates, parseContent, toPoolCandidate } from "../lib/candidatePool.js";

/** Concept clusters probed by a fresh baseline, in order — the taxonomy's own `sort_order`
 * (docs/CONTRACTS.md §3 concept seed) already lists foundational concepts first, so the first
 * `BASELINE_ITEM_COUNT` rows give reasonable breadth without a second hand-picked list. */
const BASELINE_CLUSTER_COUNT = BASELINE_ITEM_COUNT;

export interface BaselineResponseShape extends BaselineSessionRow {
  items: BaselineItemRow[];
  planned_count: number;
}

function toBaselineResponse(session: BaselineSessionRow, items: BaselineItemRow[]): BaselineResponseShape {
  const plan = (session.rationale as { plan?: BaselinePlanStep[] }).plan ?? [];
  return { ...session, items, planned_count: plan.length };
}

/** Problem version ids from this user's recent baseline sessions (any state — including
 * skipped/abandoned items, which `listApprovedUnattempted` would otherwise happily re-offer since
 * no `submission` was ever recorded against them). */
async function recentBaselineProblemIds(userId: string): Promise<string[]> {
  const rows = await query<{ problem_version_id: string }>(
    `select bi.problem_version_id
       from baseline_items bi
       join baseline_sessions bs on bs.id = bi.baseline_session_id
      where bs.user_id = $1
      order by bs.created_at desc, bi.position asc
      limit 200`,
    [userId],
  );
  return rows.map((r) => r.problem_version_id);
}

/**
 * Writes an `inability` skip's mastery consequence — CONTRACTS.md §8: outcome 0 at evidenceWeight
 * 0.5 (lowers the estimate AND the uncertainty, never a demoralizing forced failure), idempotent
 * on `learningEventKey({kind:'skip', baselineItemId})`. Mirrors the give-up route's shape
 * (routes/hints.ts) exactly, including "second call returns the first call's own result".
 */
async function applyInabilitySkip(
  userId: string,
  item: BaselineItemRow,
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
  const idempotencyKey = learningEventKey({ kind: "skip", baselineItemId: item.id });

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
    // comment (@leetmind/db): the same read-modify-write-without-a-lock shape caused a confirmed-
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

// --- adaptive stepping --------------------------------------------------------------------------

function baselineOutcomeOf(state: BaselineItemState): BaselineOutcome | null {
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
 * If `session` is an active baseline whose current items are all resolved and the plan isn't
 * exhausted, resolves the next `nextBaselineStep` target against the approved pool and appends a
 * new `baseline_item` (skipping past any plan step the pool can't fill, rather than getting
 * stuck). Marks the session `completed` once the plan is exhausted or no candidate can be found
 * for any remaining step. Returns the up-to-date item list either way.
 *
 * This is the mechanism that makes the baseline "one item at a time" (PLAN.md §8) without a
 * dedicated "next item" endpoint: the web client already refetches `GET /api/baseline/current`
 * after every skip/solve.
 */
export async function advanceBaseline(
  userId: string,
  session: BaselineSessionRow,
  items: BaselineItemRow[],
): Promise<BaselineItemRow[]> {
  if (session.status !== "active") return items;
  if (items.some((i) => i.state === "pending" || i.state === "active")) return items;

  const plan = (session.rationale as { plan?: BaselinePlanStep[] }).plan ?? [];
  if (plan.length === 0) {
    await withTransaction((client) => completeBaselineSession(client, session.id));
    return items;
  }

  const history: BaselineHistoryEntry[] = items
    .map((item) => {
      const evidence = item.selection_evidence as { concept_id?: string; target_rating?: number };
      const outcome = baselineOutcomeOf(item.state);
      if (!evidence.concept_id || evidence.target_rating === undefined || !outcome) return null;
      return { concept_id: evidence.concept_id, target_rating: evidence.target_rating, outcome };
    })
    .filter((h): h is BaselineHistoryEntry => h !== null);

  const excludeIds = new Set(items.map((i) => i.problem_version_id));
  let workingHistory = history;

  for (let attempt = 0; attempt < plan.length; attempt += 1) {
    const step = nextBaselineStep(plan, workingHistory);
    if (step.done || !step.concept_id) {
      await withTransaction((client) => completeBaselineSession(client, session.id));
      return items;
    }

    const candidateRow = await findCandidateNear(userId, step.concept_id, step.target_rating, excludeIds);
    if (!candidateRow) {
      // Pool can't fill this step — treat it as an implicit skip and try the next plan concept,
      // rather than stalling the whole baseline on one thin concept.
      workingHistory = [...workingHistory, { concept_id: step.concept_id, target_rating: step.target_rating, outcome: "skipped" }];
      continue;
    }

    const candidate = toPoolCandidate(candidateRow);
    // Lock the session row and re-check inside ONE transaction. Two concurrent GET /current calls
    // on an all-resolved baseline both pass the pending/active gate above, resolve the same step,
    // and compute the same next position — without the lock the loser dies on the
    // (baseline_session_id, position) unique key (a 500), or worse appends a duplicate step. The
    // loser now serializes behind the winner, sees the freshly-appended pending item, and bails.
    const newItem = await withTransaction(async (client) => {
      const locked = await queryOneWith<BaselineSessionRow>(
        client,
        `select id from baseline_sessions where id = $1 and status = 'active' for update`,
        [session.id],
      );
      if (!locked) return null;
      const unresolved = await queryWith<BaselineItemRow>(
        client,
        `select id from baseline_items where baseline_session_id = $1 and state in ('pending', 'active') limit 1`,
        [session.id],
      );
      if (unresolved.length > 0) return null;
      const maxRow = await queryOneWith<{ max: number | null }>(
        client,
        `select max(position) as max from baseline_items where baseline_session_id = $1`,
        [session.id],
      );
      return insertBaselineItem(client, {
        id: newId(),
        baseline_session_id: session.id,
        position: (maxRow?.max ?? -1) + 1,
        problem_version_id: candidateRow.id,
        rationale: step.rationale,
        selection_evidence: {
          concept_id: step.concept_id,
          target_rating: step.target_rating,
          difficulty_rating: candidateRow.difficulty_rating,
          expected_active_minutes: candidate?.expected_active_minutes,
          title: candidate?.title,
        },
      });
    });
    // null: another request appended (or completed the session) first — return the fresh truth.
    if (!newItem) return listBaselineItems(session.id);
    return [...items, newItem];
  }

  // Every remaining plan concept was unfillable — end the baseline with whatever we have.
  await withTransaction((client) => completeBaselineSession(client, session.id));
  return items;
}

export function registerBaselineRoutes(fastify: FastifyInstance, _deps: Deps): void {
  // POST /api/baseline/start — create a baseline session, seeding only the first resolvable item;
  // subsequent items are chosen adaptively (see advanceBaseline, driven from
  // GET /api/baseline/current) rather than fixed up front (PLAN.md §8).
  fastify.post("/api/baseline/start", async (request, reply) => {
    const userId = request.userId;
    const [states, conceptRows, existingActive, recent] = await Promise.all([
      loadConceptStates(userId),
      query<{ id: string }>("select id from concepts order by sort_order asc, id asc limit $1", [BASELINE_CLUSTER_COUNT]),
      getActiveBaselineSession(userId),
      recentBaselineProblemIds(userId),
    ]);

    const conceptIds = conceptRows.map((c) => c.id);
    const plan = assembleBaseline({ concepts: conceptIds, states, now: new Date() });

    // Retaking a baseline should not re-serve the exact problems the previous attempt already
    // showed — otherwise a retake is a memory test, not a probe.
    const excludeIds = new Set<string>(recent);
    let firstItem: { candidateRow: Awaited<ReturnType<typeof findCandidateNear>>; step: BaselinePlanStep } | null = null;
    let history: BaselineHistoryEntry[] = [];

    for (let attempt = 0; attempt < plan.steps.length; attempt += 1) {
      const step = nextBaselineStep(plan.steps, history);
      if (step.done || !step.concept_id) break;
      const candidateRow = await findCandidateNear(userId, step.concept_id, step.target_rating, excludeIds);
      if (candidateRow) {
        firstItem = { candidateRow, step: { concept_id: step.concept_id, target_rating: step.target_rating, rationale: step.rationale } };
        break;
      }
      history = [...history, { concept_id: step.concept_id, target_rating: step.target_rating, outcome: "skipped" }];
    }

    const session = await withTransaction(async (client) => {
      if (existingActive) await abandonBaselineSession(client, existingActive.id);

      const sessionRow = await insertBaselineSession(client, {
        id: newId(),
        user_id: userId,
        rationale: { summary: plan.rationale, plan: plan.steps },
      });

      if (firstItem) {
        const candidate = toPoolCandidate(firstItem.candidateRow!);
        await insertBaselineItem(client, {
          id: newId(),
          baseline_session_id: sessionRow.id,
          position: 0,
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
        // No candidate anywhere in the whole plan — an unseeded/empty approved pool. Never
        // fabricate an item; the session is created but immediately has nothing to do, and the
        // practice route's generation path is what fills the pool.
        await completeBaselineSession(client, sessionRow.id);
      }

      return sessionRow;
    });

    const items = await listBaselineItems(session.id);
    const finalSession = (await getBaselineSession(session.id)) ?? session;
    reply.status(201).send({ baseline: toBaselineResponse(finalSession, items) });
  });

  // GET /api/baseline/current — this user's active baseline with items, or `{ baseline: null }`.
  // Also where the next adaptive item gets appended (see advanceBaseline).
  fastify.get("/api/baseline/current", async (request, reply) => {
    const userId = request.userId;
    const session = await getActiveBaselineSession(userId);
    if (!session) {
      reply.send({ baseline: null });
      return;
    }

    let items = await listBaselineItems(session.id);
    items = await advanceBaseline(userId, session, items);
    // The session row itself may have just flipped to 'completed' inside advanceBaseline — re-read
    // by id so the response reflects that rather than the now-stale in-memory copy.
    const finalSession = (await getBaselineSession(session.id)) ?? session;

    reply.send({ baseline: toBaselineResponse(finalSession, items) });
  });

  // POST /api/baseline-items/:id/start — state='active', started_at=now() (idempotent no-op if
  // already active/beyond).
  fastify.post<{ Params: { id: string } }>("/api/baseline-items/:id/start", async (request, reply) => {
    const id = requireId(request.params.id);
    const existing = await requireOwnedItem(id, request.userId);

    const item = await withTransaction((client) => startBaselineItem(client, id));
    reply.send({ item: item ?? existing });
  });

  // POST /api/baseline-items/:id/skip — reason='inability' writes the mastery consequence
  // (outcomeScore skip semantics, CONTRACTS.md §8); reason='preference' writes no learning event
  // at all. Never conflated (see applyInabilitySkip's doc comment).
  fastify.post<{ Params: { id: string } }>("/api/baseline-items/:id/skip", async (request, reply) => {
    const id = requireId(request.params.id);
    const body = SkipBaselineItemRequest.parse(request.body ?? {});
    const correlationId = request.correlationId;
    const userId = request.userId;

    const existing = await requireOwnedItem(id, userId);

    if (body.reason === "preference") {
      const item = await withTransaction((client) =>
        completeBaselineItem(client, id, { state: "skipped_preference", active_ms: body.active_ms ?? null }),
      );
      reply.send({ item: item ?? existing });
      return;
    }

    const masteryChange = await applyInabilitySkip(userId, existing, body.active_ms ?? 0, correlationId);
    const item = await withTransaction((client) =>
      completeBaselineItem(client, id, { state: "skipped_inability", active_ms: body.active_ms ?? null }),
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
}

/**
 * Loads a baseline item and asserts it belongs to `userId`. With real accounts, an item id is no
 * longer implicitly the caller's — without this check any signed-in user could start or skip
 * another account's baseline item (and, for an `inability` skip, write a mastery consequence into
 * their concept state). Answers 404 rather than 403 so an id can't be probed for existence.
 */
async function requireOwnedItem(id: string, userId: string): Promise<BaselineItemRow> {
  const item = await getBaselineItem(id);
  if (!item) throw notFound("Baseline item not found");
  const session = await getBaselineSession(item.baseline_session_id);
  if (!session || session.user_id !== userId) throw notFound("Baseline item not found");
  return item;
}
