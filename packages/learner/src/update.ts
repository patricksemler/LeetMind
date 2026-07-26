/**
 * `updateConcepts` — CONTRACTS.md §8. Computes the blended-rating Elo delta for an outcome and
 * splits it across the problem's concepts by weight, updating each concept's rating and
 * uncertainty. Pure — no I/O, no clock reads.
 */

import type { ConceptChange, ConceptState, ConceptWeight, HintLevel } from "./types.js";
import { blendedRating, clamp, expectedSuccess, kFactor } from "./rating.js";

const SWING_CAP = 64;
const EVIDENCE_SIGMA = 180;
const UNCERTAINTY_FLOOR = 50;
const UNCERTAINTY_CEILING = 350;

export interface UpdateConceptsInput {
  states: Record<string, ConceptState>;
  weights: ConceptWeight[];
  problemRating: number;
  outcome: number;
  evidenceWeight: number;
  /**
   * Optional, learner-package extension beyond the CONTRACTS.md §8 minimal signature: when the
   * caller has it (from `outcomeScore`'s input), passing the highest hint taken lets
   * `explanation` name it, matching the illustrative example in the implementation brief
   * ("... scored 0.75 after one L2 hint."). Purely cosmetic — never affects the numeric update.
   */
  highestHint?: HintLevel | null;
}

export interface UpdateConceptsResult {
  changes: ConceptChange[];
  explanation: string;
  expected: number;
  blended: { rating: number; uncertainty: number };
  evidenceWeight: number;
}

/** Named the way the hint ladder names them in the UI, not by rung number. "after one L2 hint"
 * assumes the reader has memorised the ladder; "after a conceptual hint" does not. */
const HINT_PHRASES: Record<HintLevel, string> = {
  l1_orientation: " after an orientation hint",
  l2_conceptual: " after a conceptual hint",
  l3_structural: " after a structural hint",
  outline: " after reading the outline",
  editorial: " after reading the editorial",
};

function hintPhrase(hint: HintLevel | null | undefined): string {
  return hint ? HINT_PHRASES[hint] : "";
}

export function updateConcepts(input: UpdateConceptsInput): UpdateConceptsResult {
  const { states, weights, problemRating, outcome, evidenceWeight, highestHint } = input;

  if (weights.length === 0) {
    throw new Error("updateConcepts: weights must be non-empty");
  }

  const weightSum = weights.reduce((acc, w) => acc + w.weight, 0);
  if (weightSum <= 0) {
    throw new Error("updateConcepts: weights must sum to a positive number");
  }
  const normalizedWeights = weights.map((w) => ({ id: w.id, weight: w.weight / weightSum }));

  const blended = blendedRating(states, normalizedWeights);
  const expected = expectedSuccess(blended.rating, problemRating);
  const k = kFactor(blended.uncertainty);

  const rawDelta = k * (outcome - expected) * evidenceWeight;
  const delta = clamp(rawDelta, -SWING_CAP, SWING_CAP);

  const changes: ConceptChange[] = normalizedWeights.map((w) => {
    const state = states[w.id];
    if (!state) {
      throw new Error(`updateConcepts: missing concept state for "${w.id}"`);
    }
    const conceptDelta = delta * w.weight;
    const beforeRating = state.rating;
    const beforeUncertainty = state.uncertainty;
    const afterRating = beforeRating + conceptDelta;
    const afterUncertainty = clamp(
      Math.sqrt(1 / (1 / beforeUncertainty ** 2 + evidenceWeight / EVIDENCE_SIGMA ** 2)),
      UNCERTAINTY_FLOOR,
      UNCERTAINTY_CEILING
    );

    return {
      concept_id: w.id,
      before_rating: beforeRating,
      after_rating: afterRating,
      before_uncertainty: beforeUncertainty,
      after_uncertainty: afterUncertainty,
      delta: conceptDelta,
      k,
      weight: w.weight,
    };
  });

  const explanation = buildExplanation({ blended, problemRating, expected, outcome, highestHint, changes });

  return { changes, explanation, expected, blended, evidenceWeight };
}

/** "about a 1 in 5 chance" reads instantly; "19%" makes the reader do the work. Only used for the
 * genuinely lopsided ends of the range, where the odds framing is the point. */
function chancePhrase(expected: number): string {
  const pct = Math.round(expected * 100);
  if (pct <= 0) return "almost no chance";
  if (pct >= 100) return "a near certainty";
  if (pct < 35) return `about a 1 in ${Math.max(2, Math.round(1 / expected))} chance`;
  if (pct > 65) return `about a ${pct}% chance — comfortably within reach`;
  return `about a ${pct}% chance — right at the edge of your level`;
}

/** What the outcome score meant, in words. `outcome` is the bounded 0..1 evidence score. */
function outcomePhrase(outcome: number, highestHint: HintLevel | null | undefined): string {
  const hint = hintPhrase(highestHint);
  if (outcome >= 0.999) return `You solved it${hint || " unaided"}.`;
  if (outcome > 0.6) return `You solved it${hint}, so it counts for most of the credit.`;
  if (outcome > 0) return `You got there${hint}, so it counts for partial credit.`;
  return "You didn't solve it this time.";
}

/**
 * A sentence a person can read mid-session, not a log line.
 *
 * The previous version was written for whoever was debugging the model: "Expected 19% success (you
 * 1200 vs problem 1450); scored 1. two_pointers +39 (1200→1239, ±350→±160)." Every number in it is
 * correct and none of it explains anything to the person who just solved the problem — it names
 * the concept by its database slug, states the same deltas the UI already renders beside it, and
 * writes uncertainty as a ± pair with no indication of which direction is good.
 *
 * This version says what happened and why, and leaves the exact arithmetic to the structured
 * `changes` the caller already has. It is also what gets persisted on the `learning_events` row,
 * so it has to stand on its own months later with no UI around it.
 */
function buildExplanation(args: {
  blended: { rating: number; uncertainty: number };
  problemRating: number;
  expected: number;
  outcome: number;
  highestHint: HintLevel | null | undefined;
  changes: ConceptChange[];
}): string {
  const { blended, problemRating, expected, outcome, highestHint, changes } = args;

  const setup =
    `This problem was rated ${Math.round(problemRating)} and you were at ` +
    `${Math.round(blended.rating)}, so you had ${chancePhrase(expected)}.`;

  const result = outcomePhrase(outcome, highestHint);

  // Derived from the ROUNDED endpoints, not `c.delta` rounded independently — rounding all three
  // separately can disagree (e.g. "+0 (1500→1501)": the raw delta rounds to 0 while the endpoints,
  // rounded separately, round to a 1-point difference). Deriving the displayed delta from the same
  // rounded numbers the copy shows guarantees they always agree.
  const moves = changes.map((c) => {
    const roundedDelta = Math.round(c.after_rating) - Math.round(c.before_rating);
    const direction = roundedDelta > 0 ? "up" : roundedDelta < 0 ? "down" : "unchanged";
    return roundedDelta === 0
      ? `${c.concept_id} unchanged at ${Math.round(c.after_rating)}`
      : `${c.concept_id} ${direction} ${Math.abs(roundedDelta)} to ${Math.round(c.after_rating)}`;
  });

  // Uncertainty only ever shrinks on an evidence update, and "more confident" is the part worth
  // saying; the raw ± pair belongs in the structured data, not the prose.
  const tightened = changes.every((c) => Math.round(c.after_uncertainty) < Math.round(c.before_uncertainty));
  const confidence = tightened
    ? ` The estimate is more confident than before: give or take ${Math.round(
        Math.max(...changes.map((c) => c.after_uncertainty)),
      )} points instead of ${Math.round(Math.max(...changes.map((c) => c.before_uncertainty)))}.`
    : "";

  return `${setup} ${result} That moves ${joinList(moves)}.${confidence}`;
}

/** "a", "a and b", "a, b and c" — an Oxford-comma-free list, because this is prose. */
function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "nothing";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
