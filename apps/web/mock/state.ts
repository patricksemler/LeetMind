/**
 * All in-memory state for the mock server. Single user (docs/CONTRACTS.md §1 single-user mode),
 * reset on process restart.
 */
import type {
  HintLevel,
  Language,
  Submission,
  SubmissionMode,
  Verdict,
  BaselineSession,
  BaselineItem,
} from "@leetmind/shared";
import { newId } from "@leetmind/shared";
import { CONCEPTS } from "./fixtures/concepts.js";
import { PROBLEM_FIXTURES, type ProblemFixture } from "./fixtures/problems.js";
import { fixedId, SINGLE_USER_ID } from "./ids.js";
import type { ConceptRatingState } from "./mastery.js";

export const USER_ID = SINGLE_USER_ID;

export const problemFixtures: ProblemFixture[] = PROBLEM_FIXTURES;
export const problemsById = new Map(problemFixtures.map((p) => [p.problemVersionId, p]));

// --- per-problem user state (hints taken, solved/given-up) --------------------------------

export interface ProblemUserState {
  hintsTaken: HintLevel[];
  solved: boolean;
  gaveUp: boolean;
  submissionCount: number;
}

const problemUserState = new Map<string, ProblemUserState>();

export function getProblemUserState(versionId: string): ProblemUserState {
  let s = problemUserState.get(versionId);
  if (!s) {
    s = { hintsTaken: [], solved: false, gaveUp: false, submissionCount: 0 };
    problemUserState.set(versionId, s);
  }
  return s;
}

export function hasSolvedOrGivenUp(versionId: string): boolean {
  const s = problemUserState.get(versionId);
  return !!s && (s.solved || s.gaveUp);
}

// --- concept mastery state -----------------------------------------------------------------

export interface ConceptFullState extends ConceptRatingState {
  attempts: number;
  solves: number;
  unassisted_solves: number;
  skips: number;
  current_streak: number;
  best_streak: number;
  total_active_ms: number;
  hint_counts: Record<string, number>;
  error_counts: Record<string, number>;
  last_practiced_at: string | null;
  next_review_at: string | null;
  review_interval_days: number;
  review_ease: number;
  review_reps: number;
}

export const conceptState = new Map<string, ConceptFullState>();
for (const c of CONCEPTS) {
  conceptState.set(c.id, {
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
  });
}

// Seed a little pre-existing progress so `/` can serve a practice problem straight away instead
// of routing every fresh visitor into the baseline. `/baseline` stays fully implemented and
// directly reachable, and `resetBaseline()` (below) puts the mock back into the never-onboarded
// state the first-run flow needs to be exercised from.
(function seedInitialProgress() {
  const arrays = conceptState.get("arrays_hashing");
  const bsearch = conceptState.get("binary_search");
  const window_ = conceptState.get("sliding_window");
  if (arrays) Object.assign(arrays, { rating: 1310, uncertainty: 190, attempts: 9, solves: 7, unassisted_solves: 5, current_streak: 3, best_streak: 4, total_active_ms: 41 * 60_000, last_practiced_at: "2026-07-20T14:00:00.000Z" });
  if (bsearch) Object.assign(bsearch, { rating: 1180, uncertainty: 230, attempts: 5, solves: 3, unassisted_solves: 2, current_streak: 1, best_streak: 2, total_active_ms: 22 * 60_000, last_practiced_at: "2026-07-18T09:00:00.000Z", next_review_at: "2026-07-23T09:00:00.000Z", review_interval_days: 4, review_reps: 2 });
  if (window_) Object.assign(window_, { rating: 1090, uncertainty: 300, attempts: 2, solves: 1, unassisted_solves: 0, current_streak: 0, best_streak: 1, total_active_ms: 14 * 60_000, last_practiced_at: "2026-07-15T09:00:00.000Z" });
})();

// --- submissions -----------------------------------------------------------------------------

export interface InternalSubmission {
  row: Submission;
  problemVersionId: string;
  mode: SubmissionMode;
  language: Language;
  source: string;
  customInput: unknown;
  baselineItemId?: string;
  activeMs: number;
}

export const submissions = new Map<string, InternalSubmission>();

const submissionCountByVersion = new Map<string, number>();
export function bumpSubmissionCount(versionId: string): number {
  const n = (submissionCountByVersion.get(versionId) ?? 0) + 1;
  submissionCountByVersion.set(versionId, n);
  return n;
}

// --- baseline ---------------------------------------------------------------------------------

interface BaselineState {
  session: BaselineSession | null;
  /** Whether a baseline has EVER been started, which is what `/api/me`'s `has_baseline` and the
   * practice route's `needs_baseline` gate on — distinct from "one is in progress". */
  everStarted: boolean;
}
export const baselineState: BaselineState = { session: null, everStarted: false };

export const baselineItems = new Map<string, BaselineItem>();

const BASELINE_PLAN: Array<{ concept: string; label: string }> = [
  { concept: "arrays_hashing", label: "arrays & hashing" },
  { concept: "binary_search", label: "binary search" },
  { concept: "sliding_window", label: "sliding window" },
  { concept: "trees_bst", label: "trees" },
];

function makeBaselineItem(
  sessionId: string,
  position: number,
  problem: ProblemFixture,
  conceptId: string,
  rationale: string,
): BaselineItem {
  const item: BaselineItem = {
    id: fixedId(`${sessionId}:item:${position}`),
    baseline_session_id: sessionId,
    position,
    problem_version_id: problem.problemVersionId,
    rationale,
    selection_evidence: {
      concept_id: conceptId,
      target_rating: 1050,
      difficulty_rating: problem.content.difficulty.rating,
      expected_active_minutes: problem.content.expected_active_minutes,
      title: problem.content.title,
    },
    state: "pending",
    active_ms: 0,
    started_at: null,
    completed_at: null,
  };
  baselineItems.set(item.id, item);
  return item;
}

/** Starts a baseline seeded with only its first probe, exactly like the real API — the rest are
 * appended one at a time by `advanceMockBaseline` as each is resolved. */
export function buildBaseline(): BaselineSession {
  const sessionId = fixedId(`baseline:${Date.now()}`);
  baselineItems.clear();
  const first = problemFixtures[0]!;
  const session: BaselineSession = {
    id: sessionId,
    user_id: USER_ID,
    status: "active",
    rationale: {
      summary: `Short adaptive baseline across ${BASELINE_PLAN.length} concepts. Skip anything unfamiliar — that's useful signal, not a failure.`,
      plan: BASELINE_PLAN.map((p) => ({ concept_id: p.concept, target_rating: 1050 })),
    },
    created_at: new Date().toISOString(),
    completed_at: null,
    planned_count: BASELINE_PLAN.length,
    items: [
      makeBaselineItem(sessionId, 0, first, BASELINE_PLAN[0]!.concept, `Baseline: ${BASELINE_PLAN[0]!.label}, low-mid difficulty.`),
    ],
  };
  baselineState.session = session;
  baselineState.everStarted = true;
  return session;
}

/** Mirrors `advanceBaseline` in apps/api: once every current item is resolved, append the next
 * planned probe, or complete the session when the plan runs out. */
export function advanceMockBaseline(): BaselineSession | null {
  const session = baselineState.session;
  if (!session || session.status !== "active") return session;

  const items = session.items ?? [];
  if (items.some((i) => i.state === "pending" || i.state === "active")) return session;

  const position = items.length;
  const plan = BASELINE_PLAN[position];
  const problem = problemFixtures[position];
  if (!plan || !problem) {
    session.status = "completed";
    session.completed_at = new Date().toISOString();
    return session;
  }

  session.items = [
    ...items,
    makeBaselineItem(session.id, position, problem, plan.concept, `Baseline: ${plan.label}, low-mid difficulty.`),
  ];
  return session;
}

/** Puts the mock back into the never-onboarded state, so the first-run flow can be exercised
 * without restarting the process. */
export function resetBaseline(): void {
  baselineState.session = null;
  baselineState.everStarted = false;
  baselineItems.clear();
}

// --- learning event log (drives /progress and /system) --------------------------------------

export interface LearningEventRecord {
  id: string;
  kind: "submission" | "skip" | "give_up" | "diagnostic" | "review" | "decay";
  problem_version_id?: string;
  verdict?: Verdict | null;
  outcome: number;
  hints_used: HintLevel[];
  active_ms: number;
  difficulty_rating?: number;
  created_at: string;
}

export const learningEvents: LearningEventRecord[] = [];

export function newSubmissionId(): string {
  return newId();
}
