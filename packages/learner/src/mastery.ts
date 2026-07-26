/**
 * Explicit mastery — `isMastered`. Pure: no I/O, no clock reads except the injected `now`.
 *
 * Until now mastery was implicit in the rating number: a concept was "mastered" when its rating
 * looked high, which a single lucky solve on an over-rated problem can produce. That is the thing
 * a rating is worst at. A rating is a running estimate of *current* ability under uncertainty; it
 * cannot distinguish "solved three different problems unaided over three weeks" from "solved one
 * problem after four hints yesterday and hasn't been asked since", because both can land on 1500.
 *
 * So mastery is a separate, harder claim with its own evidence bar, and every clause below exists
 * to rule out a specific way of looking mastered without being:
 *
 *   rating          — you are at the top of this concept's own difficulty band, not the global one.
 *                     `bit_manipulation` tops out at 1900 and `shortest_paths` at 2600; a flat
 *                     global threshold would make the easy concepts unmasterable and the hard ones
 *                     free.
 *   uncertainty     — the estimate is actually settled. Rules out a high rating that is really one
 *                     big swing from a wide prior.
 *   unassisted      — solved without touching the hint ladder. A concept carried by hints is a
 *                     concept you can recognise, not one you can do.
 *   distinct        — across different problems. Rules out one problem solved repeatedly.
 *   spaced          — first and last unassisted solve at least a week apart. This is the clause
 *                     that separates mastery from cramming, and the only one that cannot be
 *                     satisfied in a single sitting no matter how well it goes.
 *
 * The result reports every clause rather than a bare boolean so the UI can show what is left
 * ("2 of 5") instead of an opaque locked state — a mastery bar you cannot see the inside of is
 * indistinguishable from an arbitrary one.
 */

import type { ConceptState } from "./types.js";

/** Where in a concept's own [min_rating, max_rating] band mastery begins. 0.7 puts
 * `arrays_hashing` (800–1800) at 1500 and `dp_2d` (1400–2600) at 2240. */
export const MASTERY_BAND_FRACTION = 0.7;

/** The estimate must be this settled. The uncertainty floor is 50 and the fresh-state ceiling is
 * 350, so 100 is "several pieces of consistent evidence", not "one swing". */
export const MASTERY_MAX_UNCERTAINTY = 100;

export const MASTERY_MIN_UNASSISTED_SOLVES = 3;
export const MASTERY_MIN_DISTINCT_PROBLEMS = 3;

/** Days that must separate the first and last unassisted solve. One week is the shortest span
 * that cannot be produced by a single long session. */
export const MASTERY_MIN_SPAN_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface MasteryEvidence {
  /** Solves on this concept with no hint rung taken at all. */
  unassistedSolves: number;
  /** Distinct `problem_version_id`s among those unassisted solves. */
  distinctProblems: number;
  /** Timestamp of the earliest unassisted solve, or null if there are none. */
  firstUnassistedSolveAt: string | Date | null;
  /** Timestamp of the latest unassisted solve, or null if there are none. */
  lastUnassistedSolveAt: string | Date | null;
}

export interface ConceptBand {
  min_rating: number;
  max_rating: number;
}

export interface MasteryCriterion {
  key: "rating" | "uncertainty" | "unassisted" | "distinct" | "spaced";
  met: boolean;
  /** What the user has. */
  actual: number;
  /** What they need. */
  required: number;
  /** One line, addressed to the learner, saying what this clause is asking for. */
  label: string;
}

export interface MasteryResult {
  mastered: boolean;
  criteria: MasteryCriterion[];
  /** How many clauses are satisfied, for a "3 of 5" display. */
  met: number;
  total: number;
  /** The rating this concept's band requires. */
  threshold: number;
  /** One sentence naming the nearest unmet clause, or confirming mastery. */
  summary: string;
}

export function masteryThreshold(band: ConceptBand): number {
  return band.min_rating + MASTERY_BAND_FRACTION * (band.max_rating - band.min_rating);
}

/** Whole days between two instants, or 0 when either is missing. */
function spanDays(from: string | Date | null, to: string | Date | null): number {
  if (!from || !to) return 0;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return ms <= 0 ? 0 : ms / MS_PER_DAY;
}

export function isMastered(input: {
  state: ConceptState;
  band: ConceptBand;
  evidence: MasteryEvidence;
}): MasteryResult {
  const { state, band, evidence } = input;
  const threshold = masteryThreshold(band);
  const span = spanDays(evidence.firstUnassistedSolveAt, evidence.lastUnassistedSolveAt);

  const criteria: MasteryCriterion[] = [
    {
      key: "rating",
      met: state.rating >= threshold,
      actual: Math.round(state.rating),
      required: Math.round(threshold),
      label: "Reach the top of this concept's difficulty range",
    },
    {
      key: "uncertainty",
      // Inverted: lower uncertainty is better, so `actual <= required` is the passing direction.
      met: state.uncertainty <= MASTERY_MAX_UNCERTAINTY,
      actual: Math.round(state.uncertainty),
      required: MASTERY_MAX_UNCERTAINTY,
      label: "Settle the estimate — enough consistent results to be confident",
    },
    {
      key: "unassisted",
      met: evidence.unassistedSolves >= MASTERY_MIN_UNASSISTED_SOLVES,
      actual: evidence.unassistedSolves,
      required: MASTERY_MIN_UNASSISTED_SOLVES,
      label: "Solve without hints",
    },
    {
      key: "distinct",
      met: evidence.distinctProblems >= MASTERY_MIN_DISTINCT_PROBLEMS,
      actual: evidence.distinctProblems,
      required: MASTERY_MIN_DISTINCT_PROBLEMS,
      label: "Across different problems, not the same one again",
    },
    {
      key: "spaced",
      met: span >= MASTERY_MIN_SPAN_DAYS,
      actual: Math.floor(span),
      required: MASTERY_MIN_SPAN_DAYS,
      label: "Spread over at least a week, so it is retention and not cramming",
    },
  ];

  const met = criteria.filter((c) => c.met).length;
  const mastered = met === criteria.length;

  return {
    mastered,
    criteria,
    met,
    total: criteria.length,
    threshold,
    summary: buildSummary(mastered, criteria),
  };
}

function buildSummary(mastered: boolean, criteria: MasteryCriterion[]): string {
  if (mastered) return "Mastered — solved unaided, across different problems, spread over time.";

  // Name the single nearest unmet clause rather than listing all of them: a checklist of five
  // things you have not done reads as a wall, and only one of them is the next thing to do.
  const unmet = criteria.filter((c) => !c.met);
  const next = unmet[0];
  if (!next) return "Mastered.";

  switch (next.key) {
    case "rating":
      return `Not yet: you are at ${next.actual} and this concept's mastery line is ${next.required}.`;
    case "uncertainty":
      return `Not yet: the estimate is still loose (give or take ${next.actual} points, needs ${next.required} or tighter).`;
    case "unassisted":
      return `Not yet: ${next.actual} of ${next.required} hint-free solves.`;
    case "distinct":
      return `Not yet: ${next.actual} of ${next.required} different problems solved unaided.`;
    case "spaced":
      return `Not yet: your unaided solves span ${next.actual} of the ${next.required} days needed to show retention.`;
  }
}
