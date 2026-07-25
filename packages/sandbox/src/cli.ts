/**
 * CLI bridge — CONTRACTS §6.1 (single sandbox implementation rule).
 *
 * NOTE: this file deliberately has NO shebang. tsx 4.23.1 fails to parse a module that combines
 * a shebang with a top-level dynamic `import()` (it throws in `transformDynamicImport`), and the
 * dynamic imports below are load-bearing — see the stdout hijack. Invoke via
 * `node --import tsx packages/sandbox/src/cli.ts <subcommand>`.
 *
 * The Python content plane must execute reference/brute-force/mutant code under EXACTLY the
 * same sandbox as user submissions. Rather than a second implementation of the `docker run`
 * flag list in Python, `content/leetmind_content/sandbox.py` shells out to this CLI.
 *
 * Contract:
 *  - JSON in / JSON out on stdin/stdout ONLY. Every log line goes to stderr, never stdout.
 *  - Exit 0 whenever the execution attempt itself completed, including non-`accepted` verdicts
 *    (wrong_answer, time_limit, ...) — those are data, not CLI failures. Exit non-zero ONLY for
 *    infrastructure failure (image missing, docker unreachable, malformed input), in which case
 *    stdout carries `{"error": {"code", "message"}}` instead of a result.
 *
 * Usage:
 *   node --import tsx packages/sandbox/src/cli.ts exec         < SandboxRequest.json
 *   node --import tsx packages/sandbox/src/cli.ts exec-python  < ExecPythonRequest.json
 *   node --import tsx packages/sandbox/src/cli.ts exec-cpp     < ExecCppRequest.json
 */
import { createLogger } from "@leetmind/shared";
import type { ExecuteCppOptions } from "./cpp/execute.js";
import type { ExecutePythonOptions } from "./execute.js";
import type { SandboxRequest } from "./types.js";

// `createLogger` (pino) defaults to writing straight to raw fd 1 (stdout) via its own SonicBoom
// writer — NOT through `process.stdout.write()`, so simply monkey-patching that method is not
// enough by itself, and it also means the redirect below MUST be installed before any module
// that calls `createLogger(...)` at its own top level (run.ts, execute.ts, images.ts all do)
// is ever evaluated, or that module's pino instance will have already bound itself to the real
// fd 1. That's why `./run.js` / `./execute.js` / `./images.js` are imported dynamically, below,
// AFTER the redirect is in place — a plain static `import` at the top of this file would be
// hoisted and evaluated before this code runs, too late to matter.
//
// This all exists for one reason: CONTRACTS §6.1 requires "JSON in/out on stdin/stdout ONLY,
// all logs to stderr" for this CLI specifically (every other service correctly logs JSON to
// stdout per CONTRACTS §1 — it's only this bridge's dual use of stdout as both a data channel
// and Node's conventional log stream that forces the redirect). @leetmind/shared's
// `createLogger` doesn't expose a way to point pino at an arbitrary stream, so redirecting
// process.stdout.write is the only lever available from inside this package.
const realStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any)(chunk, ...rest)) as typeof process.stdout.write;

const logger = createLogger("sandbox-cli");

const { executePython } = await import("./execute.js");
const { executeCpp } = await import("./cpp/execute.js");
const { ensureImage } = await import("./images.js");
const { runSandboxed } = await import("./run.js");

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The ONLY function in this file allowed to write to real stdout (bypasses the redirect above). */
function writeResult(payload: unknown): void {
  realStdoutWrite(JSON.stringify(payload));
  realStdoutWrite("\n");
}

/**
 * Writes the `{error: {code, message}}` envelope and marks the process for non-zero exit.
 * Uses `process.exitCode` rather than `process.exit()` so the stdout write above is guaranteed
 * to flush before the process actually exits.
 */
function failInfra(code: string, message: string): void {
  logger.error({ code, message }, "sandbox CLI infrastructure failure");
  writeResult({ error: { code, message } });
  process.exitCode = 1;
}

function isSandboxRequest(v: unknown): v is SandboxRequest {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.image === "string" &&
    typeof r.files === "object" &&
    r.files !== null &&
    Array.isArray(r.argv) &&
    typeof r.limits === "object" &&
    r.limits !== null
  );
}

function isExecPythonRequest(v: unknown): v is ExecutePythonOptions {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.signature === "object" &&
    r.signature !== null &&
    Array.isArray(r.tests) &&
    typeof r.comparator === "object" &&
    r.comparator !== null &&
    typeof r.source === "string" &&
    typeof r.limits === "object" &&
    r.limits !== null &&
    typeof r.image === "string"
  );
}

/** Same required-field shape as `isExecPythonRequest` — `ExecuteCppOptions` only adds the
 * optional `compileLimits`, which needs no separate validation here. */
function isExecCppRequest(v: unknown): v is ExecuteCppOptions {
  return isExecPythonRequest(v as never);
}

async function runExec(input: unknown): Promise<void> {
  if (!isSandboxRequest(input)) {
    failInfra(
      "invalid_request",
      "exec expects a SandboxRequest JSON object: {image, files, argv, limits, correlationId?}",
    );
    return;
  }

  try {
    await ensureImage(input.image);
  } catch (err) {
    failInfra("image_missing", err instanceof Error ? err.message : String(err));
    return;
  }

  try {
    const result = await runSandboxed(input);
    writeResult(result);
  } catch (err) {
    failInfra("sandbox_run_failed", err instanceof Error ? err.message : String(err));
  }
}

async function runExecPython(input: unknown): Promise<void> {
  if (!isExecPythonRequest(input)) {
    failInfra(
      "invalid_request",
      "exec-python expects {signature, tests, comparator, source, limits, image, checkerSource?, " +
        "perTestTimeoutMs?, revealInputs?, correlationId?}",
    );
    return;
  }

  try {
    await ensureImage(input.image);
  } catch (err) {
    failInfra("image_missing", err instanceof Error ? err.message : String(err));
    return;
  }

  try {
    const result = await executePython(input);
    writeResult(result);
  } catch (err) {
    failInfra("sandbox_run_failed", err instanceof Error ? err.message : String(err));
  }
}

async function runExecCpp(input: unknown): Promise<void> {
  if (!isExecCppRequest(input)) {
    failInfra(
      "invalid_request",
      "exec-cpp expects {signature, tests, comparator, source, limits, image, compileLimits?, " +
        "perTestTimeoutMs?, revealInputs?, correlationId?}",
    );
    return;
  }

  try {
    await ensureImage(input.image);
  } catch (err) {
    failInfra("image_missing", err instanceof Error ? err.message : String(err));
    return;
  }

  try {
    const result = await executeCpp(input);
    writeResult(result);
  } catch (err) {
    failInfra("sandbox_run_failed", err instanceof Error ? err.message : String(err));
  }
}

export async function main(argv = process.argv): Promise<void> {
  const subcommand = argv[2];

  if (subcommand !== "exec" && subcommand !== "exec-python" && subcommand !== "exec-cpp") {
    failInfra(
      "bad_usage",
      `Unknown subcommand "${subcommand ?? ""}". Expected "exec", "exec-python", or "exec-cpp".`,
    );
    return;
  }

  let raw: string;
  try {
    raw = await readStdin();
  } catch (err) {
    failInfra("stdin_read_failed", `Failed to read stdin: ${String(err)}`);
    return;
  }

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    failInfra(
      "invalid_json",
      `stdin was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (subcommand === "exec") {
    await runExec(input);
  } else if (subcommand === "exec-python") {
    await runExecPython(input);
  } else {
    await runExecCpp(input);
  }
}

// Only auto-run when executed directly (not when imported by a test).
const isMain = process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js");
if (isMain) {
  main().catch((err: unknown) => {
    logger.error({ err: String(err) }, "sandbox CLI crashed");
    writeResult({ error: { code: "internal_error", message: String(err) } });
    process.exitCode = 1;
  });
}
