import { describe, expect, it } from "vitest";
import type { ProblemVersion } from "@leetmind/shared";
import { selectTests, summarizeTestOrigins } from "../src/execution.js";

/** Only the fields `selectTests` reads. Cast at the boundary rather than building a full
 * ProblemVersion, which would be ~40 lines of irrelevant fixture. */
function content(examples: { args: unknown[]; expected: unknown }[], hidden: { args: unknown[]; expected: unknown; origin?: string }[]): ProblemVersion {
  return { examples, hidden_tests: hidden } as unknown as ProblemVersion;
}

const EXAMPLES = [
  { args: [[2, 1, 5, 1, 3, 2], 3], expected: 9 },
  { args: [[2, 3, 4, 1, 5], 2], expected: 7 },
];

describe("selectTests", () => {
  it("run executes exactly the public examples", () => {
    const selected = selectTests(content(EXAMPLES, [{ args: [[9]], expected: 9 }]), "run");
    expect(selected.tests.map((t) => t.args)).toEqual(EXAMPLES.map((e) => e.args));
    expect(selected.tests.every((t) => t.origin === "public")).toBe(true);
    expect(selected.publicCount).toBe(2);
    expect(selected.hiddenCount).toBe(0);
    expect(selected.revealInputs).toBe(true);
  });

  it("submit is a strict superset of run — public examples first, then the hidden suite", () => {
    const hidden = [
      { args: [[9]], expected: 9 },
      { args: [[1, 2], 1], expected: 2 },
    ];
    const selected = selectTests(content(EXAMPLES, hidden), "submit");

    expect(selected.tests.length).toBe(4);
    // Public first: `first_failing_test_index` must land on a case the user can read whenever an
    // example is what broke.
    expect(selected.tests.slice(0, 2).every((t) => t.origin === "public")).toBe(true);
    expect(selected.tests.slice(2).every((t) => t.origin === "hidden")).toBe(true);
    expect(selected.publicCount).toBe(2);
    expect(selected.hiddenCount).toBe(2);
    expect(selected.revealInputs).toBe(false);

    const runTests = selectTests(content(EXAMPLES, hidden), "run").tests;
    for (const t of runTests) {
      expect(selected.tests.some((s) => JSON.stringify(s.args) === JSON.stringify(t.args))).toBe(true);
    }
  });

  it("does not run an example twice when the hidden suite already contains it", () => {
    // The generator seeds the statement's own examples into hidden_tests with origin 'example'.
    // Concatenating blindly would run one case twice and inflate the denominator.
    const hidden = [
      { args: EXAMPLES[0]!.args, expected: EXAMPLES[0]!.expected, origin: "example" },
      { args: [[9]], expected: 9, origin: "generated" },
    ];
    const selected = selectTests(content(EXAMPLES, hidden), "submit");

    expect(selected.tests.length).toBe(3);
    expect(selected.publicCount).toBe(2);
    expect(selected.hiddenCount).toBe(1);
  });

  it("degrades to just the hidden suite when a problem has no examples", () => {
    const selected = selectTests(content([], [{ args: [[9]], expected: 9 }]), "submit");
    expect(selected.publicCount).toBe(0);
    expect(selected.hiddenCount).toBe(1);
  });
});

describe("summarizeTestOrigins", () => {
  const tests = [
    { args: [1], expected: 1, origin: "public" },
    { args: [2], expected: 2, origin: "public" },
    { args: [3], expected: 3, origin: "hidden" },
    { args: [4], expected: 4, origin: "hidden" },
    { args: [5], expected: 5, origin: "hidden" },
  ];

  it("splits the counts so 'which one am I missing' has an answer", () => {
    const perTest = [
      { index: 0, passed: true },
      { index: 1, passed: true },
      { index: 2, passed: true },
      { index: 3, passed: false },
      { index: 4, passed: true },
    ];
    expect(summarizeTestOrigins(tests, perTest)).toEqual({
      public_passed: 2,
      public_total: 2,
      hidden_passed: 2,
      hidden_total: 3,
    });
  });

  it("counts a test with no per-test result as failed rather than silently passing it", () => {
    // A crash partway through leaves later tests unreported. Treating "absent" as passed would
    // report 5/5 on a run that never finished.
    expect(summarizeTestOrigins(tests, [{ index: 0, passed: true }])).toEqual({
      public_passed: 1,
      public_total: 2,
      hidden_passed: 0,
      hidden_total: 3,
    });
  });

  it("excludes ungraded tests (no expected value) from the totals", () => {
    const withUngraded = [...tests, { args: [6], origin: "hidden" } as { args: unknown[]; origin: string }];
    const summary = summarizeTestOrigins(withUngraded, []);
    expect(summary.hidden_total).toBe(3);
  });
});
