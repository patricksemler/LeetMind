/**
 * A self-contained reimplementation of the docs/CONTRACTS.md §8 mastery formulas, used only by
 * the mock server. Deliberately does NOT depend on `@leetmind/learner` (a concurrently-developed
 * package outside this agent's scope) — this keeps the mock stable regardless of that package's
 * state, while staying numerically faithful to the documented contract.
 */
import type { Verdict } from "@leetmind/shared";
import { HINT_PENALTY_CAPS, type HintLevel } from "@leetmind/shared";

export interface ConceptRatingState {
  rating: number;
  uncertainty: number;
}

export function expectedSuccess(userRating: number, problemRating: number): number {
  return 1 / (1 + 10 ** ((problemRating - userRating) / 400));
}

export interface OutcomeInput {
  verdict: Verdict | null;
  gaveUp: boolean;
  skipped: "inability" | "preference" | null;
  highestHint: HintLevel | null;
  activeMs: number;
  expectedMinutes: [number, number];
  substantiveSubmissions: number;
}

export interface OutcomeResult {
  outcome: number;
  evidenceWeight: number;
  breakdown: Record<string, number>;
}

export function outcomeScore(input: OutcomeInput): OutcomeResult {
  const breakdown: Record<string, number> = {};

  if (input.skipped === "preference") {
    return { outcome: 0, evidenceWeight: 0, breakdown: { note: 0 } };
  }
  if (input.skipped === "inability") {
    return { outcome: 0, evidenceWeight: 0.5, breakdown: { skip_inability: 0 } };
  }
  if (input.gaveUp) {
    return { outcome: 0, evidenceWeight: 1, breakdown: { give_up: 0 } };
  }

  let base: number;
  if (input.verdict === "accepted") base = 1.0;
  else if (input.substantiveSubmissions >= 1) base = 0.15;
  else base = 0.0;
  breakdown.base = base;

  let outcome = base;

  if (input.highestHint) {
    const cap = HINT_PENALTY_CAPS[input.highestHint];
    if (outcome > cap) {
      breakdown.hint_cap = cap - outcome;
      outcome = cap;
    }
  }

  const activeMinutes = input.activeMs / 60000;
  const [lowBand, highBand] = input.expectedMinutes;
  let timeModifier = 0;
  if (activeMinutes > 0) {
    if (activeMinutes < lowBand) timeModifier = 0.1;
    else if (activeMinutes > highBand * 2) timeModifier = -0.1;
  }
  breakdown.time_modifier = timeModifier;
  outcome += timeModifier;

  const extraSubmissions = Math.max(0, input.substantiveSubmissions - 1);
  const submissionModifier = Math.max(-0.08, -0.02 * extraSubmissions);
  breakdown.submission_modifier = submissionModifier;
  outcome += submissionModifier;

  outcome = Math.min(1, Math.max(0, outcome));

  const evidenceWeight = 1;
  return { outcome, evidenceWeight, breakdown };
}

export interface ConceptChangeLike {
  concept_id: string;
  before_rating: number;
  after_rating: number;
  before_uncertainty: number;
  after_uncertainty: number;
}

export function updateConcepts(input: {
  states: Record<string, ConceptRatingState>;
  weights: Array<{ id: string; weight: number }>;
  problemRating: number;
  outcome: number;
  evidenceWeight: number;
}): { changes: ConceptChangeLike[]; explanation: string; newStates: Record<string, ConceptRatingState> } {
  const { states, weights, problemRating, outcome, evidenceWeight } = input;

  const totalWeight = weights.reduce((s, w) => s + w.weight, 0) || 1;
  const blendedRating =
    weights.reduce((s, w) => s + (states[w.id]?.rating ?? 1200) * w.weight, 0) / totalWeight;
  const blendedUncertainty =
    weights.reduce((s, w) => s + (states[w.id]?.uncertainty ?? 350) * w.weight, 0) / totalWeight;

  const expected = expectedSuccess(blendedRating, problemRating);
  const K = Math.min(48, Math.max(16, 16 + (32 * (blendedUncertainty - 50)) / (350 - 50)));
  const swingTotal = Math.min(64, Math.max(-64, K * (outcome - expected)));

  const changes: ConceptChangeLike[] = [];
  const newStates: Record<string, ConceptRatingState> = { ...states };

  for (const w of weights) {
    const before = states[w.id] ?? { rating: 1200, uncertainty: 350 };
    const swing = swingTotal * w.weight;
    const afterRating = before.rating + swing;
    const afterUncertainty = Math.min(
      350,
      Math.max(50, Math.sqrt(1 / (1 / before.uncertainty ** 2 + evidenceWeight / 180 ** 2))),
    );
    newStates[w.id] = { rating: afterRating, uncertainty: afterUncertainty };
    changes.push({
      concept_id: w.id,
      before_rating: before.rating,
      after_rating: afterRating,
      before_uncertainty: before.uncertainty,
      after_uncertainty: afterUncertainty,
    });
  }

  const direction = swingTotal >= 0 ? "up" : "down";
  const primary = weights.slice().sort((a, b) => b.weight - a.weight)[0];
  const explanation =
    primary === undefined
      ? "No concept weights were attached to this problem."
      : `Outcome ${outcome.toFixed(2)} vs expected ${expected.toFixed(2)} moved ${primary.id} ${direction} by ` +
        `${Math.abs(swingTotal * primary.weight).toFixed(1)} points (K=${K.toFixed(1)}).`;

  return { changes, explanation, newStates };
}

export function scheduleReview(
  state: { review_interval_days: number; review_ease: number; review_reps: number },
  outcome: number,
  now: Date,
): { next_review_at: string; review_interval_days: number; review_ease: number; review_reps: number } {
  const ease = Math.min(2.8, Math.max(1.3, state.review_ease + (0.1 - (1 - outcome) * (0.5 + (1 - outcome) * 0.4))));
  let interval: number;
  let reps: number;
  if (outcome >= 0.6) {
    reps = state.review_reps + 1;
    interval = state.review_reps === 0 ? 1 : state.review_reps === 1 ? 4 : Math.round(state.review_interval_days * ease);
  } else {
    interval = 1;
    reps = 0;
  }
  const next = new Date(now.getTime() + interval * 86_400_000);
  return { next_review_at: next.toISOString(), review_interval_days: interval, review_ease: ease, review_reps: reps };
}
