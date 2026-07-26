import { describe, expect, it } from "vitest";
import {
  COLD_START_PROBLEM_COUNT,
  COLD_START_RATING,
  nextColdStartStep,
  type ColdStartHistoryEntry,
} from "./coldstart.js";

const CONCEPTS = [
  "arrays_hashing",
  "two_pointers",
  "sliding_window",
  "stacks_queues",
  "binary_search",
  "sorting",
  "intervals",
];

function solved(concept_id: string): ColdStartHistoryEntry {
  return { concept_id, outcome: "solved" };
}
function skipped(concept_id: string): ColdStartHistoryEntry {
  return { concept_id, outcome: "skipped" };
}
function failed(concept_id: string): ColdStartHistoryEntry {
  return { concept_id, outcome: "failed" };
}

describe("nextColdStartStep", () => {
  it("starts on the first concept at the low-mid rating, below the 1200 seed", () => {
    const step = nextColdStartStep(CONCEPTS, []);
    expect(step.done).toBe(false);
    expect(step.concept_id).toBe("arrays_hashing");
    expect(step.target_rating).toBe(COLD_START_RATING);
    expect(COLD_START_RATING).toBeLessThan(1200);
  });

  it("steps up after a solve and down further after a skip", () => {
    const up = nextColdStartStep(CONCEPTS, [solved("arrays_hashing")]);
    const down = nextColdStartStep(CONCEPTS, [skipped("arrays_hashing")]);

    expect(up.target_rating).toBeGreaterThan(COLD_START_RATING);
    expect(down.target_rating).toBeLessThan(COLD_START_RATING);
    // Asymmetric on purpose: being handed something far too hard is the expensive error.
    expect(COLD_START_RATING - down.target_rating).toBeGreaterThan(up.target_rating - COLD_START_RATING);
  });

  it("treats a give-up the same as a skip for stepping", () => {
    const viaSkip = nextColdStartStep(CONCEPTS, [skipped("arrays_hashing")]);
    const viaFail = nextColdStartStep(CONCEPTS, [failed("arrays_hashing")]);
    expect(viaFail.target_rating).toBe(viaSkip.target_rating);
  });

  it("accumulates difficulty across the whole history, not just the last outcome", () => {
    // The regression this guards: the baseline version recomputed `1050 ± one step` from only the
    // most recent result, so three straight solves still asked for 1170 — it could observe that
    // the user was doing well and then decline to act on it.
    const one = nextColdStartStep(CONCEPTS, [solved("arrays_hashing")]);
    const three = nextColdStartStep(CONCEPTS, [
      solved("arrays_hashing"),
      solved("two_pointers"),
      solved("sliding_window"),
    ]);
    expect(three.target_rating).toBeGreaterThan(one.target_rating);
    expect(three.target_rating).toBe(COLD_START_RATING + 3 * 120);
  });

  it("clamps to the floor under a long run of failures", () => {
    const history = CONCEPTS.slice(0, 5).map(failed);
    const step = nextColdStartStep(CONCEPTS, history);
    expect(step.target_rating).toBe(800);
  });

  it("never probes the same concept twice", () => {
    const history = [solved("arrays_hashing"), failed("two_pointers")];
    const step = nextColdStartStep(CONCEPTS, history);
    expect(step.concept_id).toBe("sliding_window");
  });

  it("is done after COLD_START_PROBLEM_COUNT problems", () => {
    const history = CONCEPTS.slice(0, COLD_START_PROBLEM_COUNT).map(solved);
    const step = nextColdStartStep(CONCEPTS, history);
    expect(step.done).toBe(true);
    expect(step.concept_id).toBeNull();
  });

  it("is done when the taxonomy runs out of unprobed concepts first", () => {
    const short = ["arrays_hashing", "two_pointers"];
    const step = nextColdStartStep(short, short.map(solved));
    expect(step.done).toBe(true);
    expect(step.concept_id).toBeNull();
  });

  it("names the previous concept and the direction in the rationale", () => {
    const step = nextColdStartStep(CONCEPTS, [skipped("arrays_hashing")]);
    expect(step.rationale).toContain("arrays_hashing");
    expect(step.rationale).toContain("a skip");
    // Regression: interpolating the raw outcome produced "after a skipped on arrays_hashing".
    expect(step.rationale).not.toContain("a skipped");
  });
});
