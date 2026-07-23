// The learner integration (CONTRACTS.md §8, PLAN.md §7). `applyMastery` is called from
// src/handler.ts for `mode:'submit'` submissions ONLY, inside the SAME transaction that writes
// the terminal verdict — never for `mode:'run'`.
//
// Exactly-once enforcement is STRUCTURAL, not an application-level check: this function attempts
// the `learning_events` insert (guarded by the `idempotency_key = le:<submission_id>` unique
// constraint) BEFORE touching `user_concept_state`. Only a transaction that actually wins the
// insert (gets a non-null row back) goes on to upsert concept state / emit the `mastery` notify.
// A second concurrent/duplicate application gets `null` back from `insertLearningEvent` (Postgres
// `on conflict (idempotency_key) do nothing`) and returns immediately, having written nothing —
// there is no "check if it exists, then decide" race window because the check *is* the write.
import type { PoolClient } from "pg";
import {
  getConceptStateForUpdate,
  insertLearningEvent,
  listHintEvents,
  notify,
  queryWith,
  upsertConceptState,
  type SubmissionRow,
  type UserConceptStateRow,
} from "@algolift/db";
import { learningEventKey, newId, type HintLevel, type ProblemVersion, type Verdict } from "@algolift/shared";
import { outcomeScore, scheduleReview, updateConcepts, type ConceptChange } from "@algolift/learner";

const HINT_LEVEL_ORDER: readonly HintLevel[] = [
  "l1_orientation",
  "l2_conceptual",
  "l3_structural",
  "outline",
  "editorial",
];

function highestHintTaken(levels: HintLevel[]): HintLevel | null {
  let best: HintLevel | null = null;
  let bestIdx = -1;
  for (const level of levels) {
    const idx = HINT_LEVEL_ORDER.indexOf(level);
    if (idx > bestIdx) {
      bestIdx = idx;
      best = level;
    }
  }
  return best;
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
        attempts: s.attempts,
        solves: s.solves,
        unassisted_solves: s.unassisted_solves,
        current_streak: s.current_streak,
        best_streak: s.best_streak,
        total_active_ms: s.total_active_ms,
        hint_counts: s.hint_counts,
        error_counts: s.error_counts,
        review_interval_days: s.review_interval_days,
        review_ease: s.review_ease,
        review_reps: s.review_reps,
        next_review_at: s.next_review_at,
      },
    ]),
  );
}

/** Bookkeeping counters (attempts/solves/streaks/hint_counts/total_active_ms) are owned by the
 * judge — CONTRACTS.md §8 fixes the rating/uncertainty/SM-2 math (owned by @algolift/learner) but
 * leaves these plain counters to whichever caller updates `user_concept_state`. This mirrors the
 * bookkeeping apps/api's give-up route already applies. */
function computeCounterUpdates(
  old: UserConceptStateRow,
  verdict: Verdict,
  highestHint: HintLevel | null,
  activeMs: number,
): Pick<
  UserConceptStateRow,
  "attempts" | "solves" | "unassisted_solves" | "current_streak" | "best_streak" | "hint_counts" | "total_active_ms"
> {
  const solved = verdict === "accepted";
  const attempts = old.attempts + 1;
  const solves = old.solves + (solved ? 1 : 0);
  const unassisted_solves = solved && !highestHint ? old.unassisted_solves + 1 : old.unassisted_solves;
  const current_streak = solved ? old.current_streak + 1 : 0;
  const best_streak = Math.max(old.best_streak, current_streak);
  const hint_counts = { ...old.hint_counts };
  if (highestHint) {
    hint_counts[highestHint] = (hint_counts[highestHint] ?? 0) + 1;
  }
  // `Number(...)` is defence in depth, not superstition. `total_active_ms` is the schema's only
  // bigint, and node-postgres returns bigint as a string unless a type parser is registered
  // (@algolift/db's pool.ts registers one). Without the coercion, a regression in that parser
  // turns this `+` back into string concatenation — which is exactly the bug that previously
  // corrupted this column and dead-lettered judge jobs.
  const total_active_ms = Number(old.total_active_ms) + activeMs;
  return { attempts, solves, unassisted_solves, current_streak, best_streak, hint_counts, total_active_ms };
}

function bumpCompilationErrorCount(old: UserConceptStateRow): Record<string, number> {
  return { ...old.error_counts, compilation: (old.error_counts.compilation ?? 0) + 1 };
}

/** Prior (i.e. strictly-before-this-submission) `submit`-mode, completed submissions for this
 * user x problem version, split by whether they were compile-error-only or "substantive"
 * (actually ran) — CONTRACTS.md §8's inputs to `outcomeScore`. Takes `client` (the same one
 * `applyMastery` is running under) rather than going to the pool, so this read joins the caller's
 * transaction instead of checking out a second connection that couldn't see its uncommitted
 * writes. */
async function countPriorSubmissions(
  client: PoolClient,
  userId: string,
  versionId: string,
  excludeSubmissionId: string,
  kind: "substantive" | "compilation_error",
): Promise<number> {
  const verdictFilter = kind === "compilation_error" ? "verdict = 'compilation_error'" : "verdict is not null and verdict <> 'compilation_error'";
  const rows = await queryWith<{ count: string }>(
    client,
    `select count(*)::text as count from submissions
     where user_id = $1 and problem_version_id = $2 and id <> $3
       and mode = 'submit' and status = 'completed' and ${verdictFilter}`,
    [userId, versionId, excludeSubmissionId],
  );
  return Number(rows[0]?.count ?? 0);
}

export interface ApplyMasteryInput {
  client: PoolClient;
  submission: SubmissionRow;
  content: ProblemVersion;
  verdict: Verdict;
  now?: Date;
}

export interface ApplyMasteryResult {
  /** false when no learning event / concept-state change was written this call — either the
   * outcome was excluded from mastery impact (e.g. a compile error below the recurrence
   * threshold), or a concurrent/duplicate application already won the idempotency race. */
  applied: boolean;
  changes?: ConceptChange[];
  outcome?: number;
  explanation?: string;
}

export async function applyMastery(input: ApplyMasteryInput): Promise<ApplyMasteryResult> {
  const { client, submission, content, verdict } = input;
  const now = input.now ?? new Date();
  const userId = submission.user_id;
  const versionId = submission.problem_version_id;
  const activeMs = submission.active_ms ?? 0;

  const weights = content.concepts.map((c) => ({ id: c.id, weight: c.weight }));
  const conceptIds = weights.map((w) => w.id);
  const primaryConceptId = content.concepts.find((c) => c.role === "primary")?.id ?? weights[0]!.id;

  const hintEvents = await listHintEvents(userId, versionId, client);
  const highestHint = highestHintTaken(hintEvents.map((h) => h.level));

  const priorSubstantive = await countPriorSubmissions(client, userId, versionId, submission.id, "substantive");
  const priorCompileErrors = await countPriorSubmissions(client, userId, versionId, submission.id, "compilation_error");
  const isSubstantive = verdict !== "compilation_error";
  const substantiveSubmissions = priorSubstantive + (isSubstantive ? 1 : 0);
  const compileErrors = priorCompileErrors + (verdict === "compilation_error" ? 1 : 0);

  const outcome = outcomeScore({
    verdict,
    gaveUp: false,
    skipped: null,
    highestHint,
    activeMs,
    expectedMinutes: content.expected_active_minutes,
    substantiveSubmissions,
    compileErrors,
  });

  // Lock rows in a globally consistent order (sorted, not the problem's declared concept order,
  // which can differ between problems that share a concept) — otherwise two concurrent
  // transactions locking the same two concepts in opposite orders can deadlock instead of one
  // simply waiting for the other. Sequential (not `Promise.all`): acquiring locks one at a time,
  // in order, is what makes the ordering guarantee actually hold.
  const lockOrder = [...conceptIds].sort();
  const stateByConceptId: Record<string, UserConceptStateRow> = {};
  for (const id of lockOrder) {
    stateByConceptId[id] = (await getConceptStateForUpdate(client, userId, id)) ?? defaultConceptStateRow(userId, id);
  }
  const stateMap: Record<string, UserConceptStateRow> = {};
  conceptIds.forEach((id) => {
    stateMap[id] = stateByConceptId[id]!;
  });

  if (outcome.excluded || outcome.skipped) {
    // Compile-only failures never reach updateConcepts (CONTRACTS §8), but every one of them
    // still increments error_counts.compilation so the recurrence threshold can eventually trip.
    if (verdict === "compilation_error") {
      for (const id of conceptIds) {
        const old = stateMap[id]!;
        await upsertConceptState(client, { ...old, error_counts: bumpCompilationErrorCount(old) });
      }
    }
    return { applied: false };
  }

  const beforeSnapshot = snapshotStates(stateMap);

  const update = updateConcepts({
    states: stateMap,
    weights,
    problemRating: content.difficulty.rating,
    outcome: outcome.outcome,
    evidenceWeight: outcome.evidenceWeight,
    highestHint,
  });

  const newStates: Record<string, UserConceptStateRow> = {};
  for (const change of update.changes) {
    const old = stateMap[change.concept_id]!;
    const counters = computeCounterUpdates(old, verdict, highestHint, activeMs);
    const isPrimary = change.concept_id === primaryConceptId;
    const review = isPrimary ? scheduleReview(old, outcome.outcome, now) : null;
    const errorCounts = verdict === "compilation_error" ? bumpCompilationErrorCount(old) : old.error_counts;

    newStates[change.concept_id] = {
      ...old,
      rating: change.after_rating,
      uncertainty: change.after_uncertainty,
      ...counters,
      error_counts: errorCounts,
      last_practiced_at: now,
      next_review_at: review ? review.next_review_at : old.next_review_at,
      review_interval_days: review ? review.review_interval_days : old.review_interval_days,
      review_ease: review ? review.review_ease : old.review_ease,
      review_reps: review ? review.review_reps : old.review_reps,
    };
  }

  const afterSnapshot = snapshotStates(newStates);

  const inserted = await insertLearningEvent(client, {
    id: newId(),
    user_id: userId,
    problem_version_id: versionId,
    submission_id: submission.id,
    kind: "submission",
    outcome: outcome.outcome,
    evidence: {
      verdict,
      breakdown: outcome.breakdown,
      evidence_weight: outcome.evidenceWeight,
      highest_hint: highestHint,
      active_ms: activeMs,
      substantive_submissions: substantiveSubmissions,
      compile_errors: compileErrors,
      error_category: outcome.errorCategory ?? null,
      changes: update.changes,
      explanation: update.explanation,
      expected: update.expected,
    },
    before_state: beforeSnapshot,
    after_state: afterSnapshot,
    idempotency_key: learningEventKey({ kind: "submission", submissionId: submission.id }),
    correlation_id: submission.correlation_id ?? undefined,
  });

  // `insertLearningEvent` is `on conflict (idempotency_key) do nothing` -> `null` means another
  // application already won for this submission. The unique constraint IS the enforcement
  // mechanism: we deliberately never touch user_concept_state until after this insert succeeds.
  if (!inserted) {
    return { applied: false };
  }

  for (const id of conceptIds) {
    await upsertConceptState(client, newStates[id]!);
  }

  await notify(client, {
    type: "mastery",
    submission_id: submission.id,
    user_id: userId,
    changes: update.changes,
    outcome: outcome.outcome,
    explanation: update.explanation,
  });

  return { applied: true, changes: update.changes, outcome: outcome.outcome, explanation: update.explanation };
}
