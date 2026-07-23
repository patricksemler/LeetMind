/**
 * Property test (CONTRACTS.md §8 / task item 7): simulate a user with a TRUE latent skill of
 * 1500 answering 200 problems drawn around their *current estimated* rating, with the outcome
 * sampled from the true logistic curve. Assert the Glicko-lite estimate converges to within
 * ±120 of 1500 and that uncertainty drops below 150.
 *
 * Deterministic via a seeded mulberry32 PRNG — no Math.random().
 */
import { describe, expect, it } from "vitest";
import { updateConcepts } from "./update.js";
import { expectedSuccess } from "./rating.js";
import { LEARNER_CONSTANTS } from "./index.js";
import type { ConceptState } from "./types.js";

// Small, dependency-free PRNG (public-domain mulberry32).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("convergence: Glicko-lite estimate tracks a true latent skill", () => {
  it("converges to within ±120 of a true 1500 skill over 200 problems, uncertainty < 150", () => {
    const TRUE_SKILL = 1500;
    const N = 200;
    const rand = mulberry32(20260722);

    let state: ConceptState = {
      concept_id: "skill",
      rating: LEARNER_CONSTANTS.INITIAL_RATING,
      uncertainty: LEARNER_CONSTANTS.INITIAL_UNCERTAINTY,
      review_interval_days: 1,
      review_ease: 2.5,
      review_reps: 0,
    };

    const weights = [{ id: "skill", weight: 1 }];

    for (let i = 0; i < N; i++) {
      // Draw a problem rating around the user's CURRENT ESTIMATE (not the true skill — the
      // selector only ever sees the estimate), spread ±300, clamped to a plausible rating range.
      const spread = (rand() * 2 - 1) * 300;
      const problemRating = Math.min(2400, Math.max(800, state.rating + spread));

      // Outcome sampled from the TRUE logistic curve against the TRUE latent skill.
      const trueP = expectedSuccess(TRUE_SKILL, problemRating);
      const outcome = rand() < trueP ? 1 : 0;

      const result = updateConcepts({
        states: { skill: state },
        weights,
        problemRating,
        outcome,
        evidenceWeight: 1,
      });

      const change = result.changes[0]!;
      state = { ...state, rating: change.after_rating, uncertainty: change.after_uncertainty };
    }

    // eslint-disable-next-line no-console
    console.log(
      `[convergence] final rating=${state.rating.toFixed(1)} uncertainty=${state.uncertainty.toFixed(1)} ` +
        `(true skill=${TRUE_SKILL})`
    );

    expect(Math.abs(state.rating - TRUE_SKILL)).toBeLessThanOrEqual(120);
    expect(state.uncertainty).toBeLessThan(150);
  });
});
