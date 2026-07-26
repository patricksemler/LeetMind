/**
 * Cold start — the first few problems a brand-new user sees, before there is enough evidence for
 * `scoreCandidate` to target an honest edge. Pure: no I/O, no clock reads.
 *
 * This is what the **baseline** became. The baseline was the same math wearing a product surface:
 * a session you started, a plan persisted up front, a progress counter ("3 of 6"), and a
 * `needs_baseline` gate on `GET /api/practice/next` that refused to serve a problem until you had
 * been through it. All of that was ceremony around one question — *how hard should problem N be?* —
 * and the stepping rule below is the entire answer. So the rule stays and the surface is gone: a
 * new user opens the app and gets a problem, and these six problems calibrate them without ever
 * announcing themselves as calibration.
 *
 * Why a separate rule at all, rather than letting the Glicko update handle it from problem one:
 * `updateConcepts` is capped at `SWING_CAP` (64) per problem, deliberately, so that one unlucky
 * result can't wreck a settled rating. That cap is exactly wrong when there is no settled rating
 * yet — a beginner seeded at 1200 would need ~6 straight failures to reach 1050, and would spend
 * all six being handed problems well past their level. Stepping moves 120 up / 220 down, so it
 * finds the right neighbourhood in about two problems and then hands off.
 *
 * The asymmetry (down almost twice as fast as up) is the same judgment the baseline was built on:
 * being handed something far too hard is what makes someone quit, and being handed something a bit
 * too easy costs one problem. Failing fast downward is the cheaper error.
 */

/** How many problems the cold-start rule governs before `scoreCandidate` takes over. Exported so
 * the API can decide which selection path to use without re-deriving the number. */
export const COLD_START_PROBLEM_COUNT = 6;

/** Deliberately below the 1200 seed in `user_concept_state`: an unknown user is likelier to be
 * below the notional average than above it, and the cost of guessing low is one easy problem. */
export const COLD_START_RATING = 1050;

const STEP_UP = 120;
const STEP_DOWN = 220;
const MIN_RATING = 800;
const MAX_RATING = 2000;

export type ColdStartOutcome = "solved" | "skipped" | "failed";

export interface ColdStartHistoryEntry {
  concept_id: string;
  outcome: ColdStartOutcome;
}

export interface ColdStartStep {
  /** `null` once the cold start is over and normal selection should take over. */
  concept_id: string | null;
  target_rating: number;
  rationale: string;
  done: boolean;
}

/** Reads as a noun phrase inside "after ___". Interpolating the raw outcome produced "after a
 * skipped on arrays_hashing" in the live UI. */
const OUTCOME_PHRASE: Record<ColdStartOutcome, string> = {
  solved: "a solve",
  skipped: "a skip",
  failed: "a give-up",
};

function clampRating(x: number): number {
  return Math.min(MAX_RATING, Math.max(MIN_RATING, x));
}

/**
 * The next (concept, difficulty) the cold start wants, given the concepts available in taxonomy
 * order and everything resolved so far.
 *
 * Difficulty **accumulates** across the whole history rather than stepping once off a fixed
 * starting point. The baseline version this replaces recomputed `1050 ± one step` from only the
 * most recent outcome, so three solves in a row still asked for 1170 — it could register that you
 * were doing well and then decline to act on it. Here three solves reach 1410, which is the point
 * of having a stepping rule at all.
 *
 * Breadth comes from walking `orderedConcepts` (the taxonomy's own `sort_order`, foundational
 * first) and never probing the same concept twice: six problems across six concepts says much more
 * about where someone is than six problems in one.
 */
export function nextColdStartStep(
  orderedConcepts: string[],
  history: ColdStartHistoryEntry[],
): ColdStartStep {
  const target = history.reduce(
    (rating, entry) => clampRating(rating + (entry.outcome === "solved" ? STEP_UP : -STEP_DOWN)),
    COLD_START_RATING,
  );

  if (history.length >= COLD_START_PROBLEM_COUNT) {
    return {
      concept_id: null,
      target_rating: target,
      rationale: "Cold start complete — normal selection takes over.",
      done: true,
    };
  }

  const probed = new Set(history.map((h) => h.concept_id));
  const next = orderedConcepts.find((id) => !probed.has(id));
  if (!next) {
    return {
      concept_id: null,
      target_rating: target,
      rationale: "Every concept has been probed — normal selection takes over.",
      done: true,
    };
  }

  const last = history[history.length - 1];
  if (!last) {
    return {
      concept_id: next,
      target_rating: target,
      rationale: `Starting at ${next}, a little below average difficulty (${target}) — the first few problems find your level.`,
      done: false,
    };
  }

  const direction = last.outcome === "solved" ? "Stepped up" : "Dropped fast";
  return {
    concept_id: next,
    target_rating: target,
    rationale: `${direction} after ${OUTCOME_PHRASE[last.outcome]} on ${last.concept_id}: trying ${next} at ${target}.`,
    done: false,
  };
}
