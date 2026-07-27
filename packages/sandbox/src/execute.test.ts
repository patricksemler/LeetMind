import { describe, expect, it } from "vitest";
import { buildExecutionResult } from "./execute.js";
import type { BundleTestCase, SandboxResult } from "./types.js";

function makeSandboxResult(overrides: Partial<SandboxResult>): SandboxResult {
  return {
    exitCode: 0,
    timedOut: false,
    oomKilled: false,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 12,
    imageDigest: "sha256:abc",
    usage: {},
    ...overrides,
  };
}

const sentinel = "<<<LEETMIND_RESULT>>>";
const oneTest: BundleTestCase[] = [{ args: [1, 2], expected: 3 }];

describe("buildExecutionResult — verdict mapping table", () => {
  it("host timedOut -> time_limit, regardless of stdout content", () => {
    const result = buildExecutionResult({
      sandboxResult: makeSandboxResult({ timedOut: true, exitCode: null, stderr: "some noise" }),
      tests: oneTest,
    });
    expect(result.verdict).toBe("time_limit");
    expect(result.failure?.kind).toBe("time_limit");
    expect(result.passedTests).toBe(0);
  });

  it("sentinel missing + oomKilled -> memory_limit", () => {
    const result = buildExecutionResult({
      sandboxResult: makeSandboxResult({
        exitCode: 137,
        oomKilled: true,
        stderr: "MemoryError",
      }),
      tests: oneTest,
    });
    expect(result.verdict).toBe("memory_limit");
  });

  it("sentinel missing + stdout truncated (and not OOM) -> output_limit", () => {
    const result = buildExecutionResult({
      sandboxResult: makeSandboxResult({
        exitCode: 0,
        stdoutTruncated: true,
        stdout: "A".repeat(100),
      }),
      tests: oneTest,
    });
    expect(result.verdict).toBe("output_limit");
  });

  it("sentinel missing + exit!=0 + traceback in stderr -> runtime_error", () => {
    const result = buildExecutionResult({
      sandboxResult: makeSandboxResult({
        exitCode: 1,
        stderr: 'Traceback (most recent call last):\n  File "/bundle/runner.py"\nZeroDivisionError',
      }),
      tests: oneTest,
    });
    expect(result.verdict).toBe("runtime_error");
    // path scrubbed
    expect(result.failure?.stderr_tail).not.toContain("/bundle/");
  });

  it("sentinel missing + no traceback signature -> internal_error", () => {
    const result = buildExecutionResult({
      sandboxResult: makeSandboxResult({ exitCode: 137, stderr: "" }),
      tests: oneTest,
    });
    expect(result.verdict).toBe("internal_error");
  });

  it("harness ok:false with error_kind syntax_error -> compilation_error", () => {
    const stdout = `${sentinel}\n${JSON.stringify({
      ok: false,
      error_kind: "syntax_error",
      error: "SyntaxError: invalid syntax",
      tests: [],
    })}\n`;
    const result = buildExecutionResult({
      sandboxResult: makeSandboxResult({ stdout }),
      tests: oneTest,
    });
    expect(result.verdict).toBe("compilation_error");
  });

  it("harness ok:false with SyntaxError text but no error_kind -> compilation_error", () => {
    const stdout = `${sentinel}\n${JSON.stringify({
      ok: false,
      error: "SyntaxError: unexpected indent",
      tests: [],
    })}\n`;
    const result = buildExecutionResult({
      sandboxResult: makeSandboxResult({ stdout }),
      tests: oneTest,
    });
    expect(result.verdict).toBe("compilation_error");
  });

  it("harness ok:false for a missing function -> runtime_error", () => {
    const stdout = `${sentinel}\n${JSON.stringify({
      ok: false,
      error_kind: "missing_function",
      error: "no callable named 'twoSum' found",
      tests: [],
    })}\n`;
    const result = buildExecutionResult({
      sandboxResult: makeSandboxResult({ stdout }),
      tests: oneTest,
    });
    expect(result.verdict).toBe("runtime_error");
  });

  it("any test status:timeout -> time_limit, even with other tests passed", () => {
    const stdout = `${sentinel}\n${JSON.stringify({
      ok: true,
      tests: [
        { index: 0, status: "passed", time_ms: 1, memory_kb: 10, output: 3 },
        { index: 1, status: "timeout", time_ms: 5000, memory_kb: 10, error: "time limit exceeded" },
      ],
    })}\n`;
    const result = buildExecutionResult({
      sandboxResult: makeSandboxResult({ stdout }),
      tests: [oneTest[0]!, { args: [1, 1], expected: 2 }],
    });
    expect(result.verdict).toBe("time_limit");
    expect(result.failure?.first_failing_test_index).toBe(1);
    expect(result.passedTests).toBe(1);
    expect(result.totalTests).toBe(2);
  });

  it("QA-PLAN.md §2.9: an earlier wrong_answer is never masked by a later timeout — first failing test IN INDEX ORDER wins, not category priority", () => {
    const stdout = `${sentinel}\n${JSON.stringify({
      ok: true,
      tests: [
        { index: 0, status: "failed", time_ms: 1, memory_kb: 10, output: 4 },
        { index: 1, status: "timeout", time_ms: 5000, memory_kb: 10, error: "time limit exceeded" },
      ],
    })}\n`;
    const result = buildExecutionResult({
      sandboxResult: makeSandboxResult({ stdout }),
      tests: [oneTest[0]!, { args: [1, 1], expected: 2 }],
    });
    // Previously this reported time_limit (checked "any timeout" before "any wrong answer"),
    // with first_failing_test_index pointing at test 1 — actively misleading about where the
    // solution first went wrong.
    expect(result.verdict).toBe("wrong_answer");
    expect(result.failure?.first_failing_test_index).toBe(0);
  });

  it("any test status:error -> runtime_error", () => {
    const stdout = `${sentinel}\n${JSON.stringify({
      ok: true,
      tests: [{ index: 0, status: "error", time_ms: 1, memory_kb: 10, error: "ValueError: boom" }],
    })}\n`;
    const result = buildExecutionResult({
      sandboxResult: makeSandboxResult({ stdout }),
      tests: oneTest,
    });
    expect(result.verdict).toBe("runtime_error");
    expect(result.failure?.message).toContain("ValueError");
  });

  it("any test status:failed (and none error/timeout) -> wrong_answer", () => {
    const stdout = `${sentinel}\n${JSON.stringify({
      ok: true,
      tests: [{ index: 0, status: "failed", time_ms: 1, memory_kb: 10, output: 4 }],
    })}\n`;
    const result = buildExecutionResult({
      sandboxResult: makeSandboxResult({ stdout }),
      tests: oneTest,
    });
    expect(result.verdict).toBe("wrong_answer");
  });

  it("all tests passed -> accepted", () => {
    const stdout = `${sentinel}\n${JSON.stringify({
      ok: true,
      tests: [
        { index: 0, status: "passed", time_ms: 1, memory_kb: 10, output: 3 },
        { index: 1, status: "passed", time_ms: 2, memory_kb: 12, output: 2 },
      ],
    })}\n`;
    const result = buildExecutionResult({
      sandboxResult: makeSandboxResult({ stdout }),
      tests: [oneTest[0]!, { args: [1, 1], expected: 2 }],
    });
    expect(result.verdict).toBe("accepted");
    expect(result.passedTests).toBe(2);
    expect(result.totalTests).toBe(2);
    expect(result.failure).toBeUndefined();
    expect(result.memoryKb).toBe(12);
  });

  it("populates *_preview fields only when revealInputs is true", () => {
    const stdout = `${sentinel}\n${JSON.stringify({
      ok: true,
      tests: [{ index: 0, status: "failed", time_ms: 1, memory_kb: 10, output: 4 }],
    })}\n`;

    const hidden = buildExecutionResult({
      sandboxResult: makeSandboxResult({ stdout }),
      tests: oneTest,
      revealInputs: false,
    });
    expect(hidden.failure?.input_preview).toBeUndefined();
    expect(hidden.failure?.expected_preview).toBeUndefined();
    expect(hidden.failure?.actual_preview).toBeUndefined();

    const revealed = buildExecutionResult({
      sandboxResult: makeSandboxResult({ stdout }),
      tests: oneTest,
      revealInputs: true,
    });
    expect(revealed.failure?.input_preview).toEqual([1, 2]);
    expect(revealed.failure?.expected_preview).toBe(3);
    expect(revealed.failure?.actual_preview).toBe(4);
  });

  it("QA-PLAN.md §3: also reveals previews with revealInputs:false when the failing test's origin is 'example' — CONTRACTS §4.5's second reveal condition", () => {
    const stdout = `${sentinel}\n${JSON.stringify({
      ok: true,
      tests: [
        { index: 0, status: "failed", time_ms: 1, memory_kb: 10, output: 4 },
        { index: 1, status: "failed", time_ms: 1, memory_kb: 10, output: 99 },
      ],
    })}\n`;
    const tests: BundleTestCase[] = [
      { args: [1, 2], expected: 3, origin: "example" },
      { args: [5, 5], expected: 10, origin: "adversarial" },
    ];

    // The first failing test is index 0 (index-order scan, QA-PLAN.md §2.9) — origin "example",
    // so its preview is safe to reveal even though this is a submit-mode failure
    // (revealInputs: false): it's the same input/expected already shown on the problem page.
    const exampleFailure = buildExecutionResult({
      sandboxResult: makeSandboxResult({ stdout }),
      tests,
      revealInputs: false,
    });
    expect(exampleFailure.failure?.first_failing_test_index).toBe(0);
    expect(exampleFailure.failure?.input_preview).toEqual([1, 2]);
    expect(exampleFailure.failure?.expected_preview).toBe(3);
    expect(exampleFailure.failure?.actual_preview).toBe(4);

    // Same shape, but test 0 now passes and test 1 (origin "adversarial", a genuinely hidden
    // case) is the first failure — no preview leaks for it.
    const adversarialStdout = `${sentinel}\n${JSON.stringify({
      ok: true,
      tests: [
        { index: 0, status: "passed", time_ms: 1, memory_kb: 10, output: 3 },
        { index: 1, status: "failed", time_ms: 1, memory_kb: 10, output: 99 },
      ],
    })}\n`;
    const adversarialFailure = buildExecutionResult({
      sandboxResult: makeSandboxResult({ stdout: adversarialStdout }),
      tests,
      revealInputs: false,
    });
    expect(adversarialFailure.failure?.first_failing_test_index).toBe(1);
    expect(adversarialFailure.failure?.input_preview).toBeUndefined();
    expect(adversarialFailure.failure?.expected_preview).toBeUndefined();
    expect(adversarialFailure.failure?.actual_preview).toBeUndefined();
  });

  it("CONTRACTS §4.5: a test with no 'expected' key ('run' against custom_input) reports status 'completed' and does not count toward passed/total", () => {
    const stdout = `${sentinel}\n${JSON.stringify({
      ok: true,
      tests: [{ index: 0, status: "completed", time_ms: 1, memory_kb: 10, output: 42 }],
    })}\n`;
    // The bundled test case has NO `expected` key at all — not `expected: null`.
    const customInputTest: BundleTestCase[] = [{ args: [1, 2] }];
    const result = buildExecutionResult({
      sandboxResult: makeSandboxResult({ stdout }),
      tests: customInputTest,
      revealInputs: true,
    });
    // "the verdict is accepted iff the code ran without error" — no timeout/error/failed status
    // present, so this falls through to accepted even though nothing was "graded".
    expect(result.verdict).toBe("accepted");
    expect(result.passedTests).toBe(0);
    expect(result.totalTests).toBe(0);
    // No expected value to grade against does NOT mean nothing is shown — `run` mode exists so a
    // user can eyeball their program's actual output, and that output must still reach the
    // client (QA-PLAN.md §2.7: an accepted run used to carry no `failure` at all, so the one
    // thing "Run" is for — seeing what the program printed — was never captured anywhere).
    expect(result.failure?.actual_preview).toBe(42);
    expect(result.failure?.input_preview).toEqual([1, 2]);
    expect(result.failure?.expected_preview).toBeUndefined();
  });

  it("a mix of graded and ungraded tests only counts the graded ones toward totalTests", () => {
    const stdout = `${sentinel}\n${JSON.stringify({
      ok: true,
      tests: [
        { index: 0, status: "passed", time_ms: 1, memory_kb: 10, output: 3 },
        { index: 1, status: "completed", time_ms: 1, memory_kb: 10, output: 99 },
      ],
    })}\n`;
    const result = buildExecutionResult({
      sandboxResult: makeSandboxResult({ stdout }),
      tests: [oneTest[0]!, { args: [9, 9] }],
    });
    expect(result.totalTests).toBe(1);
    expect(result.passedTests).toBe(1);
    expect(result.verdict).toBe("accepted");
  });

  it("'expected: null' is a real (graded) expected value, distinct from an absent 'expected' key", () => {
    const stdout = `${sentinel}\n${JSON.stringify({
      ok: true,
      tests: [{ index: 0, status: "failed", time_ms: 1, memory_kb: 10, output: "not null" }],
    })}\n`;
    const result = buildExecutionResult({
      sandboxResult: makeSandboxResult({ stdout }),
      tests: [{ args: [], expected: null }],
    });
    expect(result.totalTests).toBe(1);
    expect(result.verdict).toBe("wrong_answer");
  });

  it("never includes an 'expected' key anywhere in the raw harness payload it forwards", () => {
    // the harness protocol itself never emits `expected` (CONTRACTS §6) — this asserts the TS
    // side doesn't synthesize one either when building the failure object for a wrong_answer.
    const stdout = `${sentinel}\n${JSON.stringify({
      ok: true,
      tests: [{ index: 0, status: "failed", time_ms: 1, memory_kb: 10, output: 4 }],
    })}\n`;
    const result = buildExecutionResult({
      sandboxResult: makeSandboxResult({ stdout }),
      tests: oneTest,
      revealInputs: false,
    });
    // Assert on KEYS and on the secret VALUE — not on the substring "expected", which legitimately
    // appears in the human-readable message ("Output did not match the expected result."). A
    // substring assertion here fails on prose and pressures the next person to weaken it.
    const keys = new Set<string>();
    (function collect(node: unknown): void {
      if (node === null || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        keys.add(k);
        collect(v);
      }
    })(result.failure);
    for (const k of keys) {
      expect(k, `failure object exposed key "${k}"`).not.toMatch(/expected/i);
    }
    // the hidden expected value (3) must not appear in any leaf of the failure payload
    const leaves: unknown[] = [];
    (function collectLeaves(node: unknown): void {
      if (node !== null && typeof node === "object") {
        Object.values(node as Record<string, unknown>).forEach(collectLeaves);
        return;
      }
      leaves.push(node);
    })(result.failure);
    expect(leaves).not.toContain(oneTest[0]!.expected);
  });
});
