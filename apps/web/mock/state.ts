/**
 * All in-memory state for the mock server. Single user (docs/CONTRACTS.md §1 single-user mode),
 * reset on process restart.
 */
import type { HintLevel, Language, Submission, SubmissionMode, Verdict } from "@leetmind/shared";
import { newId } from "@leetmind/shared";
import { CONCEPTS } from "./fixtures/concepts.js";
import { PROBLEM_FIXTURES, type ProblemFixture } from "./fixtures/problems.js";
import { SINGLE_USER_ID } from "./ids.js";
import type { ConceptRatingState } from "./mastery.js";

export const USER_ID = SINGLE_USER_ID;

export const problemFixtures: ProblemFixture[] = PROBLEM_FIXTURES;
export const problemsById = new Map(problemFixtures.map((p) => [p.problemVersionId, p]));

// --- per-problem user state (hints taken, solved/given-up) --------------------------------

export interface ProblemUserState {
  hintsTaken: HintLevel[];
  solved: boolean;
  gaveUp: boolean;
  /** An accepted `transcribe` submission exists — the teaching episode's write-it-out step is
   * done. Without this the mock's give-up flow dead-ends: practice keeps re-serving the same
   * problem and the workspace keeps hiding "Next problem". */
  transcribed: boolean;
  submissionCount: number;
}

const problemUserState = new Map<string, ProblemUserState>();

export function getProblemUserState(versionId: string): ProblemUserState {
  let s = problemUserState.get(versionId);
  if (!s) {
    s = { hintsTaken: [], solved: false, gaveUp: false, transcribed: false, submissionCount: 0 };
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

// Seed a little pre-existing progress so the mock's `/` serves a mid-journey practice problem
// rather than a cold-start one — the cold-start path is the trivial case, and the interesting UI
// (rationale copy, band evidence, review urgency) only appears once there are ratings to reason
// about.
(function seedInitialProgress() {
  const arrays = conceptState.get("arrays_hashing");
  const bsearch = conceptState.get("binary_search");
  const window_ = conceptState.get("sliding_window");
  if (arrays)
    Object.assign(arrays, {
      rating: 1310,
      uncertainty: 190,
      attempts: 9,
      solves: 7,
      unassisted_solves: 5,
      current_streak: 3,
      best_streak: 4,
      total_active_ms: 41 * 60_000,
      last_practiced_at: "2026-07-20T14:00:00.000Z",
    });
  if (bsearch)
    Object.assign(bsearch, {
      rating: 1180,
      uncertainty: 230,
      attempts: 5,
      solves: 3,
      unassisted_solves: 2,
      current_streak: 1,
      best_streak: 2,
      total_active_ms: 22 * 60_000,
      last_practiced_at: "2026-07-18T09:00:00.000Z",
      next_review_at: "2026-07-23T09:00:00.000Z",
      review_interval_days: 4,
      review_reps: 2,
    });
  if (window_)
    Object.assign(window_, {
      rating: 1090,
      uncertainty: 300,
      attempts: 2,
      solves: 1,
      unassisted_solves: 0,
      current_streak: 0,
      best_streak: 1,
      total_active_ms: 14 * 60_000,
      last_practiced_at: "2026-07-15T09:00:00.000Z",
    });
})();

// --- submissions -----------------------------------------------------------------------------

export interface InternalSubmission {
  row: Submission;
  problemVersionId: string;
  mode: SubmissionMode;
  language: Language;
  source: string;
  activeMs: number;
}

export const submissions = new Map<string, InternalSubmission>();

const submissionCountByVersion = new Map<string, number>();
export function bumpSubmissionCount(versionId: string): number {
  const n = (submissionCountByVersion.get(versionId) ?? 0) + 1;
  submissionCountByVersion.set(versionId, n);
  return n;
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
