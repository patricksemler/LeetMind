// DB-integration glue for M3 workout assembly (docs/CONTRACTS.md §9, PLAN.md §8). Keeps
// routes/workouts.ts focused on HTTP concerns; everything here bridges `@leetmind/db` rows to the
// pure `@leetmind/learner` shapes and back, mirroring the pattern already established in
// routes/problems.ts (`defaultConceptState`, the widen-band search).
import {
  listApprovedUnattempted,
  listConceptStates,
  type ProblemVersionRow,
} from "@leetmind/db";
import { ProblemVersionSchema } from "@leetmind/shared";
import type { ConceptState, WorkoutCandidateProblem } from "@leetmind/learner";

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

/** Every concept state for `userId`, keyed by concept id — real rows where they exist, a fresh
 * default otherwise (a brand-new user has no `user_concept_state` rows at all yet). */
export async function loadConceptStates(userId: string): Promise<Record<string, ConceptState>> {
  const rows = await listConceptStates(userId);
  const states: Record<string, ConceptState> = {};
  for (const row of rows) states[row.concept_id] = row;
  return states;
}

/** Parses a `problem_versions` row into the shape `assembleWorkout`/`assembleDiagnostic` need.
 * Returns `null` for rows with unusable concept weights, same defensive stance as
 * routes/problems.ts's `toCandidateProblem`. */
export function toWorkoutCandidate(row: ProblemVersionRow): WorkoutCandidateProblem | null {
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

/** A broad approved-and-unattempted pool for workout assembly: unlike `GET /api/problems/next`
 * (which searches a tight band around one target), `assembleWorkout` needs candidates spanning
 * "very easy" (warm-up) through "above the working band" (overload) simultaneously, so this pulls
 * a wide, unfiltered-by-rating slice (optionally scoped to `conceptId`) and lets the pure
 * assembler pick from it. */
export async function loadWorkoutCandidatePool(
  userId: string,
  opts: { conceptId?: string; limit?: number } = {},
): Promise<WorkoutCandidateProblem[]> {
  const rows = await listApprovedUnattempted(userId, { conceptId: opts.conceptId, limit: opts.limit ?? 300 });
  return rows.map(toWorkoutCandidate).filter((c): c is WorkoutCandidateProblem => c !== null);
}

const WIDEN_STEPS = [0, 150, 300, 600, 1200];

/**
 * Finds the approved-and-unattempted candidate for `conceptId` closest to `targetRating`,
 * widening the search window progressively (same shape as `GET /api/problems/next`'s widen
 * ladder) rather than failing outright on a thin pool. Used to resolve a diagnostic plan step
 * (concept + target rating) into a real problem to serve.
 */
export async function findCandidateNear(
  userId: string,
  conceptId: string,
  targetRating: number,
  excludeIds: Set<string>,
): Promise<ProblemVersionRow | null> {
  for (const pad of WIDEN_STEPS) {
    const rows = await listApprovedUnattempted(userId, {
      conceptId,
      minRating: Math.floor(targetRating - pad),
      maxRating: Math.ceil(targetRating + pad),
      limit: 25,
    });
    const usable = rows.filter((r) => !excludeIds.has(r.id));
    if (usable.length === 0) continue;
    usable.sort((a, b) => Math.abs(a.difficulty_rating - targetRating) - Math.abs(b.difficulty_rating - targetRating));
    return usable[0]!;
  }
  return null;
}

/** Validates+parses `row.content` once, for callers that need the full `ProblemVersion` (title,
 * expected_active_minutes) rather than just the candidate-shaped subset. */
export function parseContent(row: ProblemVersionRow) {
  return ProblemVersionSchema.parse(row.content);
}
