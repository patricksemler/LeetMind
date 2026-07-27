import { describe, expect, it } from "vitest";
import { outcomeScore, type OutcomeInput } from "./outcome.js";

const EXPECTED_MINUTES: [number, number] = [10, 25];
const WITHIN_BAND_MS = 15 * 60_000; // 15 min, inside [10, 25]

function baseInput(overrides: Partial<OutcomeInput>): OutcomeInput {
  return {
    verdict: null,
    gaveUp: false,
    skipped: null,
    highestHint: null,
    activeMs: WITHIN_BAND_MS,
    expectedMinutes: EXPECTED_MINUTES,
    substantiveSubmissions: 1,
    compileErrors: 0,
    ...overrides,
  };
}

describe("outcomeScore — table rows (CONTRACTS.md §8)", () => {
  it("accepted, no hints -> 1.0", () => {
    const r = outcomeScore(baseInput({ verdict: "accepted" }));
    expect(r.outcome).toBeCloseTo(1.0, 10);
    expect(r.evidenceWeight).toBe(1);
  });

  it("accepted after an L2 hint -> capped at 0.75", () => {
    const r = outcomeScore(baseInput({ verdict: "accepted", highestHint: "l2_conceptual" }));
    expect(r.outcome).toBeCloseTo(0.75, 10);
  });

  it("accepted after an outline hint -> capped at 0.4", () => {
    const r = outcomeScore(baseInput({ verdict: "accepted", highestHint: "outline" }));
    expect(r.outcome).toBeCloseTo(0.4, 10);
  });

  it("accepted after an L1 hint -> capped at 0.9", () => {
    const r = outcomeScore(baseInput({ verdict: "accepted", highestHint: "l1_orientation" }));
    expect(r.outcome).toBeCloseTo(0.9, 10);
  });

  it("accepted after an L3 hint -> capped at 0.6", () => {
    const r = outcomeScore(baseInput({ verdict: "accepted", highestHint: "l3_structural" }));
    expect(r.outcome).toBeCloseTo(0.6, 10);
  });

  it("wrong answer with >=1 substantive submission -> 0.15", () => {
    const r = outcomeScore(baseInput({ verdict: "wrong_answer", substantiveSubmissions: 1 }));
    expect(r.outcome).toBeCloseTo(0.15, 10);
    expect(r.evidenceWeight).toBe(1);
  });

  it("give-up / abandon -> 0.0", () => {
    const r = outcomeScore(baseInput({ gaveUp: true }));
    expect(r.outcome).toBe(0);
    expect(r.evidenceWeight).toBe(1);
  });

  it("skip(inability) -> outcome 0, evidenceWeight 0.5", () => {
    const r = outcomeScore(baseInput({ skipped: "inability" }));
    expect(r.outcome).toBe(0);
    expect(r.evidenceWeight).toBe(0.5);
  });

  it("skip(preference) -> no learning event (outcome 0, evidenceWeight 0, skipped flag set)", () => {
    const r = outcomeScore(baseInput({ skipped: "preference" }));
    expect(r.outcome).toBe(0);
    expect(r.evidenceWeight).toBe(0);
    expect(r.skipped).toBe(true);
  });
});

describe("outcomeScore — modifiers", () => {
  it("a fast solve adds up to +0.1 when uncapped", () => {
    const r = outcomeScore(
      baseInput({ verdict: "accepted", activeMs: 5 * 60_000 /* under low band of 10 */ }),
    );
    // base 1.0 + 0.1 modifier would be 1.1, but overall clamp holds it at the cap (1.0) since no
    // hint was taken (cap === 1) — so the *effective* gain is 0, even though the modifier itself
    // is +0.1. This is exactly the "never exceed the cap" rule with cap === 1.
    expect(r.outcome).toBe(1.0);
    expect(r.breakdown.time_modifier).toBeCloseTo(0.1, 10);
  });

  it("cap-then-modifier-then-clamp-to-cap: a fast solve never pushes a capped outcome above its cap", () => {
    const r = outcomeScore(
      baseInput({
        verdict: "accepted",
        highestHint: "l2_conceptual", // cap 0.75
        activeMs: 5 * 60_000, // under low band -> +0.1 modifier
      }),
    );
    // capped = min(1.0, 0.75) = 0.75; +0.1 modifier would be 0.85, but the final clamp is to the
    // CAP (0.75), not just to [0,1] — so the outcome must stay at exactly 0.75.
    expect(r.outcome).toBeCloseTo(0.75, 10);
    expect(r.breakdown.time_modifier).toBeCloseTo(0.1, 10);
    expect(r.breakdown.clamp).toBeCloseTo(-0.1, 10); // the clamp step absorbed the excess
  });

  it("a slow solve (>= 2x the high band) subtracts 0.1", () => {
    const r = outcomeScore(baseInput({ verdict: "accepted", activeMs: 50 * 60_000 })); // 2x 25
    expect(r.outcome).toBeCloseTo(0.9, 10);
  });

  it("linearly interpolates the time modifier between the high band and 2x the high band", () => {
    // midpoint between high(25) and 2*high(50) is 37.5 minutes -> half of -0.1 = -0.05
    const r = outcomeScore(baseInput({ verdict: "accepted", activeMs: 37.5 * 60_000 }));
    expect(r.breakdown.time_modifier).toBeCloseTo(-0.05, 6);
  });

  it("5 submissions floors the submission modifier at -0.08", () => {
    const r = outcomeScore(baseInput({ verdict: "accepted", substantiveSubmissions: 5 }));
    expect(r.breakdown.submission_modifier).toBeCloseTo(-0.08, 10);
  });

  it("floor holds beyond 5 submissions too (doesn't keep dropping)", () => {
    const r = outcomeScore(baseInput({ verdict: "accepted", substantiveSubmissions: 20 }));
    expect(r.breakdown.submission_modifier).toBeCloseTo(-0.08, 10);
  });

  it("breakdown terms sum exactly to the outcome", () => {
    const r = outcomeScore(
      baseInput({
        verdict: "accepted",
        highestHint: "l2_conceptual",
        activeMs: 5 * 60_000,
        substantiveSubmissions: 3,
      }),
    );
    const sum = Object.values(r.breakdown).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(r.outcome, 10);
  });
});

describe("outcomeScore — compile-error exclusion and escalation", () => {
  it("excludes a compile-error-only attempt below the 3x recurrence threshold", () => {
    const r = outcomeScore(baseInput({ verdict: "compilation_error", compileErrors: 1 }));
    expect(r.excluded).toBe(true);
    expect(r.reason).toBeTruthy();
  });

  it("still excludes at exactly 2 recurrences", () => {
    const r = outcomeScore(baseInput({ verdict: "compilation_error", compileErrors: 2 }));
    expect(r.excluded).toBe(true);
  });

  it("escalates to a wrong-answer-grade outcome at 3+ recurrences, tagged compilation", () => {
    const r = outcomeScore(baseInput({ verdict: "compilation_error", compileErrors: 3 }));
    expect(r.excluded).toBeFalsy();
    expect(r.outcome).toBeCloseTo(0.15, 10);
    expect(r.errorCategory).toBe("compilation");
  });
});

describe("outcomeScore — other verdicts and edge cases", () => {
  it("excludes system-caused verdicts (cancelled)", () => {
    const r = outcomeScore(baseInput({ verdict: "cancelled" }));
    expect(r.excluded).toBe(true);
  });

  it("excludes system-caused verdicts (internal_error)", () => {
    const r = outcomeScore(baseInput({ verdict: "internal_error" }));
    expect(r.excluded).toBe(true);
  });

  it("excludes a wrong_answer verdict with zero substantive submissions", () => {
    const r = outcomeScore(baseInput({ verdict: "wrong_answer", substantiveSubmissions: 0 }));
    expect(r.excluded).toBe(true);
  });

  it("grades runtime_error like wrong_answer when substantive", () => {
    const r = outcomeScore(baseInput({ verdict: "runtime_error" }));
    expect(r.outcome).toBeCloseTo(0.15, 10);
  });

  it("clamps outcome to [0,1]", () => {
    const r = outcomeScore(baseInput({ verdict: "accepted" }));
    expect(r.outcome).toBeGreaterThanOrEqual(0);
    expect(r.outcome).toBeLessThanOrEqual(1);
  });
});
