import { describe, expect, it } from "vitest";
import { decayUncertainty, reviewsDue, scheduleReview } from "./review.js";
import type { ConceptState } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-22T00:00:00.000Z");

function makeState(overrides: Partial<ConceptState> = {}): ConceptState {
  return {
    concept_id: "c1",
    rating: 1500,
    uncertainty: 200,
    review_interval_days: 1,
    review_ease: 2.5,
    review_reps: 0,
    ...overrides,
  };
}

describe("scheduleReview — SM-2 sequence", () => {
  it("produces intervals 1, 4, then round(interval * ease) on successive perfect reviews", () => {
    let state = makeState();

    const r1 = scheduleReview(state, 1, NOW);
    expect(r1.review_interval_days).toBe(1);
    expect(r1.review_reps).toBe(1);
    expect(r1.review_ease).toBeCloseTo(2.6, 10);

    state = { ...state, review_interval_days: r1.review_interval_days, review_ease: r1.review_ease, review_reps: r1.review_reps };
    const r2 = scheduleReview(state, 1, NOW);
    expect(r2.review_interval_days).toBe(4);
    expect(r2.review_reps).toBe(2);
    expect(r2.review_ease).toBeCloseTo(2.7, 10);

    state = { ...state, review_interval_days: r2.review_interval_days, review_ease: r2.review_ease, review_reps: r2.review_reps };
    const r3 = scheduleReview(state, 1, NOW);
    expect(r3.review_reps).toBe(3);
    expect(r3.review_ease).toBeCloseTo(2.8, 10); // hits the ceiling
    expect(r3.review_interval_days).toBe(Math.round(4 * r3.review_ease));

    expect(r3.next_review_at.getTime()).toBe(NOW.getTime() + r3.review_interval_days * DAY_MS);
  });

  it("a failure resets interval to 1 and reps to 0", () => {
    const state = makeState({ review_interval_days: 11, review_ease: 2.6, review_reps: 3 });
    const result = scheduleReview(state, 0.2, NOW);
    expect(result.review_interval_days).toBe(1);
    expect(result.review_reps).toBe(0);
  });

  it("treats outcome exactly at the 0.6 success threshold as a success", () => {
    const state = makeState({ review_reps: 0 });
    const result = scheduleReview(state, 0.6, NOW);
    expect(result.review_reps).toBe(1);
    expect(result.review_interval_days).toBe(1);
  });

  it("ease stays within [1.3, 2.8] under repeated failures (floor)", () => {
    let state = makeState({ review_ease: 2.5 });
    for (let i = 0; i < 20; i++) {
      const result = scheduleReview(state, 0, NOW);
      expect(result.review_ease).toBeGreaterThanOrEqual(1.3);
      expect(result.review_ease).toBeLessThanOrEqual(2.8);
      state = { ...state, review_ease: result.review_ease, review_interval_days: result.review_interval_days, review_reps: result.review_reps };
    }
    expect(state.review_ease).toBeCloseTo(1.3, 10);
  });

  it("ease stays within [1.3, 2.8] under repeated perfect reviews (ceiling)", () => {
    let state = makeState({ review_ease: 2.5 });
    for (let i = 0; i < 20; i++) {
      const result = scheduleReview(state, 1, NOW);
      expect(result.review_ease).toBeLessThanOrEqual(2.8);
      state = { ...state, review_ease: result.review_ease, review_interval_days: result.review_interval_days, review_reps: result.review_reps };
    }
    expect(state.review_ease).toBeCloseTo(2.8, 10);
  });
});

describe("decayUncertainty", () => {
  it("grows with idle days", () => {
    const state = makeState({ uncertainty: 100, last_practiced_at: new Date(NOW.getTime() - 10 * DAY_MS) });
    const result = decayUncertainty(state, NOW);
    expect(result.uncertainty).toBeGreaterThan(100);
    expect(result.uncertainty).toBeCloseTo(Math.sqrt(100 ** 2 + (10 * 3) ** 2), 6);
  });

  it("saturates at 350 for a long idle period", () => {
    const state = makeState({ uncertainty: 100, last_practiced_at: new Date(NOW.getTime() - 365 * DAY_MS) });
    const result = decayUncertainty(state, NOW);
    expect(result.uncertainty).toBe(350);
  });

  it("does not change uncertainty when never practiced", () => {
    const state = makeState({ uncertainty: 200, last_practiced_at: null });
    const result = decayUncertainty(state, NOW);
    expect(result.uncertainty).toBe(200);
  });

  it("does not change other state fields", () => {
    const state = makeState({ uncertainty: 100, rating: 1234, last_practiced_at: new Date(NOW.getTime() - 5 * DAY_MS) });
    const result = decayUncertainty(state, NOW);
    expect(result.rating).toBe(1234);
    expect(result.concept_id).toBe("c1");
  });
});

describe("reviewsDue", () => {
  it("returns only concepts whose next_review_at has passed, most overdue first", () => {
    const states: Record<string, ConceptState> = {
      barely_due: makeState({ next_review_at: new Date(NOW.getTime() - 1 * DAY_MS) }),
      very_overdue: makeState({ next_review_at: new Date(NOW.getTime() - 10 * DAY_MS) }),
      not_due_yet: makeState({ next_review_at: new Date(NOW.getTime() + 5 * DAY_MS) }),
      never_scheduled: makeState({ next_review_at: null }),
    };

    const due = reviewsDue(states, NOW);

    expect(due.map((d) => d.concept_id)).toEqual(["very_overdue", "barely_due"]);
    expect(due[0]!.days_overdue).toBeCloseTo(10, 6);
    expect(due[1]!.days_overdue).toBeCloseTo(1, 6);
  });

  it("returns an empty list when nothing is due", () => {
    const states: Record<string, ConceptState> = {
      c1: makeState({ next_review_at: new Date(NOW.getTime() + DAY_MS) }),
    };
    expect(reviewsDue(states, NOW)).toEqual([]);
  });
});
