/**
 * Type surface for @leetmind/sandbox. Shapes marked "CONTRACTS §6" are copied verbatim from
 * docs/CONTRACTS.md and must not drift from it.
 */
import type { z } from "zod";
import type { SignatureSchema, Verdict } from "@leetmind/shared";

/** The typed function signature a problem exposes, per CONTRACTS §4.1. */
export type Signature = z.infer<typeof SignatureSchema>;

/** Re-exported for convenience so callers of this package don't need a separate import. */
export type { Verdict };

// ---------------------------------------------------------------------------
// CONTRACTS §6 — execution substrate
// ---------------------------------------------------------------------------

export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  wallTimeoutMs: number;
  outputLimitBytes: number;
}

export interface SandboxRequest {
  image: string;
  /** relative path -> contents, written into the bundle dir */
  files: Record<string, string>;
  /** command inside the container */
  argv: string[];
  limits: SandboxLimits;
  correlationId?: string;
}

export interface SandboxResult {
  exitCode: number | null;
  timedOut: boolean;
  oomKilled: boolean;
  /** truncated to outputLimitBytes */
  stdout: string;
  /** truncated to outputLimitBytes */
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  imageDigest: string | null;
  usage: { maxRssKb?: number };
}

// ---------------------------------------------------------------------------
// Harness result protocol (CONTRACTS §6 / §7)
// ---------------------------------------------------------------------------

/**
 * `completed` is CONTRACTS §4.5's run-mode-with-`custom_input` status: there is no expected value
 * to compare against, so the harness runs the test, captures its (truncated) output, and reports
 * `completed` instead of `passed`/`failed` — it is neither graded pass nor fail. A test only ever
 * reaches this status when its bundled test case has no `expected` field at all (see
 * `BundleTestCase.expected` below).
 */
export type HarnessTestStatus = "passed" | "failed" | "error" | "timeout" | "completed";

export interface HarnessTestResult {
  index: number;
  status: HarnessTestStatus;
  time_ms: number;
  memory_kb: number;
  stdout?: string;
  error?: string;
  /** truncated to 2KB in-container; never present for tests still pending compare */
  output?: unknown;
  output_truncated?: boolean;
}

export interface HarnessResult {
  ok: boolean;
  tests: HarnessTestResult[];
  /** present only for languages with a separate compile step (C++, M4) */
  compile?: { ok: boolean; error?: string };
  /** top-level load/import/syntax error when ok === false */
  error?: string;
  /** coarse classification of a top-level failure, e.g. 'syntax_error' | 'import_error' | 'missing_function' */
  error_kind?: string;
}

// ---------------------------------------------------------------------------
// Bundle construction (CONTRACTS §7)
// ---------------------------------------------------------------------------

export interface ComparatorSpec {
  kind: "exact" | "float_tol" | "unordered" | "checker_py";
  tol?: number;
}

export interface BundleTestCase {
  args: unknown[];
  /**
   * Omitted entirely (not `null`) for a `run` against `custom_input` (CONTRACTS §4.5): there is
   * no known-correct value to grade against. `null` stays a legitimate *expected value* (a
   * solution can correctly return `null`), so presence/absence of the key — not its value — is
   * what distinguishes "no expected value" from "expected value happens to be null". Every
   * harness (`runner.py`, the generated C++ `main.cpp`) and `buildExecutionResult`/
   * `buildCppExecutionResult` key off presence, never off `=== null`.
   */
  expected?: unknown;
  /**
   * Carried through from `content.hidden_tests[i].origin` for `submit`-mode tests (CONTRACTS
   * §4.5). When it's `"example"` — the same input/expected values already shown in the problem
   * statement — `buildExecutionResult` reveals preview fields for THAT test even in `submit`
   * mode, same as it always does for `run` mode. Never set for `run`-mode tests (which reveal via
   * the `revealInputs` flag instead, not per-test origin).
   */
  origin?: string;
}

/** True iff `test` carries a real (possibly-null) expected value to grade against — as opposed to
 * a `run`-mode `custom_input` test, which carries none. Presence-based, not value-based: see
 * `BundleTestCase.expected`. */
export function hasExpectedValue(test: BundleTestCase): boolean {
  return Object.prototype.hasOwnProperty.call(test, "expected");
}

export interface BundleSpec {
  signature: Signature;
  tests: BundleTestCase[];
  comparator: ComparatorSpec;
  solutionSource: string;
  checkerSource?: string;
  perTestTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Normalized execution result (produced by execute.ts)
// ---------------------------------------------------------------------------
// `Verdict` (CONTRACTS §4.3) is imported from @leetmind/shared above and re-exported. `cancelled`
// is part of that enum for completeness but is never produced by this package directly — the
// caller sets it when a job is cancelled before/independent of execution.

export interface ExecutionPerTestResult {
  index: number;
  status: HarnessTestStatus;
  timeMs: number;
  memoryKb: number;
  passed: boolean;
  /** What the solution actually returned, as decoded by the harness. Server-side only: the caller
   * decides which of these are safe to serve (only PUBLIC tests are — see `publicResults` in
   * apps/judge). Absent when the test errored or timed out before producing a value. */
  output?: unknown;
}

/** Safe diagnostics only — CONTRACTS §4.5. Never leaks hidden expected values for `submit`. */
export interface ExecutionFailure {
  kind: string;
  message: string;
  first_failing_test_index?: number;
  stderr_tail?: string;
  input_preview?: unknown;
  expected_preview?: unknown;
  actual_preview?: unknown;
}

export interface ExecutionResult {
  verdict: Verdict;
  passedTests: number;
  totalTests: number;
  /** For C++, this is the RUN step's duration only — see `compile` below for the compile step's
   * own duration, recorded separately per CONTRACTS §7. */
  runtimeMs: number;
  memoryKb: number | null;
  perTest: ExecutionPerTestResult[];
  failure?: ExecutionFailure;
  /** Present only for languages with a separate compile step (C++, M4). `durationMs` is the
   * compile sandbox invocation's own wall time, distinct from `runtimeMs` (the run step). */
  compile?: { ok: boolean; durationMs: number; imageDigest: string | null };
  raw: {
    sandbox: SandboxResult;
    harness: HarnessResult | null;
    parseError?: string;
  };
}
