/**
 * Glicko-lite rating primitives. CONTRACTS.md §8. Pure — no I/O, no clock reads.
 */

import type { ConceptWeight } from "./types.js";

/** Clamp `x` into `[min, max]`. */
export function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}

/**
 * Logistic win probability, Elo-style. CONTRACTS.md §8:
 *   expectedSuccess = 1 / (1 + 10 ** ((problemRating - userRating) / 400))
 */
export function expectedSuccess(userRating: number, problemRating: number): number {
  return 1 / (1 + 10 ** ((problemRating - userRating) / 400));
}

/**
 * Weight-averaged rating across a problem's concepts, plus a combined uncertainty.
 *
 * Rating: a plain weighted arithmetic mean — the natural way to blend independent point
 * estimates of the same latent quantity (expected success on a mixed-concept problem).
 *
 * Uncertainty: the **weighted quadratic mean (RMS)** of the component uncertainties, not the
 * arithmetic mean. Uncertainty behaves like a standard deviation, not a linear quantity — under
 * naive independence, blending distributions with different spreads combines their *variances*
 * additively, not their standard deviations. RMS is a well-behaved single-number summary that
 * (a) stays within the range of the component uncertainties like the arithmetic mean would,
 * (b) is pulled up disproportionately by the single most-uncertain concept, which is the
 * conservative choice for a multi-concept problem: if the user is very unsure about *one*
 * contributing concept, the blended prediction should reflect that lack of confidence rather
 * than being smoothed away by more-certain concepts. Arithmetic mean would understate this.
 *
 * Weights are normalized defensively (divided by their sum) in case the caller passes weights
 * that don't sum to exactly 1.
 */
export function blendedRating(
  states: Record<string, { rating: number; uncertainty: number }>,
  weights: ConceptWeight[],
): { rating: number; uncertainty: number } {
  if (weights.length === 0) {
    throw new Error("blendedRating: weights must be non-empty");
  }

  const sum = weights.reduce((acc, w) => acc + w.weight, 0);
  if (sum <= 0) {
    throw new Error("blendedRating: weights must sum to a positive number");
  }
  const normalized = weights.map((w) => ({ id: w.id, weight: w.weight / sum }));

  let rating = 0;
  let varianceSum = 0;
  for (const w of normalized) {
    const state = states[w.id];
    if (!state) {
      throw new Error(`blendedRating: missing concept state for "${w.id}"`);
    }
    rating += w.weight * state.rating;
    varianceSum += w.weight * state.uncertainty * state.uncertainty;
  }

  return { rating, uncertainty: Math.sqrt(varianceSum) };
}

/**
 * K-factor scaled by uncertainty: wide-uncertainty concepts move fast (early calibration),
 * well-calibrated concepts move slowly (stability). CONTRACTS.md §8:
 *   K = 16 + 32 * (uncertainty - 50) / (350 - 50), clamped to [16, 48]
 */
export function kFactor(uncertainty: number): number {
  return clamp(16 + (32 * (uncertainty - 50)) / (350 - 50), 16, 48);
}
