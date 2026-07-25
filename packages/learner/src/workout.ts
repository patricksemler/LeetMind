/**
 * Workout assembly — CONTRACTS.md §9 (`POST /api/workouts`, `POST /api/diagnostic/start`) and
 * PLAN.md §8 "Diagnostic onboarding" / "Workouts". Pure — no I/O, no clock reads except the
 * injected `now`. Built on top of `scoreCandidate`/`targetBand` (src/select.ts) and `reviewsDue`
 * (src/review.ts), per the `TODO(M3)` left at the bottom of src/select.ts.
 *
 * `assembleWorkout` picks real candidates from an approved-and-unattempted pool the caller
 * already fetched (this package has no DB access, so it never invents a problem). `assembleDiagnostic`
 * / `nextDiagnosticStep` are one level more abstract: since the diagnostic must adapt to outcomes
 * that haven't happened yet, they plan *targets* (concept + rating) rather than picking real
 * candidates — the API resolves each target against its own approved pool (the same widen-band
 * search `GET /api/problems/next` already does) one item at a time.
 */

import type { CandidateProblem, ConceptState, ConceptWeight } from "./types.js";
import { blendedRating, expectedSuccess } from "./rating.js";
import { scoreCandidate, targetBand, type TargetBand } from "./select.js";
import { reviewsDue } from "./review.js";

const DEFAULT_CONCEPT_RATING = 1200;
const DEFAULT_CONCEPT_UNCERTAINTY = 350;

/** `expectedSuccess` against this baseline is used as a simple, human-readable "mastery %" —
 * 50% at the default starting rating, above/below as the user's rating diverges from it. Mirrors
 * `BASE_RATING` in src/select.ts (not exported from there, so re-declared here at the same value). */
const MASTERY_BASELINE_RATING = 1200;

function masteryPct(rating: number): number {
  return Math.round(expectedSuccess(rating, MASTERY_BASELINE_RATING) * 100);
}

function defaultConceptState(conceptId: string): ConceptState {
  return {
    concept_id: conceptId,
    rating: DEFAULT_CONCEPT_RATING,
    uncertainty: DEFAULT_CONCEPT_UNCERTAINTY,
    last_practiced_at: null,
    next_review_at: null,
    review_interval_days: 1,
    review_ease: 2.5,
    review_reps: 0,
  };
}

/** Fills in a default state for every concept referenced by `candidates` but missing from
 * `states`, without mutating the caller's object — `scoreCandidate`/`targetBand` both throw on a
 * missing concept state, and a thin/fresh profile legitimately has gaps. */
function withDefaults(
  states: Record<string, ConceptState>,
  candidates: readonly { concepts: ConceptWeight[] }[],
): Record<string, ConceptState> {
  const filled: Record<string, ConceptState> = { ...states };
  for (const c of candidates) {
    for (const w of c.concepts) {
      if (!filled[w.id]) filled[w.id] = defaultConceptState(w.id);
    }
  }
  return filled;
}

function conceptName(id: string): string {
  return id;
}

// --- assembleWorkout -------------------------------------------------------------------------

export interface WorkoutCandidateProblem extends CandidateProblem {
  /** [low, high] expected active minutes (ProblemVersion.expected_active_minutes) — the only
   * extra field this module needs beyond `CandidateProblem` to budget duration. */
  expected_active_minutes: [number, number];
  title?: string;
}

export type WorkoutItemRole = "warmup" | "working" | "overload" | "recovery";

export interface AssembleWorkoutInput {
  candidates: WorkoutCandidateProblem[];
  states: Record<string, ConceptState>;
  now: Date;
  /** Soft budget in minutes. When set and the assembled set overruns it, the lowest-value item
   * is dropped (repeatedly) until the set fits — never fabricated, never silently overrun. */
  targetMinutes?: number;
  /** Restricts WORKING and OVERLOAD selection to problems touching this concept. Warm-up and
   * recovery are deliberately not restricted — confidence-building and spaced review are their
   * own concerns, orthogonal to today's focus topic. */
  focusConcept?: string;
  /** Problem version ids to exclude outright (already attempted this session / recently seen). */
  recentProblemIds?: string[];
}

export interface AssembledWorkoutItem {
  role: WorkoutItemRole;
  problem_version_id: string;
  rationale: string;
  selection_evidence: Record<string, unknown>;
  estimated_minutes: number;
}

export interface AssembleWorkoutResult {
  items: AssembledWorkoutItem[];
  /** Workout-level summary: which roles were filled and why, and which were omitted and why —
   * never silent about a role the pool couldn't support. */
  rationale: string;
  estimated_minutes: number;
}

const WARM_UP_MIN_P = 0.85;
const WORKING_SET_TARGET_COUNT = 2;

interface ScoredPick {
  role: WorkoutItemRole;
  candidate: WorkoutCandidateProblem;
  score: number;
  factors: Record<string, number>;
  rationale: string;
}

function estimatedMinutesOf(candidate: WorkoutCandidateProblem): number {
  const [low, high] = candidate.expected_active_minutes;
  return (low + high) / 2;
}

function buildSelectionEvidence(pick: ScoredPick, band?: TargetBand): Record<string, unknown> {
  return {
    ...pick.factors,
    score: pick.score,
    difficulty_rating: pick.candidate.difficulty_rating,
    expected_active_minutes: pick.candidate.expected_active_minutes,
    title: pick.candidate.title,
    ...(band ? { band: { min: band.min, max: band.max, ideal: band.ideal } } : {}),
  };
}

/** Warm-up: a candidate with high P(success) for the user, preferring a concept practiced
 * recently (or, absent any practice history, the strongest contributing concept) — "loosens up"
 * per PLAN.md §8, never the hard part of the session. */
function pickWarmup(
  pool: WorkoutCandidateProblem[],
  states: Record<string, ConceptState>,
  now: Date,
): ScoredPick | null {
  const qualifying = pool.filter((c) => {
    const blended = blendedRating(states, c.concepts);
    return expectedSuccess(blended.rating, c.difficulty_rating) >= WARM_UP_MIN_P;
  });
  if (qualifying.length === 0) return null;

  function recencyScore(c: WorkoutCandidateProblem): number {
    let best = -Infinity;
    for (const w of c.concepts) {
      const state = states[w.id];
      if (state?.last_practiced_at) {
        best = Math.max(best, new Date(state.last_practiced_at).getTime());
      }
    }
    return best;
  }

  qualifying.sort((a, b) => {
    const recencyDiff = recencyScore(b) - recencyScore(a);
    if (recencyDiff !== 0) return recencyDiff;
    const ratingA = blendedRating(states, a.concepts).rating;
    const ratingB = blendedRating(states, b.concepts).rating;
    return ratingB - ratingA;
  });

  const chosen = qualifying[0]!;
  const scored = scoreCandidate({ problem: chosen, states, now });
  const dominant = chosen.concepts.reduce((best, c) => (c.weight > best.weight ? c : best));
  const pct = masteryPct(states[dominant.id]?.rating ?? DEFAULT_CONCEPT_RATING);

  return {
    role: "warmup",
    candidate: chosen,
    score: scored.score,
    factors: scored.factors,
    rationale:
      `Warm-up: ${conceptName(dominant.id)} (mastery ${pct}%) — high predicted success, builds ` +
      `confidence and confirms retention before the working set.`,
  };
}

/** Working set: 1-2 candidates in the 65-80% band on the weakest eligible concept. Falls back to
 * the next-weakest concept if the weakest has no in-band candidate, rather than giving up. */
function pickWorkingSet(
  pool: WorkoutCandidateProblem[],
  states: Record<string, ConceptState>,
  now: Date,
  focusConcept: string | undefined,
  weakestFirst: string[],
): { picks: ScoredPick[]; targetConcept: string | null } {
  const conceptOrder = focusConcept ? [focusConcept] : weakestFirst;

  for (const conceptId of conceptOrder) {
    const state = states[conceptId];
    if (!state) continue;
    const band = targetBand(state);

    const inBand = pool.filter(
      (c) =>
        c.concepts.some((w) => w.id === conceptId) &&
        c.difficulty_rating >= band.min &&
        c.difficulty_rating <= band.max,
    );
    if (inBand.length === 0) continue;

    const scored = inBand
      .map((candidate) => ({ candidate, ...scoreCandidate({ problem: candidate, states, now }) }))
      .sort((a, b) => b.score - a.score);

    const picks: ScoredPick[] = scored.slice(0, WORKING_SET_TARGET_COUNT).map(({ candidate, score, factors }) => {
      const pct = masteryPct(state.rating);
      return {
        role: "working",
        candidate,
        score,
        factors,
        rationale:
          `Targets ${conceptName(conceptId)}: mastery ${pct}%, your weakest contributing concept — ` +
          `lands in the 65-80% success band (problem rated ${Math.round(candidate.difficulty_rating)}).`,
      };
    });

    return { picks, targetConcept: conceptId };
  }

  return { picks: [], targetConcept: null };
}

/** Overload: one candidate deliberately above the working-set band on the same target concept
 * (or a multi-concept combination touching it) — the only item expected to be hard. */
function pickOverload(
  pool: WorkoutCandidateProblem[],
  states: Record<string, ConceptState>,
  now: Date,
  targetConcept: string,
  band: TargetBand,
): ScoredPick | null {
  const above = pool.filter(
    (c) => c.concepts.some((w) => w.id === targetConcept) && c.difficulty_rating > band.max,
  );
  if (above.length === 0) return null;

  above.sort((a, b) => {
    // Closest above the band first; among ties, prefer a multi-concept combination (more
    // concepts touched = more "combination" in PLAN.md §8's sense).
    const distDiff = a.difficulty_rating - b.difficulty_rating;
    if (distDiff !== 0) return distDiff;
    return b.concepts.length - a.concepts.length;
  });

  const chosen = above[0]!;
  const scored = scoreCandidate({ problem: chosen, states, now });
  const state = states[targetConcept];
  const pct = masteryPct(state?.rating ?? DEFAULT_CONCEPT_RATING);
  const combo = chosen.concepts.length > 1;

  return {
    role: "overload",
    candidate: chosen,
    score: scored.score,
    factors: scored.factors,
    rationale: combo
      ? `Overload: combines ${chosen.concepts.map((c) => conceptName(c.id)).join(" + ")} above your ` +
        `${conceptName(targetConcept)} band (mastery ${pct}%) — deliberately the hard rep, testing the ceiling.`
      : `Overload: ${conceptName(targetConcept)} rated above your 65-80% band (mastery ${pct}%) — ` +
        `deliberately the hard rep, testing the ceiling.`,
  };
}

/** Recovery: the most-overdue due review with an available candidate. */
function pickRecovery(
  pool: WorkoutCandidateProblem[],
  states: Record<string, ConceptState>,
  now: Date,
): { pick: ScoredPick | null; anyDue: boolean } {
  const due = reviewsDue(states, now);
  if (due.length === 0) return { pick: null, anyDue: false };

  for (const entry of due) {
    const candidate = pool.find((c) => c.concepts.some((w) => w.id === entry.concept_id));
    if (!candidate) continue;
    const scored = scoreCandidate({ problem: candidate, states, now });
    const pct = masteryPct(entry.state.rating);
    return {
      pick: {
        role: "recovery",
        candidate,
        score: scored.score,
        factors: scored.factors,
        rationale:
          `Recovery: ${conceptName(entry.concept_id)} review is ${entry.days_overdue.toFixed(1)} days ` +
          `overdue (mastery ${pct}%) — spaced repetition keeps it from decaying.`,
      },
      anyDue: true,
    };
  }
  return { pick: null, anyDue: true };
}

export function assembleWorkout(input: AssembleWorkoutInput): AssembleWorkoutResult {
  const { candidates, now, targetMinutes, focusConcept } = input;
  const recentExclusions = new Set(input.recentProblemIds ?? []);

  const pool = candidates.filter((c) => !recentExclusions.has(c.problem_version_id));
  const states = withDefaults(input.states, pool);

  const notes: string[] = [];
  const picked: ScoredPick[] = [];
  const usedIds = new Set<string>();

  function remaining(): WorkoutCandidateProblem[] {
    return pool.filter((c) => !usedIds.has(c.problem_version_id));
  }

  // Weakest-first concept ranking over every concept actually reachable in the pool (or just
  // focusConcept, if given) — shared between the working-set and overload picks.
  const poolConceptIds = new Set<string>();
  for (const c of pool) for (const w of c.concepts) poolConceptIds.add(w.id);
  const weakestFirst = [...poolConceptIds]
    .filter((id) => (focusConcept ? id === focusConcept : true))
    .sort((a, b) => (states[a]?.rating ?? DEFAULT_CONCEPT_RATING) - (states[b]?.rating ?? DEFAULT_CONCEPT_RATING));

  const warmup = pickWarmup(remaining(), states, now);
  if (warmup) {
    picked.push(warmup);
    usedIds.add(warmup.candidate.problem_version_id);
  } else {
    notes.push("No warm-up today — nothing in the pool was safely easy enough.");
  }

  const { picks: workingPicks, targetConcept } = pickWorkingSet(remaining(), states, now, focusConcept, weakestFirst);
  for (const pick of workingPicks) {
    picked.push(pick);
    usedIds.add(pick.candidate.problem_version_id);
  }
  if (workingPicks.length === 0) {
    notes.push(
      focusConcept
        ? `No ${conceptName(focusConcept)} problem landed in range for the working set today.`
        : "No working-set problem landed in range for your weakest concepts.",
    );
  }

  if (targetConcept) {
    const band = targetBand(states[targetConcept]!);
    const overload = pickOverload(remaining(), states, now, targetConcept, band);
    if (overload) {
      picked.push(overload);
      usedIds.add(overload.candidate.problem_version_id);
    } else {
      notes.push(`No ${conceptName(targetConcept)} problem was hard enough for an overload rep today.`);
    }
  } else {
    notes.push("No overload rep — no working-set target to build on.");
  }

  const { pick: recovery, anyDue } = pickRecovery(remaining(), states, now);
  if (recovery) {
    picked.push(recovery);
    usedIds.add(recovery.candidate.problem_version_id);
  } else if (anyDue) {
    notes.push("A review is due, but there's no problem available for it yet.");
  }
  // No note when nothing is due at all — that's the normal case, not a shortfall.

  // Duration budgeting: drop the lowest-value (lowest scoreCandidate score) item until the plan
  // fits `targetMinutes`, rather than ever silently overrunning it.
  let items = picked.map((pick) => ({
    pick,
    minutes: estimatedMinutesOf(pick.candidate),
  }));
  const dropped: ScoredPick[] = [];
  if (targetMinutes !== undefined) {
    let total = items.reduce((sum, i) => sum + i.minutes, 0);
    while (total > targetMinutes && items.length > 0) {
      let lowestIdx = 0;
      for (let i = 1; i < items.length; i += 1) {
        if (items[i]!.pick.score < items[lowestIdx]!.pick.score) lowestIdx = i;
      }
      const [removed] = items.splice(lowestIdx, 1);
      if (removed) {
        dropped.push(removed.pick);
        total -= removed.minutes;
      }
    }
  }
  if (dropped.length > 0) {
    notes.push(
      `Dropped ${dropped.map((d) => `${d.role} (${conceptName(d.candidate.concepts[0]?.id ?? "?")})`).join(", ")} ` +
        `to fit the ${targetMinutes}-minute budget.`,
    );
  }

  const resultItems: AssembledWorkoutItem[] = items.map(({ pick, minutes }) => {
    const targetConceptState = targetConcept ? states[targetConcept] : undefined;
    const band = targetConceptState && pick.role !== "warmup" && pick.role !== "recovery" ? targetBand(targetConceptState) : undefined;
    return {
      role: pick.role,
      problem_version_id: pick.candidate.problem_version_id,
      rationale: pick.rationale,
      selection_evidence: buildSelectionEvidence(pick, band),
      estimated_minutes: Math.round(minutes),
    };
  });

  const estimatedMinutes = resultItems.reduce((sum, i) => sum + i.estimated_minutes, 0);

  const filledSummary =
    resultItems.length > 0
      ? `${resultItems.length} item${resultItems.length === 1 ? "" : "s"} (${resultItems.map((i) => i.role).join(", ")}), ~${estimatedMinutes} min.`
      : "No candidates were available to assemble a workout.";
  const rationale = [filledSummary, ...notes].join(" ");

  return { items: resultItems, rationale, estimated_minutes: estimatedMinutes };
}

// --- assembleDiagnostic / nextDiagnosticStep ---------------------------------------------------

const DIAGNOSTIC_ITEM_COUNT = 6;
const DIAGNOSTIC_START_RATING = 1050; // low-mid: below the 1200 default, per PLAN.md §8.
const DIAGNOSTIC_STEP_UP = 120; // steps UP on success
const DIAGNOSTIC_STEP_DOWN = 220; // drops FAST on skip/failure
const DIAGNOSTIC_MIN_RATING = 800;
const DIAGNOSTIC_MAX_RATING = 2000;

export interface DiagnosticPlanStep {
  concept_id: string;
  target_rating: number;
  rationale: string;
}

export interface AssembleDiagnosticInput {
  /** Ordered concept clusters to probe (e.g. taxonomy roots by sort_order), one item planned per
   * cluster, capped at `DIAGNOSTIC_ITEM_COUNT`. */
  concepts: string[];
  /** Existing state, if any (e.g. a self-seeded config rating) — only ever used to seed a
   * slightly-adjusted starting point; self-ratings seed, never establish mastery (PLAN.md §8). */
  states: Record<string, ConceptState>;
  now: Date;
}

export interface AssembleDiagnosticResult {
  steps: DiagnosticPlanStep[];
  rationale: string;
}

/** Plans the diagnostic's concept coverage and each concept's naive low-mid starting point. Does
 * NOT pick real problems (this package has no DB access) — the API resolves each step's
 * `(concept_id, target_rating)` against its own approved pool. Difficulty *within* the plan then
 * adapts as results come in via `nextDiagnosticStep`, which is why this returns the full concept
 * sequence but callers should treat only the next unresolved step's rating as authoritative. */
export function assembleDiagnostic(input: AssembleDiagnosticInput): AssembleDiagnosticResult {
  const { concepts, states, now } = input;
  const chosen = concepts.slice(0, DIAGNOSTIC_ITEM_COUNT);

  const steps: DiagnosticPlanStep[] = chosen.map((conceptId) => {
    const existing = states[conceptId];
    // A self-seeded rating nudges the start (never below the low-mid floor) rather than being
    // trusted outright — "self-ratings only seed, never establish mastery" (PLAN.md §8).
    const target = existing ? Math.max(DIAGNOSTIC_START_RATING, Math.round((existing.rating + DIAGNOSTIC_START_RATING) / 2)) : DIAGNOSTIC_START_RATING;
    return {
      concept_id: conceptId,
      target_rating: target,
      rationale: `Baseline: ${conceptName(conceptId)}, low-mid difficulty (target ${target}).`,
    };
  });

  void now; // kept for signature symmetry with assembleWorkout / a future recency-aware seed.

  const rationale =
    steps.length > 0
      ? `Short adaptive baseline across ${steps.length} concept${steps.length === 1 ? "" : "s"} ` +
        `(${steps.map((s) => conceptName(s.concept_id)).join(", ")}). Skip anything unfamiliar — ` +
        `that's useful signal, not a failure.`
      : "No concepts were available to plan a diagnostic.";

  return { steps, rationale };
}

export type DiagnosticOutcome = "solved" | "skipped" | "failed";

export interface DiagnosticHistoryEntry {
  concept_id: string;
  target_rating: number;
  outcome: DiagnosticOutcome;
}

export interface DiagnosticStepResult {
  /** `null` once every planned concept has been probed. */
  concept_id: string | null;
  target_rating: number;
  rationale: string;
  done: boolean;
}

/**
 * Given the plan from `assembleDiagnostic` and the history of items actually resolved so far,
 * returns the next concept to probe and its target rating — carrying momentum from the most
 * recent outcome (step UP on success, drop FAST on skip/failure) rather than blindly using the
 * plan's naive low-mid baseline for every concept. This is what lets the API drive the diagnostic
 * one item at a time instead of fixing all difficulties up front.
 */
export function nextDiagnosticStep(plan: DiagnosticPlanStep[], history: DiagnosticHistoryEntry[]): DiagnosticStepResult {
  const probed = new Set(history.map((h) => h.concept_id));
  const next = plan.find((s) => !probed.has(s.concept_id));

  if (!next) {
    return { concept_id: null, target_rating: DIAGNOSTIC_START_RATING, rationale: "Diagnostic plan complete.", done: true };
  }

  if (history.length === 0) {
    return { concept_id: next.concept_id, target_rating: next.target_rating, rationale: next.rationale, done: false };
  }

  const last = history[history.length - 1]!;
  const clamp = (x: number) => Math.min(DIAGNOSTIC_MAX_RATING, Math.max(DIAGNOSTIC_MIN_RATING, x));

  if (last.outcome === "solved") {
    const target = clamp(next.target_rating + DIAGNOSTIC_STEP_UP);
    return {
      concept_id: next.concept_id,
      target_rating: target,
      rationale: `Stepped up after a solve on ${conceptName(last.concept_id)}: probing ${conceptName(next.concept_id)} at ${target}.`,
      done: false,
    };
  }

  const target = clamp(next.target_rating - DIAGNOSTIC_STEP_DOWN);
  return {
    concept_id: next.concept_id,
    target_rating: target,
    rationale: `Dropped fast after a ${last.outcome} on ${conceptName(last.concept_id)}: probing ${conceptName(next.concept_id)} at ${target}.`,
    done: false,
  };
}
