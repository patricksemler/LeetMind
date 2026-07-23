/**
 * Spaced review: SM-2-style scheduler + inactivity uncertainty decay. CONTRACTS.md §8.
 * Pure — no I/O; `now` is always injected by the caller, never read internally.
 */

import type { ConceptState } from "./types.js";
import { clamp } from "./rating.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EASE_MIN = 1.3;
const EASE_MAX = 2.8;
const UNCERTAINTY_CEILING = 350;
const DECAY_RATE_PER_DAY = 3;

export interface ScheduleReviewResult {
  next_review_at: Date;
  review_interval_days: number;
  review_ease: number;
  review_reps: number;
}

/**
 * SM-2 variant, CONTRACTS.md §8 exactly:
 *   ease' = clamp(ease + (0.1 - (1 - outcome) * (0.5 + (1 - outcome) * 0.4)), 1.3, 2.8)
 *   outcome >= 0.6 -> interval' = reps===0 ? 1 : reps===1 ? 4 : round(interval * ease'), reps++
 *   else           -> interval' = 1, reps = 0
 *
 * `reps` in the branch condition is the state's CURRENT rep count (before increment) — it decides
 * which rung of the ladder this review lands on. The new ease' (not the old ease) is used for the
 * `interval * ease` step, matching standard SM-2 (E-Factor is updated before it's used to project
 * the next interval).
 */
export function scheduleReview(state: ConceptState, outcome: number, now: Date): ScheduleReviewResult {
  const newEase = clamp(
    state.review_ease + (0.1 - (1 - outcome) * (0.5 + (1 - outcome) * 0.4)),
    EASE_MIN,
    EASE_MAX
  );

  let newInterval: number;
  let newReps: number;

  if (outcome >= 0.6) {
    if (state.review_reps === 0) {
      newInterval = 1;
    } else if (state.review_reps === 1) {
      newInterval = 4;
    } else {
      newInterval = Math.round(state.review_interval_days * newEase);
    }
    newReps = state.review_reps + 1;
  } else {
    newInterval = 1;
    newReps = 0;
  }

  const nextReviewAt = new Date(now.getTime() + newInterval * MS_PER_DAY);

  return {
    next_review_at: nextReviewAt,
    review_interval_days: newInterval,
    review_ease: newEase,
    review_reps: newReps,
  };
}

/**
 * Inactivity growth: uncertainty grows with idle days and saturates at 350.
 *   u' = min(350, sqrt(u^2 + (daysIdle * 3)^2))
 * Returns a new ConceptState with `uncertainty` updated; all other fields pass through unchanged.
 * If the concept has never been practiced (`last_practiced_at` is null/undefined), there is no
 * idle baseline to decay from, so the state is returned unchanged.
 */
export function decayUncertainty(state: ConceptState, now: Date): ConceptState {
  if (!state.last_practiced_at) {
    return state;
  }

  const lastPracticedAt = new Date(state.last_practiced_at);
  const daysIdle = Math.max(0, (now.getTime() - lastPracticedAt.getTime()) / MS_PER_DAY);
  const grown = Math.sqrt(state.uncertainty ** 2 + (daysIdle * DECAY_RATE_PER_DAY) ** 2);
  const newUncertainty = Math.min(UNCERTAINTY_CEILING, grown);

  return { ...state, uncertainty: newUncertainty };
}

export interface ReviewDueEntry {
  concept_id: string;
  days_overdue: number;
  state: ConceptState;
}

/**
 * Concepts whose `next_review_at` has passed, sorted most-overdue first.
 */
export function reviewsDue(states: Record<string, ConceptState>, now: Date): ReviewDueEntry[] {
  const due: ReviewDueEntry[] = [];

  for (const [conceptId, state] of Object.entries(states)) {
    if (!state.next_review_at) continue;
    const nextReviewAt = new Date(state.next_review_at);
    if (nextReviewAt.getTime() > now.getTime()) continue;

    const daysOverdue = (now.getTime() - nextReviewAt.getTime()) / MS_PER_DAY;
    due.push({ concept_id: conceptId, days_overdue: daysOverdue, state });
  }

  due.sort((a, b) => b.days_overdue - a.days_overdue);
  return due;
}
