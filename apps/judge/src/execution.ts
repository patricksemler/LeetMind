// Shared plumbing between src/handler.ts and src/rejudge.ts: picking which tests to run for a
// given (mode, content) pair, turning judge/sandbox config into the
// @leetmind/sandbox request shapes, and dispatching to the right language's executor. Kept
// separate so rejudge.ts (which must reproduce the exact same test selection AND execution path
// against a submission's ORIGINAL pinned content) never drifts from the judge's own logic.
import { executeCpp, executePython, type BundleTestCase, type ComparatorSpec, type ExecutionResult, type SandboxLimits, type Signature } from "@leetmind/sandbox";
import type { Language, ProblemVersion, SandboxConfig, SubmissionMode } from "@leetmind/shared";

export interface SelectedTests {
  tests: BundleTestCase[];
  /** Kept for the sandbox's preview gate. Public tests reveal themselves via `origin` now, so
   * this is only ever true for a `run` — see `previewFields` in @leetmind/sandbox. */
  revealInputs: boolean;
  publicCount: number;
  hiddenCount: number;
}

/** Two tests are the same case if they take the same arguments. The generated hidden suite
 * deliberately includes the statement's own examples (`origin: "example"`), so concatenating
 * examples + hidden tests without this would run — and count — some of them twice. */
function argsKey(args: unknown[]): string {
  return JSON.stringify(args);
}

/**
 * Which tests a submission runs.
 *
 *   run    → the problem's public examples, exactly as printed in the statement.
 *   submit → those same public examples PLUS the hidden suite.
 *
 * Submit is a strict superset on purpose: "passed" has to mean passed everything the user can see
 * *and* everything they can't, and the totals have to make that visible. Submit previously ran
 * only `hidden_tests`, so a problem with 2 examples and 5 hidden tests reported "5/5" for a
 * submission and "2/2" for a run — two unrelated denominators, neither of which was the number of
 * test cases the solution had actually satisfied.
 *
 * Public tests come first so `first_failing_test_index` points at a case the user can actually
 * look at whenever one of those is what broke.
 */
export function selectTests(content: ProblemVersion, mode: SubmissionMode): SelectedTests {
  const publicTests: BundleTestCase[] = content.examples.map((e) => ({
    args: e.args,
    expected: e.expected,
    origin: "public",
  }));

  if (mode === "run") {
    return { tests: publicTests, revealInputs: true, publicCount: publicTests.length, hiddenCount: 0 };
  }

  const seen = new Set(publicTests.map((t) => argsKey(t.args)));
  const hiddenTests: BundleTestCase[] = [];
  for (const t of content.hidden_tests) {
    if (seen.has(argsKey(t.args))) continue;
    seen.add(argsKey(t.args));
    hiddenTests.push({ args: t.args, expected: t.expected, origin: "hidden" });
  }

  return {
    tests: [...publicTests, ...hiddenTests],
    revealInputs: false,
    publicCount: publicTests.length,
    hiddenCount: hiddenTests.length,
  };
}

export interface TestOriginSummary {
  public_passed: number;
  public_total: number;
  hidden_passed: number;
  hidden_total: number;
}

/**
 * Splits the pass counts by whether the user can see the test.
 *
 * "4/5" on its own does not tell you what to fix. Knowing that all the public examples passed and
 * one hidden case did not is a different debugging problem from failing example 2 — the first says
 * "your approach breaks on an input you haven't thought of", the second says "look at the page".
 */
export function summarizeTestOrigins(
  tests: BundleTestCase[],
  perTest: readonly { index: number; passed: boolean }[],
): TestOriginSummary {
  const passedByIndex = new Map(perTest.map((t) => [t.index, t.passed]));
  const summary: TestOriginSummary = { public_passed: 0, public_total: 0, hidden_passed: 0, hidden_total: 0 };
  tests.forEach((test, index) => {
    // A test with no `expected` is ungraded and excluded from totals everywhere else too
    // (`buildExecutionResult`), so it must not inflate these either.
    if (!("expected" in test)) return;
    const isPublic = test.origin === "public" || test.origin === "example";
    const passed = passedByIndex.get(index) === true;
    if (isPublic) {
      summary.public_total += 1;
      if (passed) summary.public_passed += 1;
    } else {
      summary.hidden_total += 1;
      if (passed) summary.hidden_passed += 1;
    }
  });
  return summary;
}

/** One public test's outcome, safe to serve verbatim: the input and expected value are printed in
 * the problem statement, and the actual output is the user's own program's. */
export interface PublicTestResult {
  index: number;
  status: string;
  passed: boolean;
  actual?: unknown;
}

/**
 * Per-test outcomes for the PUBLIC tests only, in statement order.
 *
 * This is what lets the workspace render a LeetCode-style case list — every example visible up
 * front, each turning green or red once a run lands — instead of naming only the first failure.
 * Hidden tests are excluded here by construction rather than filtered downstream: nothing that
 * isn't already on the problem page can end up in this array.
 */
export function publicResults(
  tests: BundleTestCase[],
  perTest: readonly { index: number; passed: boolean; status: string; output?: unknown }[],
): PublicTestResult[] {
  const byIndex = new Map(perTest.map((t) => [t.index, t]));
  const results: PublicTestResult[] = [];
  tests.forEach((test, index) => {
    if (test.origin !== "public" && test.origin !== "example") return;
    const run = byIndex.get(index);
    results.push({
      index: results.length,
      // A test the harness never reported (an earlier crash cut the run short) is "not run", not
      // a silent pass.
      status: run?.status ?? "not_run",
      passed: run?.passed === true,
      ...(run && "output" in run ? { actual: run.output } : {}),
    });
  });
  return results;
}

/** The single test that ended the run, in the shape the workspace renders a case in. */
export interface FailingTestDetail {
  index: number;
  origin: "public" | "hidden";
  args: unknown[];
  expected?: unknown;
  actual?: unknown;
  status?: string;
}

/**
 * Detail for the ONE test named by `first_failing_test_index` — including a hidden one.
 *
 * This is the deliberate narrowing of CONTRACTS §4.5 described on `FailingTestSchema`
 * (@leetmind/shared): the failing hidden case is served so the user has something to act on. Only
 * this one test is ever built, never a scan of the suite, so a submission can surface at most a
 * single hidden case. Returns `undefined` when the failure names no test (a compile error, say) or
 * the index doesn't resolve to a graded case.
 */
export function failingTestDetail(
  tests: BundleTestCase[],
  perTest: readonly { index: number; passed: boolean; status: string; output?: unknown }[],
  failingIndex: number | undefined,
): FailingTestDetail | undefined {
  if (typeof failingIndex !== "number") return undefined;
  const test = tests[failingIndex];
  if (!test) return undefined;
  const run = perTest.find((t) => t.index === failingIndex);
  const isPublic = test.origin === "public" || test.origin === "example";
  return {
    index: failingIndex,
    origin: isPublic ? "public" : "hidden",
    args: test.args,
    ...("expected" in test ? { expected: test.expected } : {}),
    ...(run && "output" in run ? { actual: run.output } : {}),
    ...(run ? { status: run.status } : {}),
  };
}

/** `content.comparator` is a bare enum (CONTRACTS §4.2) with no per-problem tolerance field;
 * `float_tol` uses a fixed default tolerance. */
const FLOAT_TOL_DEFAULT = 1e-6;

export function buildComparatorSpec(content: ProblemVersion): ComparatorSpec {
  if (content.comparator === "float_tol") {
    return { kind: "float_tol", tol: FLOAT_TOL_DEFAULT };
  }
  return { kind: content.comparator };
}

export function buildLimits(sandbox: SandboxConfig): SandboxLimits {
  return {
    memoryMb: sandbox.memoryMb,
    cpus: sandbox.cpus,
    pidsLimit: sandbox.pidsLimit,
    wallTimeoutMs: sandbox.wallTimeoutMs,
    outputLimitBytes: sandbox.outputLimitBytes,
  };
}

/** Hardcoded rather than shelled out per-execution: the runner image is pinned to a single,
 * known Python version (`docker/runner-python/Dockerfile`: `python:3.12-slim`, CONTRACTS §6). */
export const PYTHON_LANGUAGE_VERSION = "python3.12";

/** Same rationale as `PYTHON_LANGUAGE_VERSION` — pinned to `docker/runner-cpp/Dockerfile`'s base
 * image (`gcc:14`, CONTRACTS §6), not queried per-execution. */
export const CPP_LANGUAGE_VERSION = "g++14";

/** `docs/CONTRACTS.md` §7's mandated compile invocation — recorded verbatim on every C++
 * `execution_attempts` row's `flags` column so a historical compile is fully reproducible. */
export const CPP_COMPILE_FLAGS = "-std=c++20 -O2 -pipe -static-libstdc++";

export interface ExecuteSubmissionInput {
  language: Language;
  signature: Signature;
  tests: BundleTestCase[];
  comparator: ComparatorSpec;
  source: string;
  limits: SandboxLimits;
  pythonImage: string;
  cppImage: string;
  /** Python-only (CONTRACTS §7); ignored for `language: 'cpp'`. */
  checkerSource?: string;
  revealInputs?: boolean;
  correlationId?: string;
}

export interface ExecuteSubmissionOutput {
  result: ExecutionResult;
  languageVersion: string;
  /** g++ compile flags for a C++ submission; `null` for Python (no separate compile step). */
  flags: string | null;
}

/**
 * The single dispatch point between the judge's language-agnostic submission flow and
 * `@leetmind/sandbox`'s two per-language executors — `apps/judge/src/handler.ts` and
 * `apps/judge/src/rejudge.ts` both call this instead of branching on `language` themselves, so the
 * two flows (live judge, historical rejudge) can never drift on which executor a language maps to.
 */
export async function executeSubmission(input: ExecuteSubmissionInput): Promise<ExecuteSubmissionOutput> {
  const { language, signature, tests, comparator, source, limits, pythonImage, cppImage, checkerSource, revealInputs, correlationId } = input;

  if (language === "python") {
    const result = await executePython({
      signature,
      tests,
      comparator,
      source,
      limits,
      image: pythonImage,
      checkerSource,
      revealInputs,
      correlationId,
    });
    return { result, languageVersion: PYTHON_LANGUAGE_VERSION, flags: null };
  }

  const result = await executeCpp({
    signature,
    tests,
    comparator,
    source,
    limits,
    image: cppImage,
    revealInputs,
    correlationId,
  });
  return { result, languageVersion: CPP_LANGUAGE_VERSION, flags: CPP_COMPILE_FLAGS };
}
