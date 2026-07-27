/**
 * `outcomeScore` — CONTRACTS.md §8 outcome schedule, implemented exactly.
 *
 * Order of operations (documented and tested, see src/outcome.test.ts):
 *   1. base            — from verdict / give-up / skip
 *   2. hint cap         — outcome = min(base, HINT_PENALTY_CAPS[highestHint])
 *   3. modifiers        — time modifier + submission-count modifier, additive
 *   4. clamp-to-cap     — final = clamp(capped + modifiers, 0, cap)
 *
 * We clamp to the CAP (not just to [0,1]) as the last step, so that "cap-then-modifier" can never
 * be defeated by a modifier pushing the outcome back above a hint cap that was supposed to bound
 * it (e.g. a fast, low-hint-penalty solve should never end up scoring above what the hint ladder
 * allows). When no hint was taken, cap == 1, so clamp-to-cap and clamp-to-[0,1] coincide.
 */

import type { HintLevel, Verdict } from "./types.js";
import { HINT_PENALTY_CAPS } from "./types.js";
import { clamp } from "./rating.js";

export interface OutcomeInput {
  verdict: Verdict | null;
  gaveUp: boolean;
  skipped: "inability" | "preference" | null;
  highestHint: HintLevel | null;
  /** Active (focused) milliseconds spent on the problem. */
  activeMs: number;
  /** [low, high] expected active minutes for the problem. */
  expectedMinutes: [number, number];
  /** Count of submissions that were not compile-error-only (i.e. actually ran). */
  substantiveSubmissions: number;
  /** Count of compile-error verdicts seen for this problem attempt so far. */
  compileErrors: number;
}

export interface OutcomeResult {
  outcome: number;
  evidenceWeight: number;
  breakdown: Record<string, number>;
  skipped?: true;
  excluded?: true;
  reason?: string;
  errorCategory?: "compilation";
}

const WRONG_ANSWER_GRADE_BASE = 0.15;

/** Time modifier: +0.1 under the low band, 0 within band, linear down to -0.1 at >= 2x the high band. */
function timeModifier(activeMs: number, expectedMinutes: [number, number]): number {
  const [low, high] = expectedMinutes;
  const activeMinutes = activeMs / 60_000;

  if (activeMinutes <= low) return 0.1;
  if (activeMinutes <= high) return 0;

  const twiceHigh = 2 * high;
  if (activeMinutes >= twiceHigh) return -0.1;

  const frac = (activeMinutes - high) / (twiceHigh - high);
  return -0.1 * frac;
}

/** -0.02 per substantive submission beyond the first, floored at -0.08. */
function submissionModifier(substantiveSubmissions: number): number {
  const extra = Math.max(0, substantiveSubmissions - 1);
  return Math.max(-0.08, -0.02 * extra);
}

/** Applies hint cap, then modifiers, then clamps to the cap. Returns outcome + a summed breakdown. */
function capAndModify(
  base: number,
  highestHint: HintLevel | null,
  activeMs: number,
  expectedMinutes: [number, number],
  substantiveSubmissions: number,
): { outcome: number; breakdown: Record<string, number> } {
  const cap = highestHint ? HINT_PENALTY_CAPS[highestHint] : 1;
  const capped = Math.min(base, cap);
  const timeMod = timeModifier(activeMs, expectedMinutes);
  const subMod = submissionModifier(substantiveSubmissions);
  const preClamp = capped + timeMod + subMod;
  const final = clamp(preClamp, 0, cap);

  const breakdown: Record<string, number> = {
    base,
    hint_cap: capped - base,
    time_modifier: timeMod,
    submission_modifier: subMod,
    clamp: final - preClamp,
  };

  return { outcome: final, breakdown };
}

export function outcomeScore(input: OutcomeInput): OutcomeResult {
  const {
    verdict,
    gaveUp,
    skipped,
    highestHint,
    activeMs,
    expectedMinutes,
    substantiveSubmissions,
    compileErrors,
  } = input;

  // skip(preference): no learning event at all — caller must not write one.
  if (skipped === "preference") {
    return { outcome: 0, evidenceWeight: 0, breakdown: {}, skipped: true };
  }

  // skip(inability): fixed 0 outcome at reduced evidence weight.
  if (skipped === "inability") {
    return {
      outcome: 0,
      evidenceWeight: 0.5,
      breakdown: { base: 0 },
    };
  }

  // give-up / abandon: fixed 0 outcome, full evidence weight.
  if (gaveUp) {
    return {
      outcome: 0,
      evidenceWeight: 1,
      breakdown: { base: 0 },
    };
  }

  if (verdict === "accepted") {
    const { outcome, breakdown } = capAndModify(
      1.0,
      highestHint,
      activeMs,
      expectedMinutes,
      substantiveSubmissions,
    );
    return { outcome, evidenceWeight: 1, breakdown };
  }

  // Compile-error-only attempt: excluded unless it has recurred >= 3 times, in which case it is
  // graded as a wrong-answer-tier outcome and tagged with an error category.
  if (verdict === "compilation_error") {
    if (compileErrors < 3) {
      return {
        outcome: 0,
        evidenceWeight: 0,
        breakdown: {},
        excluded: true,
        reason: `compile-error-only attempt (${compileErrors} < 3) excluded from mastery impact`,
      };
    }
    const { outcome, breakdown } = capAndModify(
      WRONG_ANSWER_GRADE_BASE,
      highestHint,
      activeMs,
      expectedMinutes,
      substantiveSubmissions,
    );
    return { outcome, evidenceWeight: 1, breakdown, errorCategory: "compilation" };
  }

  // System-caused, non-evidentiary verdicts: never penalize the user for judge/infra failures.
  if (verdict === "cancelled" || verdict === "internal_error") {
    return {
      outcome: 0,
      evidenceWeight: 0,
      breakdown: {},
      excluded: true,
      reason: `verdict "${verdict}" is system-caused, not evidence of skill`,
    };
  }

  // Any other terminal, substantive-but-failed verdict (wrong_answer, runtime_error, time_limit,
  // memory_limit, output_limit) grades at the wrong-answer tier, provided a substantive submission
  // actually happened.
  if (verdict !== null) {
    if (substantiveSubmissions < 1) {
      return {
        outcome: 0,
        evidenceWeight: 0,
        breakdown: {},
        excluded: true,
        reason: `verdict "${verdict}" with no substantive submission recorded`,
      };
    }
    const { outcome, breakdown } = capAndModify(
      WRONG_ANSWER_GRADE_BASE,
      highestHint,
      activeMs,
      expectedMinutes,
      substantiveSubmissions,
    );
    return { outcome, evidenceWeight: 1, breakdown };
  }

  // No verdict, no give-up, no skip: nothing happened worth scoring.
  return {
    outcome: 0,
    evidenceWeight: 0,
    breakdown: {},
    excluded: true,
    reason: "no verdict, give-up, or skip to score",
  };
}
