/**
 * C++ bundle construction — CONTRACTS §7's "C++ bundle (M4)" section.
 *
 * Mirrors `../bundle.ts`'s `buildPythonBundle` shape/conventions exactly (same `BundleSpec` input,
 * same "read static assets from disk, never duplicate them as TS strings" discipline for the
 * vendored `json.hpp`), producing the file set:
 *
 *   /bundle/main.cpp        # generated from `signature` by ./codegen.ts
 *   /bundle/solution.cpp    # the user's (or reference/mutant) code — must define class Solution
 *   /bundle/tests.json      # [{args, expected?}] — expected OMITTED for a custom_input test
 *   /bundle/comparator.json # {kind, tol?}
 *   /bundle/signature.json  # Signature (not read by main.cpp itself — types are baked in at
 *                           # codegen time — but bundled anyway for parity/debuggability with the
 *                           # Python bundle, CONTRACTS §7)
 *   /bundle/json.hpp        # vendored nlohmann/json single-header (MIT), packages/sandbox/runners/cpp/json.hpp
 *   /bundle/config.json     # {per_test_timeout_ms}
 *
 * `checker_py` is Python-only (CONTRACTS §7 / PLAN §12 risk 3's note that C++ parity is scoped to
 * the shared type system, not to arbitrary Python checker functions) — `spec.checkerSource` is
 * accepted for shape-compatibility with `BundleSpec` but never written into the bundle; callers
 * must reject a `checker_py` comparator BEFORE calling this (see `../cpp/execute.ts`'s
 * `executeCpp`, which does so before ever building a bundle).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { BundleSpec } from "../types.js";
import { generateMainCpp } from "./codegen.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This file lives at packages/sandbox/src/cpp/bundle.ts (dev, via tsx) or
// packages/sandbox/dist/cpp/bundle.js (built). Either way, runners/ is a sibling of src/ (or
// dist/) directly under packages/sandbox, two levels up from here.
const JSON_HPP_PATH = path.resolve(__dirname, "../../runners/cpp/json.hpp");

let cachedJsonHppSource: string | null = null;

function loadJsonHppSource(): string {
  if (cachedJsonHppSource === null) {
    cachedJsonHppSource = readFileSync(JSON_HPP_PATH, "utf8");
  }
  return cachedJsonHppSource;
}

export function buildCppBundle(spec: BundleSpec): Record<string, string> {
  const { signature, tests, comparator, solutionSource, perTestTimeoutMs } = spec;

  return {
    "main.cpp": generateMainCpp(signature),
    "solution.cpp": solutionSource,
    "tests.json": JSON.stringify(tests),
    "comparator.json": JSON.stringify(comparator),
    "signature.json": JSON.stringify(signature),
    "json.hpp": loadJsonHppSource(),
    "config.json": JSON.stringify({ per_test_timeout_ms: perTestTimeoutMs }),
  };
}
