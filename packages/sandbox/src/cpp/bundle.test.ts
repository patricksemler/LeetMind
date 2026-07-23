import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Signature } from "../types.js";
import { buildCppBundle } from "./bundle.js";
import { generateMainCpp } from "./codegen.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSON_HPP_ON_DISK = readFileSync(path.resolve(__dirname, "../../runners/cpp/json.hpp"), "utf8");

const signature: Signature = {
  name: "twoSum",
  params: [
    { name: "nums", type: "list[int]" },
    { name: "target", type: "int" },
  ],
  returns: "list[int]",
};

describe("buildCppBundle", () => {
  it("produces the CONTRACTS §7 C++ bundle file set", () => {
    const bundle = buildCppBundle({
      signature,
      tests: [{ args: [[2, 7, 11, 15], 9], expected: [0, 1] }],
      comparator: { kind: "exact" },
      solutionSource: "class Solution {\npublic:\n    std::vector<long long> twoSum(...) {}\n};\n",
      perTestTimeoutMs: 5000,
    });

    expect(Object.keys(bundle).sort()).toEqual(
      ["comparator.json", "config.json", "json.hpp", "main.cpp", "signature.json", "solution.cpp", "tests.json"].sort(),
    );
  });

  it("reads json.hpp from disk verbatim rather than duplicating it as a TS string", () => {
    const bundle = buildCppBundle({
      signature,
      tests: [],
      comparator: { kind: "exact" },
      solutionSource: "",
      perTestTimeoutMs: 5000,
    });
    expect(bundle["json.hpp"]).toBe(JSON_HPP_ON_DISK);
    expect(bundle["json.hpp"]).toContain("nlohmann");
  });

  it("main.cpp matches generateMainCpp(signature) exactly", () => {
    const bundle = buildCppBundle({
      signature,
      tests: [],
      comparator: { kind: "exact" },
      solutionSource: "",
      perTestTimeoutMs: 5000,
    });
    expect(bundle["main.cpp"]).toBe(generateMainCpp(signature));
  });

  it("round-trips tests/comparator/signature/config as JSON, and solution.cpp verbatim", () => {
    const tests = [{ args: [[1, 2], 3], expected: [0, 1] }];
    const comparator = { kind: "float_tol" as const, tol: 1e-6 };
    const bundle = buildCppBundle({
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
    expect(bundle["solution.cpp"]).toBe("SOURCE");
  });

  it("a test with no 'expected' key round-trips without one (custom_input, CONTRACTS §4.5)", () => {
    const bundle = buildCppBundle({
      signature,
      tests: [{ args: [[1, 2], 3] }],
      comparator: { kind: "exact" },
      solutionSource: "",
      perTestTimeoutMs: 1000,
    });
    const parsedTests = JSON.parse(bundle["tests.json"] as string) as Record<string, unknown>[];
    expect(parsedTests).toHaveLength(1);
    expect("expected" in parsedTests[0]!).toBe(false);
  });

  it("never writes a checker.py-equivalent file (checker_py is Python-only)", () => {
    const bundle = buildCppBundle({
      signature,
      tests: [],
      comparator: { kind: "checker_py" },
      solutionSource: "",
      checkerSource: "def check(args, output, expected):\n    return True\n",
      perTestTimeoutMs: 5000,
    });
    expect(Object.keys(bundle)).not.toContain("checker.py");
    expect(Object.keys(bundle)).not.toContain("checker.cpp");
  });
});
