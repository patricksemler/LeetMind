/**
 * Deterministic "grading" for the mock server. The mock does not execute submitted code (that's
 * the judge/sandbox's job in the real system) — instead it reads simple markers out of the
 * submitted source so every verdict path in the UI is reachable on demand:
 *
 *   contains "CRASH"   -> runtime_error
 *   contains "SYNTAX"  -> compilation_error
 *   contains "SLOW"    -> time_limit
 *   contains "BUG"     -> wrong_answer, failing a HIDDEN case
 *   contains "PUBFAIL" -> wrong_answer, failing a PUBLIC example — the case a submit is treated
 *                         as a run for (`failedPublicCase`, @leetmind/shared)
 *   unmodified starter (bare `pass` / empty C++ body) -> wrong_answer
 *   otherwise          -> accepted
 *
 * See the final report for why this exists and what it leaves underspecified for the real judge.
 */
import type { Language, SubmissionFailure, Verdict } from "@leetmind/shared";
import type { ProblemFixture } from "./fixtures/problems.js";

export interface GradeResult {
  verdict: Verdict;
  passedTests: number;
  totalTests: number;
  runtimeMs: number;
  memoryKb: number;
  failure?: SubmissionFailure;
  publicResults?: { index: number; status: string; passed: boolean; actual?: unknown }[];
}

function isUnmodifiedStarter(source: string, language: Language): boolean {
  if (language === "python") {
    return /def\s+\w+\([^)]*\)\s*->[^:]*:\s*\n\s*pass\s*$/.test(source.trim());
  }
  return /\{\s*\}\s*;?\s*\}\s*;?\s*$/.test(source.trim().replace(/\s+/g, " "));
}

function pickVerdict(source: string, language: Language): Verdict {
  const upper = source.toUpperCase();
  if (upper.includes("PUBFAIL")) return "wrong_answer";
  if (upper.includes("CRASH")) return "runtime_error";
  if (upper.includes("SYNTAX")) return "compilation_error";
  if (upper.includes("SLOW")) return "time_limit";
  if (upper.includes("BUG")) return "wrong_answer";
  if (isUnmodifiedStarter(source, language)) return "wrong_answer";
  return "accepted";
}

/** Mirrors `selectTests` in apps/judge: submit runs the public examples PLUS the hidden suite,
 * deduped by argument list, so the mock's denominators match what the real API reports. */
export function submitTestSplit(problem: ProblemFixture): {
  publicTotal: number;
  hiddenTotal: number;
  total: number;
} {
  const publicArgs = new Set(problem.content.examples.map((e) => JSON.stringify(e.args)));
  const publicTotal = publicArgs.size;
  const hiddenTotal = problem.content.hidden_tests.filter(
    (t) => !publicArgs.has(JSON.stringify(t.args)),
  ).length;
  return { publicTotal, hiddenTotal, total: publicTotal + hiddenTotal };
}

/**
 * The one failing case, mirroring `failingTestDetail` in apps/judge/src/execution.ts — including a
 * hidden one, which is what the Submissions view renders. Public tests come first (see
 * `submitTestSplit`), so an index at or past `publicTotal` addresses the deduped hidden suite.
 */
export function failingTestFor(
  problem: ProblemFixture,
  failIndex: number,
  publicTotal: number,
  actual: unknown = null,
):
  | {
      index: number;
      origin: "public" | "hidden";
      args: unknown[];
      expected?: unknown;
      actual?: unknown;
      status?: string;
    }
  | undefined {
  if (failIndex < publicTotal) {
    const example = problem.content.examples[failIndex];
    if (!example) return undefined;
    return {
      index: failIndex,
      origin: "public",
      args: example.args,
      expected: example.expected,
      actual,
      status: "failed",
    };
  }
  const publicArgs = new Set(problem.content.examples.map((e) => JSON.stringify(e.args)));
  const hidden = problem.content.hidden_tests.filter(
    (t) => !publicArgs.has(JSON.stringify(t.args)),
  );
  const test = hidden[failIndex - publicTotal];
  if (!test) return undefined;
  return {
    index: failIndex,
    origin: "hidden",
    args: test.args,
    expected: test.expected,
    actual,
    status: "failed",
  };
}

/** Per-public-test outcomes, aligned to `examples`, mirroring the judge's `publicResults`. */
export function publicResultsFor(
  problem: ProblemFixture,
  passedCount: number,
  actualWhenWrong: unknown = null,
): { index: number; status: string; passed: boolean; actual?: unknown }[] {
  return problem.content.examples.map((e, i) => {
    const passed = i < passedCount;
    return {
      index: i,
      status: passed ? "passed" : "failed",
      passed,
      actual: passed ? e.expected : actualWhenWrong,
    };
  });
}

export function gradeSubmit(
  problem: ProblemFixture,
  language: Language,
  source: string,
): GradeResult {
  const verdict = pickVerdict(source, language);
  const { publicTotal, hiddenTotal, total } = submitTestSplit(problem);
  const allPassed = {
    public_passed: publicTotal,
    public_total: publicTotal,
    hidden_passed: hiddenTotal,
    hidden_total: hiddenTotal,
  };
  /** A failure at `index` — public tests come first, so anything past them is a hidden case. */
  const splitAt = (index: number) => ({
    public_passed: Math.min(index, publicTotal),
    public_total: publicTotal,
    hidden_passed: Math.max(0, index - publicTotal),
    hidden_total: hiddenTotal,
  });

  switch (verdict) {
    case "accepted":
      return {
        verdict,
        passedTests: total,
        totalTests: total,
        runtimeMs: 32 + Math.round(Math.random() * 40),
        memoryKb: 14_300 + Math.round(Math.random() * 2000),
        failure: {
          kind: "solved",
          message: `Accepted — all ${total} tests passed (${publicTotal} public, ${hiddenTotal} hidden).`,
          tests: allPassed,
        },
        publicResults: publicResultsFor(problem, publicTotal),
      };
    case "wrong_answer": {
      // Fail the LAST test so the mock exercises the interesting case: every public example
      // passing and a hidden one failing, which is the state the results panel has to explain
      // without leaking the hidden input. "PUBFAIL" picks a public example instead — the failure
      // a submit is treated as a run for, which has no history row and no mastery consequence.
      const failIndex = source.toUpperCase().includes("PUBFAIL")
        ? Math.min(1, Math.max(0, publicTotal - 1))
        : Math.max(0, total - 1);
      return {
        verdict,
        passedTests: failIndex,
        totalTests: total,
        runtimeMs: 28 + Math.round(Math.random() * 20),
        memoryKb: 14_100 + Math.round(Math.random() * 1500),
        failure: {
          kind: "assertion",
          message: "Output did not match the expected result.",
          first_failing_test_index: failIndex,
          tests: splitAt(failIndex),
          failing_test: failingTestFor(problem, failIndex, publicTotal),
        },
        publicResults: publicResultsFor(problem, Math.min(failIndex, publicTotal)),
      };
    }
    case "time_limit":
      return {
        verdict,
        passedTests: Math.max(0, total - 2),
        totalTests: total,
        runtimeMs: 10_000,
        memoryKb: 15_800,
        failure: {
          kind: "time_limit",
          message: "Execution exceeded the per-test wall-clock budget.",
          first_failing_test_index: Math.max(0, total - 2),
          tests: splitAt(Math.max(0, total - 2)),
          failing_test: failingTestFor(problem, Math.max(0, total - 2), publicTotal, undefined),
        },
        publicResults: publicResultsFor(problem, Math.min(Math.max(0, total - 2), publicTotal)),
      };
    case "runtime_error":
      return {
        verdict,
        passedTests: 0,
        totalTests: total,
        runtimeMs: 12,
        memoryKb: 13_900,
        failure: {
          kind: "runtime_error",
          message: "The program raised an unhandled exception.",
          first_failing_test_index: 0,
          stderr_tail:
            language === "python"
              ? 'Traceback (most recent call last):\n  File "solution.py", line 4, in ' +
                `${problem.content.signature.name}\nRuntimeError: forced failure ("CRASH" marker in source)`
              : "terminate called after throwing an instance of 'std::runtime_error'\n  what():  forced failure (\"CRASH\" marker in source)",
        },
      };
    case "compilation_error":
      return {
        verdict,
        passedTests: 0,
        totalTests: total,
        runtimeMs: 0,
        memoryKb: 0,
        failure: {
          kind: "compilation_error",
          message:
            language === "python"
              ? "SyntaxError while compiling solution."
              : "g++ compilation failed.",
          stderr_tail:
            language === "python"
              ? '  File "solution.py", line 1\n    def (:\n        ^\nSyntaxError: invalid syntax'
              : "solution.cpp:3:5: error: expected ';' before '}' token",
        },
      };
    default:
      return {
        verdict: "internal_error",
        passedTests: 0,
        totalTests: total,
        runtimeMs: 0,
        memoryKb: 0,
      };
  }
}

/** Run executes the problem's PUBLIC examples — the ones printed in the statement. No custom
 * input: that mode is gone, so there is nothing to grade against except the examples' own
 * expected values, and every failure can safely show input/expected/actual. */
export function gradeRun(problem: ProblemFixture, language: Language, source: string): GradeResult {
  const verdict = pickVerdict(source, language);
  const examples = problem.content.examples;
  const total = examples.length;
  const publicSummary = (passed: number) => ({
    public_passed: passed,
    public_total: total,
    hidden_passed: 0,
    hidden_total: 0,
  });

  switch (verdict) {
    case "accepted":
      return {
        verdict,
        passedTests: total,
        totalTests: total,
        runtimeMs: 18 + Math.round(Math.random() * 15),
        memoryKb: 13_800,
        failure: {
          kind: "ok",
          message: `All ${total} public example${total === 1 ? "" : "s"} passed. Submit to run the hidden tests too.`,
          tests: publicSummary(total),
        },
        publicResults: publicResultsFor(problem, total),
      };
    case "wrong_answer": {
      const failIndex = Math.min(1, Math.max(0, total - 1));
      const example = examples[failIndex];
      return {
        verdict,
        passedTests: failIndex,
        totalTests: total,
        runtimeMs: 16,
        memoryKb: 13_700,
        failure: {
          kind: "assertion",
          message: `Output did not match on example ${failIndex + 1}.`,
          first_failing_test_index: failIndex,
          input_preview: example?.args,
          expected_preview: example?.expected,
          actual_preview: null,
          tests: publicSummary(failIndex),
          failing_test: failingTestFor(problem, failIndex, total),
        },
        publicResults: publicResultsFor(problem, failIndex),
      };
    }
    default: {
      const graded = gradeSubmit(problem, language, source);
      return {
        ...graded,
        passedTests: 0,
        totalTests: total,
        failure: graded.failure
          ? { ...graded.failure, first_failing_test_index: 0, tests: publicSummary(0) }
          : undefined,
      };
    }
  }
}
