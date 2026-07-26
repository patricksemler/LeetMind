import { describe, expect, it } from "vitest";
import {
  assembleBaseline,
  nextBaselineStep,
  BASELINE_ITEM_COUNT,
  type BaselineHistoryEntry,
} from "./baseline.js";
import type { ConceptState } from "./types.js";

const NOW = new Date("2026-01-15T12:00:00Z");

describe("assembleBaseline", () => {
  it("plans one low-mid step per concept cluster, capped at 6", () => {
    const concepts = ["arrays_hashing", "binary_search", "sliding_window", "trees_bst", "graph_traversal", "dp_1d", "greedy"];
    const result = assembleBaseline({ concepts, states: {}, now: NOW });
    expect(result.steps.length).toBe(6);
    expect(result.steps.map((s) => s.concept_id)).toEqual(concepts.slice(0, 6));
    for (const step of result.steps) {
      expect(step.target_rating).toBeLessThan(1200); // low-mid, below the 1200 default
      expect(step.rationale).toContain(step.concept_id);
    }
  });

  it("degrades gracefully with zero concepts", () => {
    expect(() => assembleBaseline({ concepts: [], states: {}, now: NOW })).not.toThrow();
    const result = assembleBaseline({ concepts: [], states: {}, now: NOW });
    expect(result.steps).toEqual([]);
  });
});

describe("nextBaselineStep", () => {
  const plan = [
    { concept_id: "arrays_hashing", target_rating: 1050, rationale: "Baseline: arrays_hashing, low-mid difficulty (target 1050)." },
    { concept_id: "binary_search", target_rating: 1050, rationale: "Baseline: binary_search, low-mid difficulty (target 1050)." },
    { concept_id: "sliding_window", target_rating: 1050, rationale: "Baseline: sliding_window, low-mid difficulty (target 1050)." },
  ];

  it("starts at the plan's own baseline with no history", () => {
    const step = nextBaselineStep(plan, []);
    expect(step.concept_id).toBe("arrays_hashing");
    expect(step.target_rating).toBe(1050);
    expect(step.done).toBe(false);
  });

  it("steps difficulty UP after a solve", () => {
    const history: BaselineHistoryEntry[] = [{ concept_id: "arrays_hashing", target_rating: 1050, outcome: "solved" }];
    const step = nextBaselineStep(plan, history);
    expect(step.concept_id).toBe("binary_search");
    expect(step.target_rating).toBeGreaterThan(1050);
  });

  it("drops difficulty FAST after a skip", () => {
    const history: BaselineHistoryEntry[] = [{ concept_id: "arrays_hashing", target_rating: 1050, outcome: "skipped" }];
    const step = nextBaselineStep(plan, history);
    expect(step.concept_id).toBe("binary_search");
    expect(step.target_rating).toBeLessThan(1050);
  });

  it("drops difficulty after a failure too, and by at least as much as a skip", () => {
    const skipHistory: BaselineHistoryEntry[] = [{ concept_id: "arrays_hashing", target_rating: 1050, outcome: "skipped" }];
    const failHistory: BaselineHistoryEntry[] = [{ concept_id: "arrays_hashing", target_rating: 1050, outcome: "failed" }];
    const skipStep = nextBaselineStep(plan, skipHistory);
    const failStep = nextBaselineStep(plan, failHistory);
    expect(failStep.target_rating).toBe(skipStep.target_rating);
    expect(failStep.target_rating).toBeLessThan(1050);
  });

  it("reports done once every planned concept has been probed", () => {
    const history: BaselineHistoryEntry[] = plan.map((s) => ({ concept_id: s.concept_id, target_rating: s.target_rating, outcome: "solved" }));
    const step = nextBaselineStep(plan, history);
    expect(step.done).toBe(true);
    expect(step.concept_id).toBeNull();
  });

  it("skips concepts already present in history even out of order", () => {
    const history: BaselineHistoryEntry[] = [{ concept_id: "binary_search", target_rating: 1050, outcome: "solved" }];
    const step = nextBaselineStep(plan, history);
    expect(step.concept_id).toBe("arrays_hashing");
  });
});

describe("baseline planning details not covered by the ported suite", () => {
  function state(rating: number): ConceptState {
    return {
      concept_id: "arrays_hashing",
      rating,
      uncertainty: 350,
      last_practiced_at: null,
      next_review_at: null,
      review_interval_days: 1,
      review_ease: 2.5,
      review_reps: 0,
    };
  }

  it("caps the plan at the exported BASELINE_ITEM_COUNT", () => {
    const concepts = Array.from({ length: BASELINE_ITEM_COUNT + 5 }, (_, i) => `c${i}`);
    expect(assembleBaseline({ concepts, states: {}, now: NOW }).steps.length).toBe(BASELINE_ITEM_COUNT);
  });

  it("lets an existing high self-rating nudge the start up, but never below the low-mid floor", () => {
    const fresh = assembleBaseline({ concepts: ["arrays_hashing"], states: {}, now: NOW }).steps[0]!;
    const strong = assembleBaseline({
      concepts: ["arrays_hashing"],
      states: { arrays_hashing: state(1800) },
      now: NOW,
    }).steps[0]!;
    const weak = assembleBaseline({
      concepts: ["arrays_hashing"],
      states: { arrays_hashing: state(600) },
      now: NOW,
    }).steps[0]!;

    expect(strong.target_rating).toBeGreaterThan(fresh.target_rating);
    // A self-rating that is *lower* than the floor must not drag the probe below it — the whole
    // point of "self-ratings seed, never establish mastery".
    expect(weak.target_rating).toBe(fresh.target_rating);
  });

  it("clamps a long solve streak to the plan's maximum probe rating", () => {
    const concepts = Array.from({ length: BASELINE_ITEM_COUNT }, (_, i) => `c${i}`);
    const plan = assembleBaseline({ concepts, states: {}, now: NOW }).steps;
    const history: BaselineHistoryEntry[] = plan.slice(0, -1).map((s) => ({
      concept_id: s.concept_id,
      target_rating: s.target_rating,
      outcome: "solved",
    }));
    const step = nextBaselineStep(plan, history);
    expect(step.target_rating).toBeLessThanOrEqual(2000);
    expect(step.target_rating).toBeGreaterThanOrEqual(800);
  });

  it("treats an empty plan as immediately done rather than looping forever", () => {
    const step = nextBaselineStep([], []);
    expect(step.done).toBe(true);
    expect(step.concept_id).toBeNull();
  });
});

describe("step rationale copy", () => {
  const plan = [
    { concept_id: "a", target_rating: 1050, rationale: "Baseline: a." },
    { concept_id: "b", target_rating: 1050, rationale: "Baseline: b." },
  ];

  it("reads as a sentence for every outcome — the raw enum interpolated as 'after a skipped on a'", () => {
    for (const [outcome, phrase] of [
      ["skipped", "after a skip on a"],
      ["failed", "after a give-up on a"],
    ] as const) {
      const step = nextBaselineStep(plan, [{ concept_id: "a", target_rating: 1050, outcome }]);
      expect(step.rationale).toContain(phrase);
    }
    const solved = nextBaselineStep(plan, [{ concept_id: "a", target_rating: 1050, outcome: "solved" }]);
    expect(solved.rationale).toContain("Stepped up after a solve on a");
  });
});
