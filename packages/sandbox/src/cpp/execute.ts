/**
 * `executeCpp` — CONTRACTS §7's C++ bundle + compile-then-run flow, mirroring `../execute.ts`'s
 * `executePython` shape (same options surface, same `ExecutionResult` return type) so judge code
 * can dispatch on `language` with minimal branching (see apps/judge/src/execution.ts).
 *
 * Compile and run are deliberately TWO separate `runSandboxed` invocations with their own limits
 * (CONTRACTS §7: "Compile step runs in the sandbox first ... then execution ... Compile and run
 * are separate sandbox invocations with their own limits"). Each container is `--rm` with its own
 * ephemeral `/work` tmpfs (CONTRACTS §6) and a READ-ONLY `/bundle` mount, so nothing written to
 * `/work` in the compile container is visible to any later container — the compiled binary is the
 * one thing that has to cross that boundary, and the only channel available is whatever the host
 * captured from the compile step's stdout. `base64` keeps that channel UTF-8-safe (SandboxResult
 * decodes stdout as text) for what is otherwise arbitrary binary content: the compile step's argv
 * is a small `sh -c` wrapper around the exact mandated `g++ -std=c++20 -O2 -pipe
 * -static-libstdc++ /bundle/main.cpp -o /work/prog` invocation that additionally base64-encodes
 * the resulting binary to stdout on success (`&&`-chained, so a compile failure never runs it and
 * g++'s own diagnostics land on stderr exactly as they would from a bare invocation); the run step
 * decodes that back into an executable inside its own fresh `/work` tmpfs. This is a deliberate
 * deviation from a literal reading of the g++ argv in CONTRACTS §7 — the exact compiler flags are
 * unchanged, but the invocation is wrapped to satisfy the "separate invocations, binary survives
 * between them" requirement, which a container boundary otherwise makes impossible. See this
 * package's M4 report for the reasoning spelled out in full.
 */
import { buildExecutionResult, scrubPaths, tail } from "../execute.js";
import { runSandboxed } from "../run.js";
import { hasExpectedValue } from "../types.js";
import type {
  BundleTestCase,
  ComparatorSpec,
  ExecutionResult,
  SandboxLimits,
  SandboxResult,
  Signature,
  Verdict,
} from "../types.js";
import { buildCppBundle } from "./bundle.js";

const COMPILE_ARGV = [
  "sh",
  "-c",
  "g++ -std=c++20 -O2 -pipe -static-libstdc++ /bundle/main.cpp -o /work/prog && base64 /work/prog",
];

const RUN_ARGV = ["sh", "-c", "base64 -d /bundle/prog.b64 > /work/prog && chmod +x /work/prog && /work/prog /bundle"];

// A `g++ -O2 -static-libstdc++` binary (even for a tiny solution) commonly runs 1-2MB; base64
// inflates that ~4/3. The default SANDBOX_OUTPUT_LIMIT_BYTES (64KB, CONTRACTS §2) is nowhere near
// enough for the compile step specifically (the RUN step's own output stays capped normally — the
// 64KB default is about a program's own stdout, which the harness itself already caps to 4KB per
// test long before it reaches the sandbox's output cap).
const MIN_COMPILE_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const MIN_COMPILE_WALL_TIMEOUT_MS = 30_000;
// Empirically determined (see this package's M4 report): with --memory-swap pinned equal to
// --memory (no swap, matching this sandbox's normal flags), g++ -O2 -static-libstdc++ compiling
// against the vendored nlohmann/json single header gets cc1plus SIGKILLed by the cgroup OOM killer
// under ~768MB, surfacing as a confusing assembler error ("Killed signal terminated program
// cc1plus") rather than a clean OOM signal — 1024MB leaves comfortable headroom above the ~768MB
// empirical floor.
const MIN_COMPILE_MEMORY_MB = 1024;

/** CONTRACTS §7: "give compilation a longer wall timeout than execution". Also widens the output
 * cap (see above) and floors memory a bit above the execution limit — `-O2` template-heavy
 * compiles can need more headroom than a 256MB default execution sandbox. Callers may override via
 * `ExecuteCppOptions.compileLimits` instead of accepting these defaults. */
export function defaultCompileLimits(executionLimits: SandboxLimits): SandboxLimits {
  return {
    memoryMb: Math.max(executionLimits.memoryMb, MIN_COMPILE_MEMORY_MB),
    cpus: executionLimits.cpus,
    pidsLimit: executionLimits.pidsLimit,
    wallTimeoutMs: Math.max(executionLimits.wallTimeoutMs * 3, MIN_COMPILE_WALL_TIMEOUT_MS),
    outputLimitBytes: Math.max(executionLimits.outputLimitBytes, MIN_COMPILE_OUTPUT_LIMIT_BYTES),
  };
}

/**
 * The C++-appropriate version of `../execute.ts`'s `classifyPythonOpaqueFailure`: by the time this
 * runs, compilation already succeeded and `main.cpp`'s own top-level `try`/`catch(...)` (and each
 * test's own worker-thread `try`/`catch(...)`) have already turned every ordinary C++ exception
 * (including `std::bad_alloc`) into a structured sentinel result — so "no sentinel, not OOM, not
 * timed out" realistically means the process was killed by a signal it could never catch (a native
 * stack overflow -> SIGSEGV being the main real-world case; CONTRACTS §7 asks this codegen to
 * mitigate deep recursion with a large thread stack, not to guarantee immunity to it). Exit codes
 * in the 129-255 range follow the shell convention of `128 + signal number`, which is what a
 * signal-killed process reports through Docker/Node's child_process — a reasonable, if imperfect,
 * signal that this was a crash rather than a harness bug.
 */
export function classifyCppOpaqueFailure(sandboxResult: SandboxResult): { verdict: Verdict; message: string } {
  const code = sandboxResult.exitCode;
  const looksLikeNativeCrash = code !== null && code >= 129 && code <= 255;
  return {
    verdict: looksLikeNativeCrash ? "runtime_error" : "internal_error",
    message: looksLikeNativeCrash
      ? "The program crashed before producing a result (a native crash such as a stack overflow or segmentation fault)."
      : "The judge could not read a result from the sandbox.",
  };
}

function fakeSandboxResult(overrides: Partial<SandboxResult> = {}): SandboxResult {
  return {
    exitCode: null,
    timedOut: false,
    oomKilled: false,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 0,
    imageDigest: null,
    usage: {},
    ...overrides,
  };
}

/** Used for failures that never touch the sandbox at all (currently: `checker_py` on a C++
 * submission). `raw.sandbox` is a zeroed placeholder — there was no sandbox invocation to report. */
function internalErrorResult(message: string, totalTests: number): ExecutionResult {
  return {
    verdict: "internal_error",
    passedTests: 0,
    totalTests,
    runtimeMs: 0,
    memoryKb: null,
    perTest: [],
    failure: { kind: "internal_error", message },
    raw: { sandbox: fakeSandboxResult(), harness: null },
  };
}

export interface ExecuteCppOptions {
  signature: Signature;
  tests: BundleTestCase[];
  comparator: ComparatorSpec;
  source: string;
  limits: SandboxLimits;
  image: string;
  /** Defaults to `defaultCompileLimits(limits)`. */
  compileLimits?: SandboxLimits;
  /** defaults to an even split of the wall timeout across tests, floor 1000ms */
  perTestTimeoutMs?: number;
  /** true only for `run` mode / example-derived tests — CONTRACTS §4.5 */
  revealInputs?: boolean;
  correlationId?: string;
}

export async function executeCpp(opts: ExecuteCppOptions): Promise<ExecutionResult> {
  const { signature, tests, comparator, source, limits, image, revealInputs, correlationId } = opts;
  const totalTests = tests.filter(hasExpectedValue).length;

  // checker_py is Python-only (CONTRACTS §7) — fail fast, before building a bundle or touching
  // the sandbox at all, rather than silently mis-grading (e.g. by quietly falling back to
  // `exact`, which would corrupt the verdict without any indication why).
  if (comparator.kind === "checker_py") {
    return internalErrorResult(
      "This problem's comparator is checker_py, which is Python-only: the C++ harness has no " +
        "way to execute an arbitrary Python checker function, so a C++ submission to this " +
        "problem cannot be graded.",
      totalTests,
    );
  }

  const perTestTimeoutMs =
    opts.perTestTimeoutMs ?? Math.max(1000, Math.floor(limits.wallTimeoutMs / Math.max(tests.length, 1)));
  const compileLimits = opts.compileLimits ?? defaultCompileLimits(limits);

  const bundleFiles = buildCppBundle({
    signature,
    tests,
    comparator,
    solutionSource: source,
    perTestTimeoutMs,
  });

  // --- Step 1: compile.
  const compileResult = await runSandboxed({
    image,
    files: bundleFiles,
    argv: COMPILE_ARGV,
    limits: compileLimits,
    correlationId,
  });

  const compileOk = !compileResult.timedOut && !compileResult.oomKilled && compileResult.exitCode === 0;

  if (!compileOk) {
    const verdict: Verdict = compileResult.timedOut
      ? "time_limit"
      : compileResult.oomKilled
        ? "memory_limit"
        : "compilation_error";
    const message =
      verdict === "time_limit"
        ? "Compilation exceeded the wall-clock time limit."
        : verdict === "memory_limit"
          ? "The compiler was killed for exceeding the memory limit."
          : "Compilation failed.";
    return {
      verdict,
      passedTests: 0,
      totalTests,
      runtimeMs: 0,
      memoryKb: null,
      perTest: [],
      failure: {
        kind: verdict,
        message,
        // g++'s diagnostics reference /bundle/main.cpp and /bundle/solution.cpp by path —
        // path-scrubbed before ever leaving this package, per CONTRACTS §7.
        stderr_tail: tail(scrubPaths(compileResult.stderr)),
      },
      compile: { ok: false, durationMs: compileResult.durationMs, imageDigest: compileResult.imageDigest },
      raw: { sandbox: compileResult, harness: null },
    };
  }

  // --- Step 2: run, in a fresh sandbox invocation with its own (normal, tighter) limits.
  const runFiles: Record<string, string> = {
    "tests.json": bundleFiles["tests.json"]!,
    "comparator.json": bundleFiles["comparator.json"]!,
    "config.json": bundleFiles["config.json"]!,
    "prog.b64": compileResult.stdout.trim(),
  };

  const runResult = await runSandboxed({
    image,
    files: runFiles,
    argv: RUN_ARGV,
    limits,
    correlationId,
  });

  const executionResult = buildExecutionResult({
    sandboxResult: runResult,
    tests,
    revealInputs,
    classifyOpaqueFailure: classifyCppOpaqueFailure,
    // Anything equivalent to Python's "missing function"/"syntax error" would already have failed
    // to *compile*, so by the time the harness itself can report ok:false here, it's a genuine
    // bundle/harness bug — always internal_error, never compilation_error (compilation is already
    // known to have succeeded) or runtime_error (the user's code never got a chance to run).
    classifyHarnessError: () => "internal_error",
  });

  return {
    ...executionResult,
    compile: { ok: true, durationMs: compileResult.durationMs, imageDigest: compileResult.imageDigest },
  };
}
