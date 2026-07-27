/**
 * Problem selection — CONTRACTS.md §8 doesn't fix numbers for this file (M1's job is "simple
 * next-problem selection, designed to grow into M3"); PLAN.md §7/§8 fixes the *shape* (target a
 * 65-80% success band, weakest concept, one-line rationale) and this file fixes reasonable,
 * documented weights so the heuristic is deterministic and testable. Pure — no I/O, no clock
 * reads except the injected `now`.
 */

import type { CandidateProblem, ConceptState } from "./types.js";

export const BAND_LOW_P = 0.65;
export const BAND_HIGH_P = 0.8;
const BASE_RATING = 1200;
const UNCERTAINTY_FLOOR = 50;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface TargetBand {
  min: number;
  max: number;
  ideal: number;
}

/**
 * Inverts the logistic `expectedSuccess` to find the problem rating at which a user of
 * `userRating` has success probability `p`:
 *   p = 1 / (1 + 10 ** ((problemRating - userRating) / 400))
 *   => problemRating = userRating + 400 * log10((1 - p) / p)
 */
function ratingForProbability(userRating: number, p: number): number {
  return userRating + 400 * Math.log10((1 - p) / p);
}

/**
 * The problem-rating range where P(success) for this user lands in [0.65, 0.80].
 *
 * Both edges of this band sit BELOW the user's own rating: since 0.65 and 0.80 are both above the
 * 50% coin-flip point, the problem must be somewhat *easier* than a rating-matched problem (which
 * would sit at exactly 50%). This matches the pedagogical target of "challenging but mostly
 * winnable" (desirable difficulty), not "even odds".
 *   band.min -> the p=0.80 edge (the easier, more-comfortable side of the band; numerically lower)
 *   band.max -> the p=0.65 edge (the harder side of the band, still below the user's rating)
 *   band.ideal -> the rating at the midpoint probability (0.725)
 */
export function targetBand(state: { rating: number }): TargetBand {
  const min = ratingForProbability(state.rating, BAND_HIGH_P);
  const max = ratingForProbability(state.rating, BAND_LOW_P);
  const ideal = ratingForProbability(state.rating, (BAND_LOW_P + BAND_HIGH_P) / 2);
  return { min, max, ideal };
}

export interface SelectionWeights {
  /** Penalty per rating-point of distance between the problem and the ideal band center. */
  bandClosenessWeight: number;
  /** Bonus per rating-point a concept sits below BASE_RATING (1200), scaled by concept weight. */
  weaknessWeight: number;
  /** Bonus per uncertainty-point above the floor (50), scaled by concept weight — information gain. */
  uncertaintyWeight: number;
  /** Bonus per day overdue for a due review, scaled by concept weight. Dominant when a review is due. */
  reviewWeight: number;
  /** Flat penalty (scaled by concept weight) when a concept was already practiced earlier today. */
  recencyPenalty: number;
}

export const DEFAULT_SELECTION_WEIGHTS: SelectionWeights = {
  bandClosenessWeight: 0.05,
  weaknessWeight: 0.05,
  uncertaintyWeight: 0.05,
  reviewWeight: 2,
  recencyPenalty: 5,
};

export interface ScoreCandidateInput {
  problem: CandidateProblem;
  states: Record<string, ConceptState>;
  now: Date;
  opts?: Partial<SelectionWeights>;
}

export interface ScoreCandidateResult {
  score: number;
  factors: Record<string, number>;
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

export function scoreCandidate(input: ScoreCandidateInput): ScoreCandidateResult {
  const { problem, states, now } = input;
  const weights = { ...DEFAULT_SELECTION_WEIGHTS, ...input.opts };

  let totalConceptWeight = 0;
  for (const c of problem.concepts) totalConceptWeight += c.weight;
  if (totalConceptWeight <= 0) {
    throw new Error("scoreCandidate: problem.concepts weights must sum to a positive number");
  }

  let weakness = 0;
  let uncertaintyBonus = 0;
  let reviewUrgency = 0;
  let recencyPenalty = 0;
  let blendedRating = 0;

  for (const c of problem.concepts) {
    const state = states[c.id];
    if (!state) {
      throw new Error(`scoreCandidate: missing concept state for "${c.id}"`);
    }
    const normWeight = c.weight / totalConceptWeight;

    blendedRating += normWeight * state.rating;
    weakness += normWeight * Math.max(0, BASE_RATING - state.rating);
    uncertaintyBonus += normWeight * Math.max(0, state.uncertainty - UNCERTAINTY_FLOOR);

    if (state.next_review_at) {
      const nextReviewAt = new Date(state.next_review_at);
      if (nextReviewAt.getTime() <= now.getTime()) {
        const daysOverdue = (now.getTime() - nextReviewAt.getTime()) / MS_PER_DAY;
        reviewUrgency += normWeight * daysOverdue;
      }
    }

    if (state.last_practiced_at && isSameCalendarDay(new Date(state.last_practiced_at), now)) {
      recencyPenalty += normWeight;
    }
  }

  const band = targetBand({ rating: blendedRating });
  const distanceFromIdeal = Math.abs(problem.difficulty_rating - band.ideal);

  const factors: Record<string, number> = {
    band_closeness: -distanceFromIdeal * weights.bandClosenessWeight,
    concept_weakness: weakness * weights.weaknessWeight,
    uncertainty_bonus: uncertaintyBonus * weights.uncertaintyWeight,
    review_urgency: reviewUrgency * weights.reviewWeight,
    recency_penalty: -recencyPenalty * weights.recencyPenalty,
  };

  const score = Object.values(factors).reduce((a, b) => a + b, 0);
  return { score, factors };
}

export interface SelectNextResult {
  candidate: CandidateProblem;
  score: number;
  factors: Record<string, number>;
  rationale: string;
}

/** Names the dominant (largest-magnitude) factor in a human sentence. */
function buildRationale(problem: CandidateProblem, factors: Record<string, number>): string {
  const dominantConcept = problem.concepts.reduce((best, c) => (c.weight > best.weight ? c : best));

  let dominantKey = "band_closeness";
  let dominantAbs = -Infinity;
  for (const [key, value] of Object.entries(factors)) {
    if (Math.abs(value) > dominantAbs) {
      dominantAbs = Math.abs(value);
      dominantKey = key;
    }
  }

  switch (dominantKey) {
    case "review_urgency":
      return `${dominantConcept.id} review is overdue — highest-urgency candidate.`;
    case "concept_weakness":
      return `targets ${dominantConcept.id}, your weakest contributing concept.`;
    case "uncertainty_bonus":
      return `high information value on ${dominantConcept.id} (uncertainty still wide).`;
    case "recency_penalty":
      return `deprioritized: ${dominantConcept.id} was already practiced today.`;
    case "band_closeness":
    default:
      return `nearest to your target difficulty band on ${dominantConcept.id}.`;
  }
}

/** Picks the best-scoring candidate and builds a one-line rationale from its dominant factor. */
export function selectNext(
  candidates: CandidateProblem[],
  states: Record<string, ConceptState>,
  now: Date,
  opts?: Partial<SelectionWeights>
): SelectNextResult {
  if (candidates.length === 0) {
    throw new Error("selectNext: candidates must be non-empty");
  }

  let best: SelectNextResult | null = null;
  for (const problem of candidates) {
    const { score, factors } = scoreCandidate({ problem, states, now, opts });
    if (!best || score > best.score) {
      best = { candidate: problem, score, factors, rationale: buildRationale(problem, factors) };
    }
  }

  // Non-null: candidates is non-empty, so the loop above always assigns `best`.
  return best as SelectNextResult;
}

// `assembleBaseline` / `nextBaselineStep` (the adaptive onboarding probe, PLAN.md §8) live in
// ./baseline.ts. They plan concept+rating *targets* rather than calling `scoreCandidate` here,
// because the API resolves each target against its own approved pool one item at a time.
//
// `scoreCandidate`/`selectNext` above are what the ongoing practice loop uses directly, once a
// baseline has seeded per-concept ratings.
