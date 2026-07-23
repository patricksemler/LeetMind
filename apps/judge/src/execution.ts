// Shared plumbing between src/handler.ts and src/rejudge.ts: picking which tests to run for a
// given (mode, content, custom_input) combination, turning judge/sandbox config into the
// @algolift/sandbox request shapes, and dispatching to the right language's executor. Kept
// separate so rejudge.ts (which must reproduce the exact same test selection AND execution path
// against a submission's ORIGINAL pinned content) never drifts from the judge's own logic.
import { executeCpp, executePython, type BundleTestCase, type ComparatorSpec, type ExecutionResult, type SandboxLimits, type Signature } from "@algolift/sandbox";
import type { Language, ProblemVersion, SandboxConfig, SubmissionMode } from "@algolift/shared";

export interface SelectedTests {
  tests: BundleTestCase[];
  /** true only for `run` mode / example-derived tests — CONTRACTS §4.5. */
  revealInputs: boolean;
}

/**
 * Best-effort normalization of `submissions.custom_input` into an argument list. The column is
 * declared `jsonb?` with no fixed shape in CONTRACTS.md beyond "the submission's custom_input
 * when present" (§6 Judge flow); this accepts either `{ args: [...] }` (the natural shape given
 * `Signature.params`) or a bare JSON array used directly as the argument list.
 */
function customInputToArgs(customInput: unknown): unknown[] | null {
  if (Array.isArray(customInput)) return customInput;
  if (customInput && typeof customInput === "object" && Array.isArray((customInput as { args?: unknown }).args)) {
    return (customInput as { args: unknown[] }).args;
  }
  return null;
}

/**
 * CONTRACTS.md §6 Judge flow, step 3: `mode:'submit'` -> `content.hidden_tests`; `mode:'run'` ->
 * `content.examples` mapped to test cases, or the submission's `custom_input` when present.
 *
 * CONTRACTS §4.5: "Run mode with `custom_input` has no expected value" — there is nothing to
 * compare against, so that test case is built WITHOUT an `expected` key at all (not
 * `expected: null`, which is itself a legitimate — if unusual — expected value). Both harnesses
 * (`runner.py`, the generated C++ main.cpp) key off presence of the key, never off its value, and
 * report that test `status: "completed"` instead of `passed`/`failed`; `buildExecutionResult`
 * (packages/sandbox) then excludes it from `passed_tests`/`total_tests` entirely, and the overall
 * verdict is `accepted` iff nothing errored/timed out — never a spurious `wrong_answer`.
 */
export function selectTests(
  content: ProblemVersion,
  mode: SubmissionMode,
  customInput: unknown | null | undefined,
): SelectedTests {
  if (mode === "submit") {
    return {
      // `origin` is carried through so `buildExecutionResult` (packages/sandbox) can reveal
      // preview fields for a failing test whose origin is `"example"` even in submit mode
      // (CONTRACTS §4.5) — those inputs/expected values are already shown in the problem
      // statement, not actually hidden from the user.
      tests: content.hidden_tests.map((t) => ({ args: t.args, expected: t.expected, origin: t.origin })),
      revealInputs: false,
    };
  }

  const customArgs = customInputToArgs(customInput);
  if (customArgs) {
    return { tests: [{ args: customArgs }], revealInputs: true };
  }

  return {
    tests: content.examples.map((e) => ({ args: e.args, expected: e.expected })),
    revealInputs: true,
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
 * `@algolift/sandbox`'s two per-language executors — `apps/judge/src/handler.ts` and
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
