import { describe, expect, it } from "vitest";
import {
  isMastered,
  MASTERY_MAX_UNCERTAINTY,
  masteryThreshold,
  type ConceptBand,
  type MasteryEvidence,
} from "./mastery.js";
import type { ConceptState } from "./types.js";

const BAND: ConceptBand = { min_rating: 800, max_rating: 1800 };

function state(over: Partial<ConceptState> = {}): ConceptState {
  return {
    concept_id: "arrays_hashing",
    rating: 1600,
    uncertainty: 70,
    review_interval_days: 1,
    review_ease: 2.5,
    review_reps: 0,
    ...over,
  };
}

function evidence(over: Partial<MasteryEvidence> = {}): MasteryEvidence {
  return {
    unassistedSolves: 3,
    distinctProblems: 3,
    firstUnassistedSolveAt: "2026-07-01T00:00:00.000Z",
    lastUnassistedSolveAt: "2026-07-26T00:00:00.000Z",
    ...over,
  };
}

describe("masteryThreshold", () => {
  it("scales to each concept's own band rather than a global line", () => {
    // A flat global threshold would make bit_manipulation (max 1900) unmasterable and
    // shortest_paths (min 1400) free.
    expect(masteryThreshold({ min_rating: 800, max_rating: 1800 })).toBe(1500);
    expect(masteryThreshold({ min_rating: 1400, max_rating: 2600 })).toBe(2240);
  });
});

describe("isMastered", () => {
  it("grants mastery when all five clauses are met", () => {
    const result = isMastered({ state: state(), band: BAND, evidence: evidence() });
    expect(result.mastered).toBe(true);
    expect(result.met).toBe(result.total);
    expect(result.summary).toContain("Mastered");
  });

  it("refuses a high rating that is really one big swing from a wide prior", () => {
    const result = isMastered({
      state: state({ rating: 1700, uncertainty: 300 }),
      band: BAND,
      evidence: evidence(),
    });
    expect(result.mastered).toBe(false);
    expect(result.criteria.find((c) => c.key === "uncertainty")?.met).toBe(false);
    expect(MASTERY_MAX_UNCERTAINTY).toBeLessThan(350);
  });

  it("refuses a concept carried entirely by hints", () => {
    const result = isMastered({
      state: state(),
      band: BAND,
      evidence: evidence({ unassistedSolves: 0, distinctProblems: 0 }),
    });
    expect(result.mastered).toBe(false);
    expect(result.criteria.find((c) => c.key === "unassisted")?.met).toBe(false);
  });

  it("refuses the same problem solved repeatedly", () => {
    const result = isMastered({
      state: state(),
      band: BAND,
      evidence: evidence({ unassistedSolves: 5, distinctProblems: 1 }),
    });
    expect(result.mastered).toBe(false);
    expect(result.criteria.find((c) => c.key === "distinct")?.met).toBe(false);
  });

  it("refuses cramming — the spaced clause cannot be met in one sitting", () => {
    const result = isMastered({
      state: state(),
      band: BAND,
      evidence: evidence({
        firstUnassistedSolveAt: "2026-07-26T09:00:00.000Z",
        lastUnassistedSolveAt: "2026-07-26T17:00:00.000Z",
      }),
    });
    expect(result.mastered).toBe(false);
    expect(result.criteria.find((c) => c.key === "spaced")?.met).toBe(false);
    expect(result.summary).toContain("retention");
  });

  it("treats a missing solve timestamp as zero span rather than throwing", () => {
    const result = isMastered({
      state: state(),
      band: BAND,
      evidence: evidence({ firstUnassistedSolveAt: null, lastUnassistedSolveAt: null }),
    });
    expect(result.criteria.find((c) => c.key === "spaced")?.actual).toBe(0);
    expect(result.mastered).toBe(false);
  });

  it("reports partial progress so the UI can show what is left", () => {
    const result = isMastered({
      state: state({ rating: 1200 }),
      band: BAND,
      evidence: evidence({ unassistedSolves: 1, distinctProblems: 1 }),
    });
    expect(result.met).toBe(2); // uncertainty + spaced
    expect(result.total).toBe(5);
    // Names one next step, not a wall of five unmet clauses.
    expect(result.summary).toContain("1500");
  });

  it("accepts Date objects as well as ISO strings for solve timestamps", () => {
    const result = isMastered({
      state: state(),
      band: BAND,
      evidence: evidence({
        firstUnassistedSolveAt: new Date("2026-07-01T00:00:00.000Z"),
        lastUnassistedSolveAt: new Date("2026-07-26T00:00:00.000Z"),
      }),
    });
    expect(result.mastered).toBe(true);
  });
});
