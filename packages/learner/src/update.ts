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

const HINT_LABELS: Record<HintLevel, string> = {
  l1_orientation: "L1",
  l2_conceptual: "L2",
  l3_structural: "L3",
  outline: "an outline",
  editorial: "the editorial",
};

function hintPhrase(hint: HintLevel | null | undefined): string {
  if (!hint) return "";
  const label = HINT_LABELS[hint];
  const article = hint === "outline" || hint === "editorial" ? "" : "one ";
  return ` after ${article}${label} hint`;
}

function formatScore(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
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

function buildExplanation(args: {
  blended: { rating: number; uncertainty: number };
  problemRating: number;
  expected: number;
  outcome: number;
  highestHint: HintLevel | null | undefined;
  changes: ConceptChange[];
}): string {
  const { blended, problemRating, expected, outcome, highestHint, changes } = args;

  const expectedPct = Math.round(expected * 100);
  const summary =
    `Expected ${expectedPct}% success (you ${Math.round(blended.rating)} vs problem ` +
    `${Math.round(problemRating)}); scored ${formatScore(outcome)}${hintPhrase(highestHint)}.`;

  const changeParts = changes.map((c) => {
    const sign = c.delta >= 0 ? "+" : "";
    const roundedDelta = Math.round(c.delta);
    return (
      `${c.concept_id} ${sign}${roundedDelta} (${Math.round(c.before_rating)}→${Math.round(c.after_rating)}, ` +
      `±${Math.round(c.before_uncertainty)}→±${Math.round(c.after_uncertainty)})`
    );
  });

  return `${summary} ${changeParts.join(", ")}.`;
}
