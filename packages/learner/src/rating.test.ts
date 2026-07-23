import { describe, expect, it } from "vitest";
import { blendedRating, expectedSuccess, kFactor } from "./rating.js";

describe("expectedSuccess", () => {
  it("is 0.5 for equal ratings", () => {
    expect(expectedSuccess(1500, 1500)).toBeCloseTo(0.5, 10);
  });

  it("is ~0.909 when the user is 400 above the problem", () => {
    expect(expectedSuccess(1600, 1200)).toBeCloseTo(0.909, 3);
  });

  it("is ~0.091 when the user is 400 below the problem", () => {
    expect(expectedSuccess(1200, 1600)).toBeCloseTo(0.091, 3);
  });

  it("is symmetric: p(user,problem) + p(problem-as-user, user-as-problem) == 1", () => {
    const p1 = expectedSuccess(1600, 1200);
    const p2 = expectedSuccess(1200, 1600);
    expect(p1 + p2).toBeCloseTo(1, 10);
  });
});

describe("kFactor", () => {
  it("is 16 at the uncertainty floor (50)", () => {
    expect(kFactor(50)).toBeCloseTo(16, 10);
  });

  it("is 48 at the uncertainty ceiling (350)", () => {
    expect(kFactor(350)).toBeCloseTo(48, 10);
  });

  it("is 32 at the midpoint (200)", () => {
    expect(kFactor(200)).toBeCloseTo(32, 10);
  });

  it("clamps below the floor", () => {
    expect(kFactor(0)).toBe(16);
  });

  it("clamps above the ceiling", () => {
    expect(kFactor(1000)).toBe(48);
  });
});

describe("blendedRating", () => {
  it("weight-averages rating and RMS-blends uncertainty", () => {
    const states = {
      a: { rating: 1400, uncertainty: 100 },
      b: { rating: 1200, uncertainty: 200 },
    };
    const result = blendedRating(states, [
      { id: "a", weight: 0.7 },
      { id: "b", weight: 0.3 },
    ]);
    expect(result.rating).toBeCloseTo(1340, 6);
    expect(result.uncertainty).toBeCloseTo(Math.sqrt(0.7 * 100 ** 2 + 0.3 * 200 ** 2), 6);
  });

  it("normalizes weights that don't sum to 1", () => {
    const states = {
      a: { rating: 1400, uncertainty: 100 },
      b: { rating: 1200, uncertainty: 200 },
    };
    const result = blendedRating(states, [
      { id: "a", weight: 7 },
      { id: "b", weight: 3 },
    ]);
    expect(result.rating).toBeCloseTo(1340, 6);
  });

  it("returns the single rating/uncertainty unchanged for a single-concept problem", () => {
    const states = { a: { rating: 1450, uncertainty: 90 } };
    const result = blendedRating(states, [{ id: "a", weight: 1 }]);
    expect(result.rating).toBeCloseTo(1450, 10);
    expect(result.uncertainty).toBeCloseTo(90, 10);
  });

  it("throws when a referenced concept has no state", () => {
    expect(() => blendedRating({}, [{ id: "missing", weight: 1 }])).toThrow();
  });
});
