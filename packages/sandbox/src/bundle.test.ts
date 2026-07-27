import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPythonBundle } from "./bundle.js";
import type { Signature } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PY_ON_DISK = readFileSync(
  path.resolve(__dirname, "../runners/python/runner.py"),
  "utf8",
);

const signature: Signature = {
  name: "twoSum",
  params: [
    { name: "nums", type: "list[int]" },
    { name: "target", type: "int" },
  ],
  returns: "list[int]",
};

describe("buildPythonBundle", () => {
  it("produces the CONTRACTS §7 file set", () => {
    const bundle = buildPythonBundle({
      signature,
      tests: [{ args: [[2, 7, 11, 15], 9], expected: [0, 1] }],
      comparator: { kind: "exact" },
      solutionSource: "def twoSum(nums, target):\n    return []\n",
      perTestTimeoutMs: 5000,
    });

    expect(Object.keys(bundle).sort()).toEqual(
      [
        "comparator.json",
        "config.json",
        "runner.py",
        "signature.json",
        "solution.py",
        "tests.json",
      ].sort(),
    );
  });

  it("includes checker.py only when checkerSource is provided", () => {
    const withoutChecker = buildPythonBundle({
      signature,
      tests: [],
      comparator: { kind: "exact" },
      solutionSource: "def twoSum(nums, target):\n    return []\n",
      perTestTimeoutMs: 5000,
    });
    expect(withoutChecker["checker.py"]).toBeUndefined();

    const withChecker = buildPythonBundle({
      signature,
      tests: [],
      comparator: { kind: "checker_py" },
      solutionSource: "def twoSum(nums, target):\n    return []\n",
      checkerSource: "def check(args, output, expected):\n    return True\n",
      perTestTimeoutMs: 5000,
    });
    expect(withChecker["checker.py"]).toBe("def check(args, output, expected):\n    return True\n");
  });

  it("reads runner.py from disk verbatim rather than duplicating it as a TS string", () => {
    const bundle = buildPythonBundle({
      signature,
      tests: [],
      comparator: { kind: "exact" },
      solutionSource: "",
      perTestTimeoutMs: 5000,
    });
    expect(bundle["runner.py"]).toBe(RUNNER_PY_ON_DISK);
    expect(bundle["runner.py"]).toContain("<<<LEETMIND_RESULT>>>");
  });

  it("round-trips signature/tests/comparator/config as JSON", () => {
    const tests = [{ args: [[1, 2], 3], expected: [0, 1] }];
    const comparator = { kind: "float_tol" as const, tol: 1e-6 };
    const bundle = buildPythonBundle({
      signature,
      tests,
      comparator,
      solutionSource: "SOURCE",
      perTestTimeoutMs: 4321,
    });

    expect(JSON.parse(bundle["signature.json"] as string)).toEqual(signature);
    expect(JSON.parse(bundle["tests.json"] as string)).toEqual(tests);
    expect(JSON.parse(bundle["comparator.json"] as string)).toEqual(comparator);
    expect(JSON.parse(bundle["config.json"] as string)).toEqual({ per_test_timeout_ms: 4321 });
    expect(bundle["solution.py"]).toBe("SOURCE");
  });
});
