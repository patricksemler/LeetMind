/**
 * `@leetmind/learner` — pure Glicko-lite mastery engine (rating/uncertainty, outcome scoring,
 * SM-2 review scheduling, next-problem selection). CONTRACTS.md §8. No I/O; every function that
 * needs the current time takes it as an injected `now: Date` parameter.
 */

export * from "./types.js";
export * from "./rating.js";
export * from "./outcome.js";
export * from "./update.js";
export * from "./review.js";
export * from "./select.js";
export * from "./coldstart.js";
export * from "./teaching.js";
export * from "./mastery.js";

import { HINT_PENALTY_CAPS } from "./types.js";
import { BAND_HIGH_P, BAND_LOW_P, DEFAULT_SELECTION_WEIGHTS } from "./select.js";
import { COLD_START_PROBLEM_COUNT, COLD_START_RATING } from "./coldstart.js";
import { REINFORCE_RATING_DROP, TEACHING_FAILURE_STREAK, TRANSFER_DELAY_DAYS } from "./teaching.js";
import {
  MASTERY_BAND_FRACTION,
  MASTERY_MAX_UNCERTAINTY,
  MASTERY_MIN_DISTINCT_PROBLEMS,
  MASTERY_MIN_SPAN_DAYS,
  MASTERY_MIN_UNASSISTED_SOLVES,
} from "./mastery.js";

/**
 * Every tunable number in the learner engine, in one place, so `/system` can display them and
 * tests can assert against them directly instead of hard-coding magic numbers twice.
 */
export const LEARNER_CONSTANTS = {
  /** K-factor bounds (CONTRACTS.md §8). */
  K_MIN: 16,
  K_MAX: 48,
  /** Uncertainty (RD) floor/ceiling shared by both the evidence update and inactivity decay. */
  UNCERTAINTY_FLOOR: 50,
  UNCERTAINTY_CEILING: 350,
  /** Starting values for a fresh `user_concept_state` row. */
  INITIAL_RATING: 1200,
  INITIAL_UNCERTAINTY: 350,
  /** Evidence sigma used in the uncertainty-shrink formula: u' = sqrt(1 / (1/u^2 + w/sigma^2)). */
  EVIDENCE_SIGMA: 180,
  /** Per-problem Elo swing cap, applied before splitting delta across concepts by weight. */
  SWING_CAP: 64,
  /** Hint penalty caps applied to the outcome score, keyed by hint level. */
  HINT_PENALTY_CAPS,
  /** Inactivity uncertainty growth rate: u' = min(ceiling, sqrt(u^2 + (daysIdle * rate)^2)). */
  UNCERTAINTY_DECAY_RATE_PER_DAY: 3,
  /** Outcome modifier bounds. */
  TIME_MODIFIER_MAX: 0.1,
  SUBMISSION_MODIFIER_FLOOR: -0.08,
  SUBMISSION_MODIFIER_PER_EXTRA: -0.02,
  /** SM-2 ease-factor bounds. */
  SM2_EASE_MIN: 1.3,
  SM2_EASE_MAX: 2.8,
  /** Target success-probability band edges used by `targetBand` (PLAN.md §7/§8). */
  TARGET_BAND_LOW_P: BAND_LOW_P,
  TARGET_BAND_HIGH_P: BAND_HIGH_P,
  /** Default weights for `scoreCandidate` (M1 selection heuristic; see src/select.ts). */
  SELECTION_WEIGHTS: DEFAULT_SELECTION_WEIGHTS,
  /** Cold start: how many problems the stepping rule governs, and where it starts (src/coldstart.ts). */
  COLD_START_PROBLEM_COUNT,
  COLD_START_RATING,
  /** Teaching mode trigger and its two follow-ups (src/teaching.ts). */
  TEACHING_FAILURE_STREAK,
  REINFORCE_RATING_DROP,
  TRANSFER_DELAY_DAYS,
  /** The five clauses of explicit mastery (src/mastery.ts). */
  MASTERY_BAND_FRACTION,
  MASTERY_MAX_UNCERTAINTY,
  MASTERY_MIN_UNASSISTED_SOLVES,
  MASTERY_MIN_DISTINCT_PROBLEMS,
  MASTERY_MIN_SPAN_DAYS,
} as const;
