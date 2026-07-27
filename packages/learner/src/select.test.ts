import { describe, expect, it } from "vitest";
import { scoreCandidate, selectNext, targetBand } from "./select.js";
import { expectedSuccess } from "./rating.js";
import type { CandidateProblem, ConceptState } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-22T12:00:00.000Z");

function makeState(overrides: Partial<ConceptState> = {}): ConceptState {
  return {
    concept_id: "c",
    rating: 1500,
    uncertainty: 200,
    review_interval_days: 1,
    review_ease: 2.5,
    review_reps: 0,
    ...overrides,
  };
}

describe("targetBand", () => {
  it("inverts the logistic so the band edges truly hit 0.80 and 0.65 success probability", () => {
    const band = targetBand({ rating: 1500 });

    // band.min is the easier/lower-rating edge -> higher success probability (0.80)
    expect(expectedSuccess(1500, band.min)).toBeCloseTo(0.8, 6);
    // band.max is the harder/higher-rating edge (within the band) -> lower success probability (0.65)
    expect(expectedSuccess(1500, band.max)).toBeCloseTo(0.65, 6);
    expect(band.min).toBeLessThan(band.max);

    // NOTE: both edges sit BELOW the user's own rating (1500), because both 0.65 and 0.80 are
    // above the 50% coin-flip point — see the doc comment on targetBand() in src/select.ts for
    // why. Concretely, for a 1500 user this band is ~[1259, 1392], not symmetric around 1500.
    expect(band.min).toBeLessThan(1500);
    expect(band.max).toBeLessThan(1500);
    expect(band.ideal).toBeGreaterThan(band.min);
    expect(band.ideal).toBeLessThan(band.max);
  });

  it("the ideal point sits at the midpoint probability (0.725)", () => {
    const band = targetBand({ rating: 1500 });
    expect(expectedSuccess(1500, band.ideal)).toBeCloseTo(0.725, 6);
  });

  it("scales with user rating", () => {
    const low = targetBand({ rating: 1200 });
    const high = targetBand({ rating: 1800 });
    expect(high.ideal - low.ideal).toBeCloseTo(600, 6);
  });
});

describe("scoreCandidate", () => {
  it("rewards weak, uncertain concepts and problems near the ideal band", () => {
    const states = { weak: makeState({ rating: 900, uncertainty: 300 }) };
    const problem: CandidateProblem = {
      problem_version_id: "p1",
      difficulty_rating: targetBand({ rating: 900 }).ideal,
      concepts: [{ id: "weak", weight: 1 }],
    };
    const result = scoreCandidate({ problem, states, now: NOW });
    expect(result.score).toBeGreaterThan(0);
    expect(result.factors.concept_weakness).toBeGreaterThan(0);
    expect(result.factors.uncertainty_bonus).toBeGreaterThan(0);
  });

  it("penalizes distance from the ideal band", () => {
    const states = { c: makeState({ rating: 1500 }) };
    const near: CandidateProblem = {
      problem_version_id: "near",
      difficulty_rating: targetBand({ rating: 1500 }).ideal,
      concepts: [{ id: "c", weight: 1 }],
    };
    const far: CandidateProblem = {
      problem_version_id: "far",
      difficulty_rating: targetBand({ rating: 1500 }).ideal + 500,
      concepts: [{ id: "c", weight: 1 }],
    };
    const nearScore = scoreCandidate({ problem: near, states, now: NOW }).score;
    const farScore = scoreCandidate({ problem: far, states, now: NOW }).score;
    expect(nearScore).toBeGreaterThan(farScore);
  });

  it("penalizes a concept practiced earlier today", () => {
    const states = { c: makeState({ last_practiced_at: new Date(NOW.getTime() - 60_000) }) };
    const result = scoreCandidate({
      problem: {
        problem_version_id: "p",
        difficulty_rating: 1500,
        concepts: [{ id: "c", weight: 1 }],
      },
      states,
      now: NOW,
    });
    expect(result.factors.recency_penalty).toBeLessThan(0);
  });
});

describe("selectNext", () => {
  it("prefers a due review over an equally-good non-review candidate, and says why", () => {
    const ideal = targetBand({ rating: 1500 }).ideal;

    const states: Record<string, ConceptState> = {
      due_concept: makeState({
        rating: 1500,
        uncertainty: 200,
        next_review_at: new Date(NOW.getTime() - 5 * DAY_MS),
      }),
      fresh_concept: makeState({ rating: 1500, uncertainty: 200, next_review_at: null }),
    };

    const candidates: CandidateProblem[] = [
      {
        problem_version_id: "review-problem",
        difficulty_rating: ideal,
        concepts: [{ id: "due_concept", weight: 1 }],
      },
      {
        problem_version_id: "other-problem",
        difficulty_rating: ideal,
        concepts: [{ id: "fresh_concept", weight: 1 }],
      },
    ];

    const result = selectNext(candidates, states, NOW);

    expect(result.candidate.problem_version_id).toBe("review-problem");
    expect(result.rationale.toLowerCase()).toMatch(/review|overdue/);
  });

  it("throws on an empty candidate list", () => {
    expect(() => selectNext([], {}, NOW)).toThrow();
  });

  it("rationale names the dominant concept", () => {
    const states: Record<string, ConceptState> = {
      weak_concept: makeState({ rating: 700, uncertainty: 350 }),
    };
    const candidates: CandidateProblem[] = [
      {
        problem_version_id: "p1",
        difficulty_rating: targetBand({ rating: 700 }).ideal,
        concepts: [{ id: "weak_concept", weight: 1 }],
      },
    ];
    const result = selectNext(candidates, states, NOW);
    expect(result.rationale).toContain("weak_concept");
  });
});
