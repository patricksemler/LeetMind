// DB-integration glue between `@leetmind/db` rows and the pure `@leetmind/learner` shapes
// (docs/CONTRACTS.md §9). Shared by every caller that has to turn a (concept, target rating) pair
// into a real problem — the cold-start stepper, follow-up resolution, and the practice loop's
// band search — so none of them re-implements the widen-band search or the row-to-candidate parse.
import {
  listApprovedUnattempted,
  listConceptStates,
  type ProblemShape,
  type ProblemVersionRow,
  type UserConceptStateRow,
} from "@leetmind/db";
import type { CandidateProblem, ConceptState } from "@leetmind/learner";

export const DEFAULT_RATING = 1200;
export const DEFAULT_UNCERTAINTY = 350;

export function defaultConceptState(conceptId: string): ConceptState {
  return {
    concept_id: conceptId,
    rating: DEFAULT_RATING,
    uncertainty: DEFAULT_UNCERTAINTY,
    last_practiced_at: null,
    next_review_at: null,
    review_interval_days: 1,
    review_ease: 2.5,
    review_reps: 0,
  };
}

/** DB-row projection of the same defaults as `defaultConceptState`, for callers that need a full
 * `user_concept_state` row (e.g. a row-locked read-modify-write that must populate every column
 * even when no row exists yet) rather than the pure learner `ConceptState` shape. */
export function defaultConceptStateRow(userId: string, conceptId: string): UserConceptStateRow {
  return {
    user_id: userId,
    concept_id: conceptId,
    rating: DEFAULT_RATING,
    uncertainty: DEFAULT_UNCERTAINTY,
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
    mastered_at: null,
    updated_at: new Date(),
  };
}

/** Restricts a candidate search to problems of the same form as `shape`, or to a different one.
 * Only follow-up selection uses this — see `ListApprovedUnattemptedFilter.shape` in @leetmind/db,
 * including why unknown (pre-007) shapes stay eligible either way. */
export interface ShapeConstraint {
  shape: ProblemShape;
  matchShape: "same" | "different";
}

/** Every concept state for `userId`, keyed by concept id — real rows where they exist, a fresh
 * default otherwise (a brand-new user has no `user_concept_state` rows at all yet). */
export async function loadConceptStates(userId: string): Promise<Record<string, ConceptState>> {
  const rows = await listConceptStates(userId);
  const states: Record<string, ConceptState> = {};
  for (const row of rows) states[row.concept_id] = row;
  return states;
}

/** The selectable shape plus the two presentation fields the API surfaces in `selection_evidence`
 * (so the UI can say "~12 min · Sliding Window Maximum" without a second fetch). */
export interface PoolCandidate extends CandidateProblem {
  expected_active_minutes: [number, number];
  title?: string;
}

/** Parses a `problem_versions` row into the candidate shape the learner selects over. Returns
 * `null` for rows with unusable concept weights — a generated problem that somehow lost its
 * concept weights is unselectable, not a crash. */
export function toPoolCandidate(row: ProblemVersionRow): PoolCandidate | null {
  const content = row.content as {
    concepts?: Array<{ id?: unknown; weight?: unknown }>;
    expected_active_minutes?: unknown;
    title?: unknown;
  };
  const rawConcepts = Array.isArray(content?.concepts) ? content.concepts : [];
  const concepts = rawConcepts
    .filter((c): c is { id: string; weight: number } => typeof c?.id === "string" && typeof c?.weight === "number")
    .map((c) => ({ id: c.id, weight: c.weight }));
  if (concepts.length === 0) return null;

  const minutes = Array.isArray(content.expected_active_minutes) && content.expected_active_minutes.length === 2
    ? (content.expected_active_minutes as [number, number])
    : ([row.expected_min_minutes ?? 10, row.expected_max_minutes ?? 25] as [number, number]);

  return {
    problem_version_id: row.id,
    difficulty_rating: row.difficulty_rating,
    concepts,
    expected_active_minutes: minutes,
    title: typeof content.title === "string" ? content.title : row.title,
  };
}

const WIDEN_STEPS = [0, 150, 300, 600, 1200];

/**
 * Finds the approved-and-unattempted candidate for `conceptId` closest to `targetRating`,
 * widening the search window progressively rather than failing outright on a thin pool. Used to
 * resolve a baseline plan step (concept + target rating) into a real problem to serve.
 *
 * Returns `null` only when the concept has no usable candidate at ANY distance — which is the
 * signal the practice route turns into "generate one".
 */
export async function findCandidateNear(
  userId: string,
  conceptId: string,
  targetRating: number,
  excludeIds: Set<string>,
  shape?: ShapeConstraint,
): Promise<ProblemVersionRow | null> {
  for (const pad of WIDEN_STEPS) {
    const rows = await listApprovedUnattempted(userId, {
      conceptId,
      minRating: Math.floor(targetRating - pad),
      maxRating: Math.ceil(targetRating + pad),
      limit: 25,
      shape: shape?.shape,
      matchShape: shape?.matchShape,
    });
    const usable = rows.filter((r) => !excludeIds.has(r.id));
    if (usable.length === 0) continue;
    usable.sort((a, b) => Math.abs(a.difficulty_rating - targetRating) - Math.abs(b.difficulty_rating - targetRating));
    return usable[0]!;
  }
  return null;
}
