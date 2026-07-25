/**
 * Deterministic "grading" for the mock server. The mock does not execute submitted code (that's
 * the judge/sandbox's job in the real system) — instead it reads simple markers out of the
 * submitted source so every verdict path in the UI is reachable on demand:
 *
 *   contains "CRASH"   -> runtime_error
 *   contains "SYNTAX"  -> compilation_error
 *   contains "SLOW"    -> time_limit
 *   contains "BUG"     -> wrong_answer
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
}

function isUnmodifiedStarter(source: string, language: Language): boolean {
  if (language === "python") {
    return /def\s+\w+\([^)]*\)\s*->[^:]*:\s*\n\s*pass\s*$/.test(source.trim());
  }
  return /\{\s*\}\s*;?\s*\}\s*;?\s*$/.test(source.trim().replace(/\s+/g, " "));
}

function pickVerdict(source: string, language: Language): Verdict {
  const upper = source.toUpperCase();
  if (upper.includes("CRASH")) return "runtime_error";
  if (upper.includes("SYNTAX")) return "compilation_error";
  if (upper.includes("SLOW")) return "time_limit";
  if (upper.includes("BUG")) return "wrong_answer";
  if (isUnmodifiedStarter(source, language)) return "wrong_answer";
  return "accepted";
}

export function gradeSubmit(problem: ProblemFixture, language: Language, source: string): GradeResult {
  const verdict = pickVerdict(source, language);
  const total = problem.content.hidden_tests.length;

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
          message: "Accepted — all hidden tests passed.",
        },
      };
    case "wrong_answer": {
      const failIndex = Math.min(1, Math.max(0, total - 1));
      return {
        verdict,
        passedTests: failIndex,
        totalTests: total,
        runtimeMs: 28 + Math.round(Math.random() * 20),
        memoryKb: 14_100 + Math.round(Math.random() * 1500),
        failure: {
          kind: "assertion",
          message: `Output did not match the expected result on hidden test ${failIndex + 1}.`,
          first_failing_test_index: failIndex,
        },
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
        },
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
          message: language === "python" ? "SyntaxError while compiling solution." : "g++ compilation failed.",
          stderr_tail:
            language === "python"
              ? '  File "solution.py", line 1\n    def (:\n        ^\nSyntaxError: invalid syntax'
              : "solution.cpp:3:5: error: expected ';' before '}' token",
        },
      };
    default:
      return { verdict: "internal_error", passedTests: 0, totalTests: total, runtimeMs: 0, memoryKb: 0 };
  }
}

export function gradeRun(
  problem: ProblemFixture,
  language: Language,
  source: string,
  customInput: unknown,
): GradeResult {
  const verdict = pickVerdict(source, language);
  const example = problem.content.examples[0];
  const inputPreview = customInput ?? example?.args;
  const expectedPreview = example?.expected;

  switch (verdict) {
    case "accepted":
      return {
        verdict,
        passedTests: 1,
        totalTests: 1,
        runtimeMs: 18 + Math.round(Math.random() * 15),
        memoryKb: 13_800,
        failure: {
          kind: "ok",
          message: "Ran against the custom input. This does not affect mastery.",
          input_preview: inputPreview,
          expected_preview: expectedPreview,
          actual_preview: expectedPreview,
        },
      };
    case "wrong_answer":
      return {
        verdict,
        passedTests: 0,
        totalTests: 1,
        runtimeMs: 16,
        memoryKb: 13_700,
        failure: {
          kind: "assertion",
          message: "Output did not match on the custom input.",
          first_failing_test_index: 0,
          input_preview: inputPreview,
          expected_preview: expectedPreview,
          actual_preview: null,
        },
      };
    case "time_limit":
      return {
        verdict,
        passedTests: 0,
        totalTests: 1,
        runtimeMs: 10_000,
        memoryKb: 15_200,
        failure: {
          kind: "time_limit",
          message: "Execution exceeded the wall-clock budget.",
          input_preview: inputPreview,
        },
      };
    case "runtime_error":
      return {
        verdict,
        passedTests: 0,
        totalTests: 1,
        runtimeMs: 8,
        memoryKb: 13_600,
        failure: {
          kind: "runtime_error",
          message: "The program raised an unhandled exception.",
          input_preview: inputPreview,
          stderr_tail:
            language === "python"
              ? 'Traceback (most recent call last):\nRuntimeError: forced failure ("CRASH" marker in source)'
              : "terminate called after throwing an instance of 'std::runtime_error'",
        },
      };
    case "compilation_error":
      return {
        verdict,
        passedTests: 0,
        totalTests: 1,
        runtimeMs: 0,
        memoryKb: 0,
        failure: {
          kind: "compilation_error",
          message: language === "python" ? "SyntaxError while compiling solution." : "g++ compilation failed.",
          stderr_tail:
            language === "python"
              ? '  File "solution.py", line 1\n    def (:\n        ^\nSyntaxError: invalid syntax'
              : "solution.cpp:3:5: error: expected ';' before '}' token",
        },
      };
    default:
      return { verdict: "internal_error", passedTests: 0, totalTests: 1, runtimeMs: 0, memoryKb: 0 };
  }
}
