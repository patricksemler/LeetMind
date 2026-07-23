import { describe, expect, it } from "vitest";
import {
  assembleDiagnostic,
  assembleWorkout,
  nextDiagnosticStep,
  type DiagnosticHistoryEntry,
  type WorkoutCandidateProblem,
} from "./workout.js";
import { expectedSuccess, targetBand } from "./index.js";
import type { ConceptState } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-22T12:00:00.000Z");

function makeState(id: string, overrides: Partial<ConceptState> = {}): ConceptState {
  return {
    concept_id: id,
    rating: 1500,
    uncertainty: 200,
    review_interval_days: 1,
    review_ease: 2.5,
    review_reps: 0,
    ...overrides,
  };
}

function makeCandidate(
  id: string,
  difficulty_rating: number,
  concepts: { id: string; weight: number }[],
  expected_active_minutes: [number, number] = [10, 20],
): WorkoutCandidateProblem {
  return { problem_version_id: id, difficulty_rating, concepts, expected_active_minutes, title: `Problem ${id}` };
}

describe("assembleWorkout", () => {
  it("fills every role when the pool supports it", () => {
    const states: Record<string, ConceptState> = {
      strong: makeState("strong", { rating: 1600, last_practiced_at: new Date(NOW.getTime() - DAY_MS) }),
      weak: makeState("weak", { rating: 1200 }),
    };
    const weakBand = targetBand(states.weak!);

    const candidates: WorkoutCandidateProblem[] = [
      // warm-up: easy relative to `strong` (well above 0.85 P(success))
      makeCandidate("warmup-1", 1200, [{ id: "strong", weight: 1 }]),
      // working set: two candidates squarely in the weak concept's 65-80% band
      makeCandidate("working-1", Math.round(weakBand.ideal), [{ id: "weak", weight: 1 }]),
      makeCandidate("working-2", Math.round(weakBand.min + 5), [{ id: "weak", weight: 1 }]),
      // overload: above the band on the same concept
      makeCandidate("overload-1", Math.round(weakBand.max + 150), [{ id: "weak", weight: 1 }]),
    ];

    const result = assembleWorkout({ candidates, states, now: NOW });

    const roles = result.items.map((i) => i.role);
    expect(roles).toContain("warmup");
    expect(roles).toContain("working");
    expect(roles).toContain("overload");
    // no review due in this fixture -> recovery legitimately absent
    expect(roles).not.toContain("recovery");
    for (const item of result.items) {
      expect(item.rationale.length).toBeGreaterThan(0);
      expect(item.selection_evidence).toBeTypeOf("object");
    }
  });

  it("the working set actually lands in the 65-80% success band", () => {
    const states: Record<string, ConceptState> = { weak: makeState("weak", { rating: 1300 }) };
    const band = targetBand(states.weak!);

    const candidates: WorkoutCandidateProblem[] = [
      makeCandidate("in-band", Math.round(band.ideal), [{ id: "weak", weight: 1 }]),
      makeCandidate("too-easy", Math.round(band.min - 300), [{ id: "weak", weight: 1 }]),
      makeCandidate("too-hard", Math.round(band.max + 300), [{ id: "weak", weight: 1 }]),
    ];

    const result = assembleWorkout({ candidates, states, now: NOW });
    const working = result.items.find((i) => i.role === "working");
    expect(working).toBeDefined();
    expect(working!.problem_version_id).toBe("in-band");
    const p = expectedSuccess(states.weak!.rating, candidates.find((c) => c.problem_version_id === working!.problem_version_id)!.difficulty_rating);
    expect(p).toBeGreaterThanOrEqual(0.65);
    expect(p).toBeLessThanOrEqual(0.8);
  });

  it("overload sits above the working-set band", () => {
    const states: Record<string, ConceptState> = { weak: makeState("weak", { rating: 1300 }) };
    const band = targetBand(states.weak!);

    const candidates: WorkoutCandidateProblem[] = [
      makeCandidate("in-band", Math.round(band.ideal), [{ id: "weak", weight: 1 }]),
      makeCandidate("overload", Math.round(band.max + 120), [{ id: "weak", weight: 1 }]),
    ];

    const result = assembleWorkout({ candidates, states, now: NOW });
    const overload = result.items.find((i) => i.role === "overload");
    expect(overload).toBeDefined();
    expect(overload!.problem_version_id).toBe("overload");
    expect((overload!.selection_evidence as { difficulty_rating: number }).difficulty_rating).toBeGreaterThan(band.max);
  });

  it("recovery only appears when a review is due, and targets the overdue concept", () => {
    const states: Record<string, ConceptState> = {
      weak: makeState("weak", { rating: 1300 }),
      due_concept: makeState("due_concept", { rating: 1400, next_review_at: new Date(NOW.getTime() - 5 * DAY_MS) }),
    };
    const band = targetBand(states.weak!);

    const noReviewCandidates: WorkoutCandidateProblem[] = [
      makeCandidate("in-band", Math.round(band.ideal), [{ id: "weak", weight: 1 }]),
    ];
    const withoutDue = assembleWorkout({
      candidates: noReviewCandidates,
      states: { weak: states.weak! },
      now: NOW,
    });
    expect(withoutDue.items.map((i) => i.role)).not.toContain("recovery");

    const withReviewCandidates: WorkoutCandidateProblem[] = [
      ...noReviewCandidates,
      makeCandidate("review-item", 1400, [{ id: "due_concept", weight: 1 }]),
    ];
    const withDue = assembleWorkout({ candidates: withReviewCandidates, states, now: NOW });
    const recovery = withDue.items.find((i) => i.role === "recovery");
    expect(recovery).toBeDefined();
    expect(recovery!.problem_version_id).toBe("review-item");
  });

  it("respects the duration budget by dropping the lowest-value item rather than overrunning", () => {
    const states: Record<string, ConceptState> = {
      strong: makeState("strong", { rating: 1600 }),
      weak: makeState("weak", { rating: 1200 }),
    };
    const band = targetBand(states.weak!);

    const candidates: WorkoutCandidateProblem[] = [
      makeCandidate("warmup-1", 1200, [{ id: "strong", weight: 1 }], [30, 40]),
      makeCandidate("working-1", Math.round(band.ideal), [{ id: "weak", weight: 1 }], [30, 40]),
      makeCandidate("overload-1", Math.round(band.max + 150), [{ id: "weak", weight: 1 }], [30, 40]),
    ];

    const generous = assembleWorkout({ candidates, states, now: NOW, targetMinutes: 1000 });
    expect(generous.items.length).toBe(3);

    const tight = assembleWorkout({ candidates, states, now: NOW, targetMinutes: 40 });
    expect(tight.estimated_minutes).toBeLessThanOrEqual(40);
    expect(tight.items.length).toBeLessThan(generous.items.length);
    expect(tight.rationale).toMatch(/budget/);
  });

  it("focusConcept restricts working/overload selection to that concept", () => {
    const states: Record<string, ConceptState> = {
      a: makeState("a", { rating: 1200 }),
      b: makeState("b", { rating: 1000 }), // weaker, but not the focus
    };
    const bandA = targetBand(states.a!);

    const candidates: WorkoutCandidateProblem[] = [
      makeCandidate("a-working", Math.round(bandA.ideal), [{ id: "a", weight: 1 }]),
      makeCandidate("b-working", Math.round(targetBand(states.b!).ideal), [{ id: "b", weight: 1 }]),
    ];

    const result = assembleWorkout({ candidates, states, now: NOW, focusConcept: "a" });
    const working = result.items.find((i) => i.role === "working");
    expect(working?.problem_version_id).toBe("a-working");
  });

  it("degrades gracefully on a thin pool instead of throwing", () => {
    const states: Record<string, ConceptState> = { weak: makeState("weak", { rating: 1200 }) };
    const candidates: WorkoutCandidateProblem[] = [
      // Nowhere near any role's criteria: too hard for warm-up, not in-band for working, not
      // above-band for overload (since working itself never got picked).
      makeCandidate("odd", 2400, [{ id: "weak", weight: 1 }]),
    ];

    expect(() => assembleWorkout({ candidates, states, now: NOW })).not.toThrow();
    const result = assembleWorkout({ candidates, states, now: NOW });
    expect(result.items.length).toBe(0);
    expect(result.rationale.length).toBeGreaterThan(0);
  });

  it("handles an entirely empty candidate pool without throwing", () => {
    expect(() => assembleWorkout({ candidates: [], states: {}, now: NOW })).not.toThrow();
    const result = assembleWorkout({ candidates: [], states: {}, now: NOW });
    expect(result.items).toEqual([]);
  });

  it("excludes recentProblemIds", () => {
    const states: Record<string, ConceptState> = { strong: makeState("strong", { rating: 1600 }) };
    const candidates: WorkoutCandidateProblem[] = [makeCandidate("warmup-1", 1200, [{ id: "strong", weight: 1 }])];

    const result = assembleWorkout({ candidates, states, now: NOW, recentProblemIds: ["warmup-1"] });
    expect(result.items.map((i) => i.problem_version_id)).not.toContain("warmup-1");
  });

  it("rationale strings name the concept and its mastery percentage", () => {
    const states: Record<string, ConceptState> = { weak: makeState("weak", { rating: 1300 }) };
    const band = targetBand(states.weak!);
    const candidates: WorkoutCandidateProblem[] = [makeCandidate("w1", Math.round(band.ideal), [{ id: "weak", weight: 1 }])];

    const result = assembleWorkout({ candidates, states, now: NOW });
    const working = result.items.find((i) => i.role === "working")!;
    expect(working.rationale).toContain("weak");
    expect(working.rationale).toMatch(/mastery \d+%/);
  });
});

describe("assembleDiagnostic", () => {
  it("plans one low-mid step per concept cluster, capped at 6", () => {
    const concepts = ["arrays_hashing", "binary_search", "sliding_window", "trees_bst", "graph_traversal", "dp_1d", "greedy"];
    const result = assembleDiagnostic({ concepts, states: {}, now: NOW });
    expect(result.steps.length).toBe(6);
    expect(result.steps.map((s) => s.concept_id)).toEqual(concepts.slice(0, 6));
    for (const step of result.steps) {
      expect(step.target_rating).toBeLessThan(1200); // low-mid, below the 1200 default
      expect(step.rationale).toContain(step.concept_id);
    }
  });

  it("degrades gracefully with zero concepts", () => {
    expect(() => assembleDiagnostic({ concepts: [], states: {}, now: NOW })).not.toThrow();
    const result = assembleDiagnostic({ concepts: [], states: {}, now: NOW });
    expect(result.steps).toEqual([]);
  });
});

describe("nextDiagnosticStep", () => {
  const plan = [
    { concept_id: "arrays_hashing", target_rating: 1050, rationale: "Baseline: arrays_hashing, low-mid difficulty (target 1050)." },
    { concept_id: "binary_search", target_rating: 1050, rationale: "Baseline: binary_search, low-mid difficulty (target 1050)." },
    { concept_id: "sliding_window", target_rating: 1050, rationale: "Baseline: sliding_window, low-mid difficulty (target 1050)." },
  ];

  it("starts at the plan's own baseline with no history", () => {
    const step = nextDiagnosticStep(plan, []);
    expect(step.concept_id).toBe("arrays_hashing");
    expect(step.target_rating).toBe(1050);
    expect(step.done).toBe(false);
  });

  it("steps difficulty UP after a solve", () => {
    const history: DiagnosticHistoryEntry[] = [{ concept_id: "arrays_hashing", target_rating: 1050, outcome: "solved" }];
    const step = nextDiagnosticStep(plan, history);
    expect(step.concept_id).toBe("binary_search");
    expect(step.target_rating).toBeGreaterThan(1050);
  });

  it("drops difficulty FAST after a skip", () => {
    const history: DiagnosticHistoryEntry[] = [{ concept_id: "arrays_hashing", target_rating: 1050, outcome: "skipped" }];
    const step = nextDiagnosticStep(plan, history);
    expect(step.concept_id).toBe("binary_search");
    expect(step.target_rating).toBeLessThan(1050);
  });

  it("drops difficulty after a failure too, and by at least as much as a skip", () => {
    const skipHistory: DiagnosticHistoryEntry[] = [{ concept_id: "arrays_hashing", target_rating: 1050, outcome: "skipped" }];
    const failHistory: DiagnosticHistoryEntry[] = [{ concept_id: "arrays_hashing", target_rating: 1050, outcome: "failed" }];
    const skipStep = nextDiagnosticStep(plan, skipHistory);
    const failStep = nextDiagnosticStep(plan, failHistory);
    expect(failStep.target_rating).toBe(skipStep.target_rating);
    expect(failStep.target_rating).toBeLessThan(1050);
  });

  it("reports done once every planned concept has been probed", () => {
    const history: DiagnosticHistoryEntry[] = plan.map((s) => ({ concept_id: s.concept_id, target_rating: s.target_rating, outcome: "solved" }));
    const step = nextDiagnosticStep(plan, history);
    expect(step.done).toBe(true);
    expect(step.concept_id).toBeNull();
  });

  it("skips concepts already present in history even out of order", () => {
    const history: DiagnosticHistoryEntry[] = [{ concept_id: "binary_search", target_rating: 1050, outcome: "solved" }];
    const step = nextDiagnosticStep(plan, history);
    expect(step.concept_id).toBe("arrays_hashing");
  });
});
