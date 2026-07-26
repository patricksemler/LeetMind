/**
 * Baseline planning — `POST /api/baseline/start` (CONTRACTS.md §9, PLAN.md §8 "Diagnostic
 * onboarding"). Pure: no I/O, no clock reads except the injected `now`.
 *
 * This is what survives the removal of the workout ladder. Because a baseline must adapt to
 * outcomes that haven't happened yet, `assembleBaseline` plans *targets* (concept + rating) rather
 * than picking real candidates — apps/api resolves each target against its own approved pool, one
 * item at a time, via `nextBaselineStep`.
 */

import type { ConceptState } from "./types.js";

function conceptName(id: string): string {
  return id;
}

/** How many concept clusters one baseline probes. Exported so the API can report progress
 * ("3 of 6") without re-deriving it. */
export const BASELINE_ITEM_COUNT = 6;
const BASELINE_START_RATING = 1050; // low-mid: below the 1200 default, per PLAN.md §8.
const BASELINE_STEP_UP = 120; // steps UP on success
const BASELINE_STEP_DOWN = 220; // drops FAST on skip/failure
const BASELINE_MIN_RATING = 800;
const BASELINE_MAX_RATING = 2000;

export interface BaselinePlanStep {
  concept_id: string;
  target_rating: number;
  rationale: string;
}

export interface AssembleBaselineInput {
  /** Ordered concept clusters to probe (e.g. taxonomy roots by sort_order), one item planned per
   * cluster, capped at `BASELINE_ITEM_COUNT`. */
  concepts: string[];
  /** Existing state, if any (e.g. a self-seeded config rating) — only ever used to seed a
   * slightly-adjusted starting point; self-ratings seed, never establish mastery (PLAN.md §8). */
  states: Record<string, ConceptState>;
  now: Date;
}

export interface AssembleBaselineResult {
  steps: BaselinePlanStep[];
  rationale: string;
}

/** Plans the baseline's concept coverage and each concept's naive low-mid starting point. Does
 * NOT pick real problems (this package has no DB access) — the API resolves each step's
 * `(concept_id, target_rating)` against its own approved pool. Difficulty *within* the plan then
 * adapts as results come in via `nextBaselineStep`, which is why this returns the full concept
 * sequence but callers should treat only the next unresolved step's rating as authoritative. */
export function assembleBaseline(input: AssembleBaselineInput): AssembleBaselineResult {
  const { concepts, states, now } = input;
  const chosen = concepts.slice(0, BASELINE_ITEM_COUNT);

  const steps: BaselinePlanStep[] = chosen.map((conceptId) => {
    const existing = states[conceptId];
    // A self-seeded rating nudges the start (never below the low-mid floor) rather than being
    // trusted outright — "self-ratings only seed, never establish mastery" (PLAN.md §8).
    const target = existing ? Math.max(BASELINE_START_RATING, Math.round((existing.rating + BASELINE_START_RATING) / 2)) : BASELINE_START_RATING;
    return {
      concept_id: conceptId,
      target_rating: target,
      rationale: `Baseline: ${conceptName(conceptId)}, low-mid difficulty (target ${target}).`,
    };
  });

  void now; // kept for a future recency-aware seed ("you last practiced this 40 days ago").

  const rationale =
    steps.length > 0
      ? `Short adaptive baseline across ${steps.length} concept${steps.length === 1 ? "" : "s"} ` +
        `(${steps.map((s) => conceptName(s.concept_id)).join(", ")}). Skip anything unfamiliar — ` +
        `that's useful signal, not a failure.`
      : "No concepts were available to plan a baseline.";

  return { steps, rationale };
}

export type BaselineOutcome = "solved" | "skipped" | "failed";

/** Reads as a noun phrase inside "Dropped fast after ___ on <concept>". Interpolating the raw
 * outcome produced "after a skipped on arrays_hashing" in the live UI. */
const OUTCOME_PHRASE: Record<BaselineOutcome, string> = {
  solved: "a solve",
  skipped: "a skip",
  failed: "a give-up",
};

export interface BaselineHistoryEntry {
  concept_id: string;
  target_rating: number;
  outcome: BaselineOutcome;
}

export interface BaselineStepResult {
  /** `null` once every planned concept has been probed. */
  concept_id: string | null;
  target_rating: number;
  rationale: string;
  done: boolean;
}

/**
 * Given the plan from `assembleBaseline` and the history of items actually resolved so far,
 * returns the next concept to probe and its target rating — carrying momentum from the most
 * recent outcome (step UP on success, drop FAST on skip/failure) rather than blindly using the
 * plan's naive low-mid baseline for every concept. This is what lets the API drive the baseline
 * one item at a time instead of fixing all difficulties up front.
 */
export function nextBaselineStep(plan: BaselinePlanStep[], history: BaselineHistoryEntry[]): BaselineStepResult {
  const probed = new Set(history.map((h) => h.concept_id));
  const next = plan.find((s) => !probed.has(s.concept_id));

  if (!next) {
    return { concept_id: null, target_rating: BASELINE_START_RATING, rationale: "Baseline plan complete.", done: true };
  }

  if (history.length === 0) {
    return { concept_id: next.concept_id, target_rating: next.target_rating, rationale: next.rationale, done: false };
  }

  const last = history[history.length - 1]!;
  const clamp = (x: number) => Math.min(BASELINE_MAX_RATING, Math.max(BASELINE_MIN_RATING, x));

  if (last.outcome === "solved") {
    const target = clamp(next.target_rating + BASELINE_STEP_UP);
    return {
      concept_id: next.concept_id,
      target_rating: target,
      rationale: `Stepped up after a solve on ${conceptName(last.concept_id)}: probing ${conceptName(next.concept_id)} at ${target}.`,
      done: false,
    };
  }

  const target = clamp(next.target_rating - BASELINE_STEP_DOWN);
  return {
    concept_id: next.concept_id,
    target_rating: target,
    rationale: `Dropped fast after ${OUTCOME_PHRASE[last.outcome]} on ${conceptName(last.concept_id)}: probing ${conceptName(next.concept_id)} at ${target}.`,
    done: false,
  };
}
