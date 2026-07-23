/**
 * Python bundle construction — CONTRACTS §7.
 *
 * Builds the `Record<path, contents>` map that `runSandboxed` materializes into the bundle
 * directory mounted at /bundle inside the container. `runner.py` is read from disk (never
 * duplicated as a TS string) so there is exactly one copy of the harness source, byte-for-byte
 * identical to what a developer can run locally with `python3 runner.py --bundle ./somedir`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { BundleSpec } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This file lives at packages/sandbox/src/bundle.ts (dev, via tsx) or
// packages/sandbox/dist/bundle.js (built). Either way, runners/ is a sibling of src/ and dist/
// directly under packages/sandbox, so `../runners/...` resolves correctly from both locations.
const RUNNER_PY_PATH = path.resolve(__dirname, "../runners/python/runner.py");

let cachedRunnerSource: string | null = null;

function loadRunnerSource(): string {
  if (cachedRunnerSource === null) {
    cachedRunnerSource = readFileSync(RUNNER_PY_PATH, "utf8");
  }
  return cachedRunnerSource;
}

export function buildPythonBundle(spec: BundleSpec): Record<string, string> {
  const { signature, tests, comparator, solutionSource, checkerSource, perTestTimeoutMs } = spec;

  const bundle: Record<string, string> = {
    "runner.py": loadRunnerSource(),
    "signature.json": JSON.stringify(signature),
    "tests.json": JSON.stringify(tests),
    "comparator.json": JSON.stringify(comparator),
    "solution.py": solutionSource,
    "config.json": JSON.stringify({ per_test_timeout_ms: perTestTimeoutMs }),
  };

  if (checkerSource !== undefined) {
    bundle["checker.py"] = checkerSource;
  }

  return bundle;
}
