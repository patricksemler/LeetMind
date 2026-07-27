import { describe, expect, it } from "vitest";
import { updateConcepts } from "./update.js";
import { expectedSuccess, kFactor } from "./rating.js";
import type { ConceptState } from "./types.js";

function makeState(rating: number, uncertainty: number): ConceptState {
  return {
    concept_id: "c",
    rating,
    uncertainty,
    review_interval_days: 1,
    review_ease: 2.5,
    review_reps: 0,
  };
}

describe("updateConcepts — Elo delta direction and magnitude", () => {
  it("an unexpected win (harder problem) raises rating more than an expected win (easier problem)", () => {
    const states = { c1: makeState(1500, 200) };
    const weights = [{ id: "c1", weight: 1 }];

    const unexpectedWin = updateConcepts({
      states,
      weights,
      problemRating: 1700, // much harder than the user -> low expected success
      outcome: 1,
      evidenceWeight: 1,
    });

    const expectedWin = updateConcepts({
      states,
      weights,
      problemRating: 1450, // easier than the user -> high expected success
      outcome: 1,
      evidenceWeight: 1,
    });

    expect(unexpectedWin.changes[0]!.delta).toBeGreaterThan(expectedWin.changes[0]!.delta);
    expect(unexpectedWin.changes[0]!.delta).toBeGreaterThan(0);
    expect(expectedWin.changes[0]!.delta).toBeGreaterThan(0);
  });

  it("a loss to an easy problem drops rating more than a loss to a hard problem", () => {
    const states = { c1: makeState(1500, 200) };
    const weights = [{ id: "c1", weight: 1 }];

    const lossToEasy = updateConcepts({
      states,
      weights,
      problemRating: 1300, // easier than the user -> high expected success, so losing hurts more
      outcome: 0,
      evidenceWeight: 1,
    });

    const lossToHard = updateConcepts({
      states,
      weights,
      problemRating: 1700, // harder than the user -> low expected success, so losing barely surprises
      outcome: 0,
      evidenceWeight: 1,
    });

    expect(Math.abs(lossToEasy.changes[0]!.delta)).toBeGreaterThan(
      Math.abs(lossToHard.changes[0]!.delta),
    );
    expect(lossToEasy.changes[0]!.delta).toBeLessThan(0);
    expect(lossToHard.changes[0]!.delta).toBeLessThan(0);
  });

  it("matches the hand-derived K*(outcome-expected)*evidenceWeight formula for a single concept", () => {
    const states = { c1: makeState(1500, 200) };
    const weights = [{ id: "c1", weight: 1 }];
    const result = updateConcepts({
      states,
      weights,
      problemRating: 1650,
      outcome: 0.75,
      evidenceWeight: 1,
    });

    const expected = expectedSuccess(1500, 1650);
    const k = kFactor(200);
    const expectedDelta = k * (0.75 - expected) * 1;

    expect(result.expected).toBeCloseTo(expected, 10);
    expect(result.changes[0]!.delta).toBeCloseTo(expectedDelta, 6);
  });
});

describe("updateConcepts — delta split by weight", () => {
  it("splits delta across concepts proportionally to their (normalized) weight", () => {
    const states = {
      strong: makeState(1600, 150),
      weak: makeState(1200, 300),
    };
    const weights = [
      { id: "strong", weight: 0.6 },
      { id: "weak", weight: 0.4 },
    ];

    const result = updateConcepts({
      states,
      weights,
      problemRating: 1500,
      outcome: 1,
      evidenceWeight: 1,
    });

    const strongChange = result.changes.find((c) => c.concept_id === "strong")!;
    const weakChange = result.changes.find((c) => c.concept_id === "weak")!;

    // ratio of deltas should match ratio of weights
    expect(strongChange.delta / weakChange.delta).toBeCloseTo(0.6 / 0.4, 6);
    expect(strongChange.weight).toBeCloseTo(0.6, 10);
    expect(weakChange.weight).toBeCloseTo(0.4, 10);
  });

  it("normalizes weights that don't sum to 1 before splitting", () => {
    const states = { a: makeState(1500, 200), b: makeState(1500, 200) };
    const normalized = updateConcepts({
      states,
      weights: [
        { id: "a", weight: 0.5 },
        { id: "b", weight: 0.5 },
      ],
      problemRating: 1600,
      outcome: 1,
      evidenceWeight: 1,
    });
    const unnormalized = updateConcepts({
      states,
      weights: [
        { id: "a", weight: 5 },
        { id: "b", weight: 5 },
      ],
      problemRating: 1600,
      outcome: 1,
      evidenceWeight: 1,
    });

    expect(unnormalized.changes[0]!.delta).toBeCloseTo(normalized.changes[0]!.delta, 6);
  });
});

describe("updateConcepts — swing cap", () => {
  it("caps |delta| at 64 before splitting, even at extreme rating mismatches", () => {
    const states = { c1: makeState(800, 350) };
    const weights = [{ id: "c1", weight: 1 }];

    // Extreme mismatch + an inflated evidenceWeight (beyond outcomeScore's normal 0/0.5/1 range)
    // to actually exercise the cap: K_max=48, so evidenceWeight=1 alone can never reach 64.
    const result = updateConcepts({
      states,
      weights,
      problemRating: 2400,
      outcome: 1,
      evidenceWeight: 3,
    });

    expect(Math.abs(result.changes[0]!.delta)).toBeLessThanOrEqual(64 + 1e-9);
    expect(result.changes[0]!.delta).toBeCloseTo(64, 6);
  });

  it("splits the capped delta (not the raw delta) across concepts", () => {
    const states = { a: makeState(800, 350), b: makeState(800, 350) };
    const weights = [
      { id: "a", weight: 0.5 },
      { id: "b", weight: 0.5 },
    ];
    const result = updateConcepts({
      states,
      weights,
      problemRating: 2400,
      outcome: 1,
      evidenceWeight: 3,
    });
    const total = result.changes.reduce((sum, c) => sum + c.delta, 0);
    expect(total).toBeCloseTo(64, 6);
  });
});

describe("updateConcepts — uncertainty update", () => {
  it("decreases monotonically as more evidence accumulates, and never breaches [50,350]", () => {
    let state = makeState(1500, 350);
    let prevUncertainty = state.uncertainty;

    for (let i = 0; i < 30; i++) {
      const result = updateConcepts({
        states: { c1: state },
        weights: [{ id: "c1", weight: 1 }],
        problemRating: 1500,
        outcome: 0.7,
        evidenceWeight: 1,
      });
      const after = result.changes[0]!.after_uncertainty;
      // Strictly decreasing until it saturates at the floor (50); once there, it must stay there.
      if (prevUncertainty > 50) {
        expect(after).toBeLessThan(prevUncertainty);
      } else {
        expect(after).toBe(50);
      }
      expect(after).toBeGreaterThanOrEqual(50);
      expect(after).toBeLessThanOrEqual(350);
      state = { ...state, rating: result.changes[0]!.after_rating, uncertainty: after };
      prevUncertainty = after;
    }
  });

  it("never breaches the floor even with a very high evidence weight", () => {
    const states = { c1: makeState(1500, 55) };
    const result = updateConcepts({
      states,
      weights: [{ id: "c1", weight: 1 }],
      problemRating: 1500,
      outcome: 0.5,
      evidenceWeight: 100,
    });
    expect(result.changes[0]!.after_uncertainty).toBeGreaterThanOrEqual(50);
  });
});

describe("updateConcepts — explanation", () => {
  it("reads as prose: the setup, what the outcome meant, and where each concept moved", () => {
    const states = {
      sliding_window: makeState(1380, 142),
      arrays_hashing: makeState(1450, 100),
    };
    const weights = [
      { id: "sliding_window", weight: 0.7 },
      { id: "arrays_hashing", weight: 0.3 },
    ];

    const result = updateConcepts({
      states,
      weights,
      problemRating: 1420,
      outcome: 0.75,
      evidenceWeight: 1,
      highestHint: "l2_conceptual",
    });

    expect(result.explanation).toContain("This problem was rated 1420");
    expect(result.explanation).toContain("sliding_window");
    expect(result.explanation).toContain("arrays_hashing");
    // The hint is named — in the ladder's own words, not by rung number — because it is why this
    // scored less than a clean solve.
    expect(result.explanation).toContain("after a conceptual hint");
    expect(result.explanation).not.toMatch(/\bL2\b/);
    // The raw 0..1 evidence score is model-internal and must NOT leak into the prose — it is the
    // single least interpretable thing the update produces.
    expect(result.explanation).not.toContain("0.75");

    for (const change of result.changes) {
      // The stated destination and magnitude are both derived from the ROUNDED before/after
      // ratings, so the sentence can never disagree with the numbers rendered beside it.
      const roundedDelta = Math.round(change.after_rating) - Math.round(change.before_rating);
      const direction = roundedDelta > 0 ? "up" : "down";
      expect(result.explanation).toContain(
        `${change.concept_id} ${direction} ${Math.abs(roundedDelta)} to ${Math.round(change.after_rating)}`,
      );
    }
  });

  it("says plainly that the problem wasn't solved, and moves the concept down", () => {
    const states = { c1: makeState(1500, 200) };
    const result = updateConcepts({
      states,
      weights: [{ id: "c1", weight: 1 }],
      problemRating: 1300,
      outcome: 0,
      evidenceWeight: 1,
    });
    expect(result.changes[0]!.delta).toBeLessThan(0);
    const roundedDelta =
      Math.round(result.changes[0]!.after_rating) - Math.round(result.changes[0]!.before_rating);
    expect(result.explanation).toContain("You didn't solve it this time.");
    expect(result.explanation).toContain(
      `c1 down ${Math.abs(roundedDelta)} to ${Math.round(result.changes[0]!.after_rating)}`,
    );
  });

  it("frames a long-odds problem as odds rather than a bare percentage", () => {
    const states = { c1: makeState(1200, 200) };
    const result = updateConcepts({
      states,
      weights: [{ id: "c1", weight: 1 }],
      problemRating: 1450,
      outcome: 1,
      evidenceWeight: 1,
    });
    expect(result.explanation).toMatch(/about a 1 in \d+ chance/);
    expect(result.explanation).toContain("You solved it unaided.");
  });

  it("reports tightened uncertainty as confidence, not as a ± pair", () => {
    const states = { c1: makeState(1200, 350) };
    const result = updateConcepts({
      states,
      weights: [{ id: "c1", weight: 1 }],
      problemRating: 1200,
      outcome: 1,
      evidenceWeight: 1,
    });
    expect(result.changes[0]!.after_uncertainty).toBeLessThan(
      result.changes[0]!.before_uncertainty,
    );
    expect(result.explanation).toContain("more confident than before");
    expect(result.explanation).not.toContain("±");
  });

  it("QA-PLAN.md §3: the displayed delta always agrees with the displayed before/after ratings, even when rounding the raw delta independently would not", () => {
    // Raw delta rounds to 0, but the endpoints (rounded independently) could differ by 1 — exactly
    // the "+0 (1500→1501)" bug. The sentence must describe the SAME rounded numbers.
    const states = { c1: makeState(1500.4, 200) };
    const result = updateConcepts({
      states,
      weights: [{ id: "c1", weight: 0.01 }],
      problemRating: 1500,
      outcome: 1,
      evidenceWeight: 0.001,
    });
    const change = result.changes[0]!;
    const roundedBefore = Math.round(change.before_rating);
    const roundedAfter = Math.round(change.after_rating);
    const roundedDelta = roundedAfter - roundedBefore;

    if (roundedDelta === 0) {
      expect(result.explanation).toContain(`c1 unchanged at ${roundedAfter}`);
    } else {
      const direction = roundedDelta > 0 ? "up" : "down";
      expect(result.explanation).toContain(
        `c1 ${direction} ${Math.abs(roundedDelta)} to ${roundedAfter}`,
      );
    }
  });
});
