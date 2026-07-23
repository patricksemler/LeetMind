/**
 * Composes bundle -> run -> parse into a normalized execution result, and maps the harness /
 * host outcome onto a `Verdict` per the rules in this package's brief (derived from
 * CONTRACTS §4.3 / §6 / §7).
 *
 * The verdict-mapping logic (`buildExecutionResult`) is a pure function of a `SandboxResult` +
 * the tests that were run, deliberately factored out of `executePython` so it can be unit
 * tested exhaustively without Docker.
 */
import { buildPythonBundle } from "./bundle.js";
import { parseHarnessOutput } from "./parse.js";
import { runSandboxed } from "./run.js";
import type {
  BundleTestCase,
  ComparatorSpec,
  ExecutionFailure,
  ExecutionPerTestResult,
  ExecutionResult,
  HarnessResult,
  SandboxLimits,
  SandboxResult,
  Signature,
  Verdict,
} from "./types.js";
import { hasExpectedValue } from "./types.js";

const STDERR_TAIL_MAX = 2000;

/** Scrubs absolute in-container paths out of any text surfaced to a caller/client. */
export function scrubPaths(text: string): string {
  return text.replace(/\/(?:bundle|work)\//g, "");
}

export function tail(text: string, max = STDERR_TAIL_MAX): string {
  return text.length > max ? text.slice(-max) : text;
}

/**
 * Classifies a "no sentinel, not OOM, not output-truncated" host outcome — i.e. the process ended
 * without ever producing a harness result and none of the other host-side explanations apply.
 * Language-specific because the signal is language-specific: Python always has a traceback marker
 * for an uncaught exception; a native crash (segfault from a stack overflow, glibc abort, etc.)
 * instead shows up as a signal-derived exit code. Pluggable via `classifyOpaqueFailure` on
 * `BuildExecutionResultInput` so `executeCpp` (packages/sandbox/src/cpp/execute.ts) can supply its
 * own without duplicating the rest of this pipeline (timeout/OOM/truncation/per-test mapping,
 * which are all language-agnostic — the sentinel protocol is shared).
 */
export function classifyPythonOpaqueFailure(sandboxResult: SandboxResult): { verdict: Verdict; message: string } {
  const looksLikeUserTraceback = /Traceback \(most recent call last\)/.test(sandboxResult.stderr);
  const verdict: Verdict = looksLikeUserTraceback ? "runtime_error" : "internal_error";
  return {
    verdict,
    message:
      verdict === "runtime_error"
        ? "The program crashed before producing a result."
        : "The judge could not read a result from the sandbox.",
  };
}

function previewFields(
  tests: BundleTestCase[],
  harness: HarnessResult,
  index: number,
  revealInputs: boolean,
): Pick<ExecutionFailure, "input_preview" | "expected_preview" | "actual_preview"> {
  if (!revealInputs) return {};
  const test = tests[index];
  const harnessTest = harness.tests.find((t) => t.index === index);
  const preview: Pick<ExecutionFailure, "input_preview" | "expected_preview" | "actual_preview"> =
    {};
  if (test) {
    preview.input_preview = test.args;
    preview.expected_preview = test.expected;
  }
  if (harnessTest) {
    preview.actual_preview = harnessTest.output;
  }
  return preview;
}

export interface BuildExecutionResultInput {
  sandboxResult: SandboxResult;
  tests: BundleTestCase[];
  /** true only for `run` mode / example-derived tests — CONTRACTS §4.5 */
  revealInputs?: boolean;
  /** See `classifyPythonOpaqueFailure` above. Defaults to the Python heuristic; `executeCpp`
   * supplies a native-crash-aware classifier instead. */
  classifyOpaqueFailure?: (sandboxResult: SandboxResult) => { verdict: Verdict; message: string };
  /** Classifies a top-level `harness.ok === false` result (missing function / import / syntax
   * error for Python; a genuine harness/bundle bug for C++, since anything else in C++ would have
   * failed to *compile*). Defaults to the Python heuristic (syntax error -> compilation_error,
   * else runtime_error). */
  classifyHarnessError?: (harness: HarnessResult) => Verdict;
}

function defaultClassifyHarnessError(harness: HarnessResult): Verdict {
  const isSyntaxError = harness.error_kind === "syntax_error" || /SyntaxError/.test(harness.error ?? "");
  return isSyntaxError ? "compilation_error" : "runtime_error";
}

export function buildExecutionResult(input: BuildExecutionResultInput): ExecutionResult {
  const {
    sandboxResult,
    tests,
    revealInputs = false,
    classifyOpaqueFailure = classifyPythonOpaqueFailure,
    classifyHarnessError = defaultClassifyHarnessError,
  } = input;
  // CONTRACTS §4.5: a `run` against `custom_input` has no expected value, so its test(s) never
  // count toward passed/total — only tests with a real (possibly-null) `expected` are "graded".
  const totalTests = tests.filter(hasExpectedValue).length;
  const runtimeMs = sandboxResult.durationMs;

  const empty = (
    verdict: Verdict,
    failure: ExecutionFailure,
    harness: HarnessResult | null = null,
    parseError?: string,
  ): ExecutionResult => ({
    verdict,
    passedTests: 0,
    totalTests,
    runtimeMs,
    memoryKb: null,
    perTest: [],
    failure,
    raw: { sandbox: sandboxResult, harness, ...(parseError ? { parseError } : {}) },
  });

  // 1. Host-enforced wall timeout always wins: the container was killed from outside, so
  //    nothing it printed can be trusted as a real result even if a sentinel happens to be
  //    present (e.g. it was mid-write when killed).
  if (sandboxResult.timedOut) {
    return empty("time_limit", {
      kind: "time_limit",
      message: "Execution exceeded the wall-clock time limit.",
      stderr_tail: tail(scrubPaths(sandboxResult.stderr)),
    });
  }

  const parsed = parseHarnessOutput(sandboxResult.stdout);

  if (!parsed.ok) {
    // 2. OOM heuristic.
    if (sandboxResult.oomKilled) {
      return empty(
        "memory_limit",
        {
          kind: "memory_limit",
          message: "The process was killed for exceeding the memory limit.",
          stderr_tail: tail(scrubPaths(sandboxResult.stderr)),
        },
        null,
        parsed.error,
      );
    }

    // 3. Output truncation prevented us from ever seeing a sentinel.
    if (sandboxResult.stdoutTruncated) {
      return empty(
        "output_limit",
        {
          kind: "output_limit",
          message: "Program output exceeded the size limit before a result could be read.",
          stderr_tail: tail(scrubPaths(sandboxResult.stderr)),
        },
        null,
        parsed.error,
      );
    }

    // 4. No sentinel, no known infra reason -> distinguish "user code crashed visibly" from
    //    "something went wrong in the judge/harness itself". Language-specific — see
    //    `classifyOpaqueFailure`.
    const { verdict, message } = classifyOpaqueFailure(sandboxResult);
    return empty(
      verdict,
      {
        kind: verdict,
        message,
        stderr_tail: tail(scrubPaths(sandboxResult.stderr)),
      },
      null,
      parsed.error,
    );
  }

  const harness = parsed.result;

  // 5. Harness itself reported a top-level (pre-test) failure: missing function, import error,
  //    or a syntax error. Python has no separate compile step, so a SyntaxError at import time
  //    is the one case that maps to `compilation_error`; everything else here is `runtime_error`.
  //    (C++ overrides this via `classifyHarnessError` -> always `internal_error`, since anything
  //    equivalent to "missing function"/"syntax error" would already have failed to compile.)
  if (!harness.ok) {
    const verdict = classifyHarnessError(harness);
    return empty(
      verdict,
      {
        kind: verdict,
        message: scrubPaths(harness.error ?? "The solution failed to load."),
      },
      harness,
    );
  }

  const perTest: ExecutionPerTestResult[] = harness.tests.map((t) => ({
    index: t.index,
    status: t.status,
    timeMs: t.time_ms,
    memoryKb: t.memory_kb,
    passed: t.status === "passed",
  }));

  const passedTests = perTest.filter((t) => t.passed).length;
  const memoryKb = perTest.length > 0 ? Math.max(...perTest.map((t) => t.memoryKb)) : null;

  const finalize = (
    verdict: Verdict,
    failure?: ExecutionFailure,
  ): ExecutionResult => ({
    verdict,
    passedTests,
    totalTests,
    runtimeMs,
    memoryKb,
    perTest,
    failure,
    raw: { sandbox: sandboxResult, harness },
  });

  // 6. Any per-test timeout.
  const timedOutTest = harness.tests.find((t) => t.status === "timeout");
  if (timedOutTest) {
    return finalize("time_limit", {
      kind: "time_limit",
      message: "A test exceeded its per-test time limit.",
      first_failing_test_index: timedOutTest.index,
      ...previewFields(tests, harness, timedOutTest.index, revealInputs),
    });
  }

  // 7. Any per-test runtime error.
  const erroredTest = harness.tests.find((t) => t.status === "error");
  if (erroredTest) {
    return finalize("runtime_error", {
      kind: "runtime_error",
      message: scrubPaths(erroredTest.error ?? "The solution raised an error."),
      first_failing_test_index: erroredTest.index,
      ...previewFields(tests, harness, erroredTest.index, revealInputs),
    });
  }

  // 8. Any wrong output.
  const failedTest = harness.tests.find((t) => t.status === "failed");
  if (failedTest) {
    return finalize("wrong_answer", {
      kind: "wrong_answer",
      message: "Output did not match the expected result.",
      first_failing_test_index: failedTest.index,
      ...previewFields(tests, harness, failedTest.index, revealInputs),
    });
  }

  // 9. Everything passed.
  return finalize("accepted");
}

export interface ExecutePythonOptions {
  signature: Signature;
  tests: BundleTestCase[];
  comparator: ComparatorSpec;
  source: string;
  limits: SandboxLimits;
  image: string;
  checkerSource?: string;
  /** defaults to an even split of the wall timeout across tests, floor 1000ms */
  perTestTimeoutMs?: number;
  /** true only for `run` mode / example-derived tests — CONTRACTS §4.5 */
  revealInputs?: boolean;
  correlationId?: string;
}

export async function executePython(opts: ExecutePythonOptions): Promise<ExecutionResult> {
  const {
    signature,
    tests,
    comparator,
    source,
    limits,
    image,
    checkerSource,
    revealInputs,
    correlationId,
  } = opts;

  const perTestTimeoutMs =
    opts.perTestTimeoutMs ?? Math.max(1000, Math.floor(limits.wallTimeoutMs / Math.max(tests.length, 1)));

  const files = buildPythonBundle({
    signature,
    tests,
    comparator,
    solutionSource: source,
    checkerSource,
    perTestTimeoutMs,
  });

  const sandboxResult = await runSandboxed({
    image,
    files,
    argv: ["python3", "/bundle/runner.py"],
    limits,
    correlationId,
  });

  return buildExecutionResult({ sandboxResult, tests, revealInputs });
}
