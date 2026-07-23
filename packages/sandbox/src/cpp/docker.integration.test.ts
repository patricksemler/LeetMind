import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { SandboxLimits, Signature } from "../types.js";
import { executeCpp } from "./execute.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const IMAGE = process.env.SANDBOX_CPP_IMAGE ?? "algolift/runner-cpp:1";

function isDockerUp(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasImage(image: string): boolean {
  try {
    execSync(`docker image inspect ${image}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dockerUp = isDockerUp();

describe.skipIf(!dockerUp)("C++ sandbox docker integration", () => {
  beforeAll(() => {
    if (!hasImage(IMAGE)) {
      execSync(`bash ${path.join(REPO_ROOT, "scripts/build-images.sh")}`, { stdio: "inherit" });
    }
  }, 180_000);

  const baseLimits: SandboxLimits = {
    memoryMb: 256,
    cpus: 1,
    pidsLimit: 64,
    wallTimeoutMs: 8000,
    outputLimitBytes: 65536,
  };

  const twoSum: Signature = {
    name: "twoSum",
    params: [
      { name: "nums", type: "list[int]" },
      { name: "target", type: "int" },
    ],
    returns: "list[int]",
  };
  const twoSumTests = [
    { args: [[2, 7, 11, 15], 9], expected: [0, 1] },
    { args: [[3, 3], 6], expected: [0, 1] },
  ];
  const correctTwoSum =
    "class Solution {\npublic:\n" +
    "    std::vector<long long> twoSum(std::vector<long long> nums, long long target) {\n" +
    "        std::unordered_map<long long, long long> seen;\n" +
    "        for (long long i = 0; i < (long long)nums.size(); i++) {\n" +
    "            long long need = target - nums[i];\n" +
    "            if (seen.count(need)) return {seen[need], i};\n" +
    "            seen[nums[i]] = i;\n" +
    "        }\n        return {};\n    }\n};\n";

  it("a correct C++ solution passes (accepted)", async () => {
    const result = await executeCpp({
      signature: twoSum,
      tests: twoSumTests,
      comparator: { kind: "exact" },
      source: correctTwoSum,
      limits: baseLimits,
      image: IMAGE,
    });

    expect(result.verdict).toBe("accepted");
    expect(result.passedTests).toBe(2);
    expect(result.totalTests).toBe(2);
    expect(result.compile?.ok).toBe(true);
    expect(result.raw.sandbox.imageDigest).toBeTruthy();
  }, 60_000);

  it("a wrong C++ solution is wrong_answer", async () => {
    const wrong =
      "class Solution {\npublic:\n" +
      "    std::vector<long long> twoSum(std::vector<long long> nums, long long target) {\n" +
      "        return {0, 0};\n    }\n};\n";
    const result = await executeCpp({
      signature: twoSum,
      tests: twoSumTests,
      comparator: { kind: "exact" },
      source: wrong,
      limits: baseLimits,
      image: IMAGE,
    });
    expect(result.verdict).toBe("wrong_answer");
    expect(result.compile?.ok).toBe(true);
  }, 60_000);

  it("a syntax error is compilation_error with readable, path-scrubbed g++ output", async () => {
    const broken =
      "class Solution {\npublic:\n" +
      "    std::vector<long long> twoSum(std::vector<long long> nums, long long target) {\n" +
      "        return this_identifier_does_not_exist;\n    }\n};\n";
    const result = await executeCpp({
      signature: twoSum,
      tests: twoSumTests,
      comparator: { kind: "exact" },
      source: broken,
      limits: baseLimits,
      image: IMAGE,
    });
    expect(result.verdict).toBe("compilation_error");
    expect(result.compile?.ok).toBe(false);
    expect(result.failure?.stderr_tail).toBeTruthy();
    expect(result.failure?.stderr_tail).toContain("this_identifier_does_not_exist");
    // path-scrubbed: no /bundle/ or /work/ prefix anywhere in the surfaced diagnostics
    expect(result.failure?.stderr_tail).not.toContain("/bundle/");
    expect(result.failure?.stderr_tail).not.toContain("/work/");
  }, 60_000);

  it("an infinite loop hits the per-test wall timeout", async () => {
    const spin: Signature = { name: "spin", params: [{ name: "n", type: "int" }], returns: "int" };
    const source = "class Solution {\npublic:\n    long long spin(long long n) { while (true) {} }\n};\n";
    const result = await executeCpp({
      signature: spin,
      tests: [{ args: [1], expected: 1 }],
      comparator: { kind: "exact" },
      source,
      limits: { ...baseLimits, wallTimeoutMs: 6000 },
      perTestTimeoutMs: 1500,
      image: IMAGE,
    });
    expect(result.verdict).toBe("time_limit");
  }, 60_000);

  it("a memory hog is constrained by the run step's --memory limit", async () => {
    const hog: Signature = { name: "hog", params: [{ name: "n", type: "int" }], returns: "int" };
    const source =
      "class Solution {\npublic:\n" +
      "    long long hog(long long n) {\n" +
      "        std::vector<char> v(500L * 1024 * 1024, 1);\n" +
      "        long long sum = 0;\n        for (char c : v) sum += c;\n        return sum;\n    }\n};\n";
    const result = await executeCpp({
      signature: hog,
      tests: [{ args: [1], expected: 1 }],
      comparator: { kind: "exact" },
      source,
      limits: { ...baseLimits, memoryMb: 64, wallTimeoutMs: 8000 },
      image: IMAGE,
    });
    // Either the container gets OOM-killed (memory_limit) or the allocation throws bad_alloc and
    // the harness reports it as a per-test runtime error — either is an acceptable, non-accepted
    // outcome demonstrating the memory limit was enforced (not silently ignored).
    expect(result.verdict).not.toBe("accepted");
    expect(["memory_limit", "runtime_error"]).toContain(result.verdict);
  }, 60_000);

  it("TreeNode round-trips correctly through decode/encode", async () => {
    const sig: Signature = { name: "identity", params: [{ name: "root", type: "TreeNode?" }], returns: "TreeNode?" };
    const source = "class Solution {\npublic:\n    TreeNode* identity(TreeNode* root) { return root; }\n};\n";
    const result = await executeCpp({
      signature: sig,
      tests: [
        { args: [[1, 2, 3, null, null, 4, 5]], expected: [1, 2, 3, null, null, 4, 5] },
        { args: [[]], expected: [] },
        { args: [[1]], expected: [1] },
      ],
      comparator: { kind: "exact" },
      source,
      limits: baseLimits,
      image: IMAGE,
    });
    expect(result.verdict).toBe("accepted");
    expect(result.passedTests).toBe(3);
  }, 60_000);

  it("ListNode round-trips correctly through decode/encode", async () => {
    const sig: Signature = { name: "identity", params: [{ name: "head", type: "ListNode?" }], returns: "ListNode?" };
    const source = "class Solution {\npublic:\n    ListNode* identity(ListNode* head) { return head; }\n};\n";
    const result = await executeCpp({
      signature: sig,
      tests: [
        { args: [[1, 2, 3]], expected: [1, 2, 3] },
        { args: [[]], expected: [] },
      ],
      comparator: { kind: "exact" },
      source,
      limits: baseLimits,
      image: IMAGE,
    });
    expect(result.verdict).toBe("accepted");
    expect(result.passedTests).toBe(2);
  }, 60_000);

  it("unordered comparator behaves the same as Python's: any permutation passes", async () => {
    const sig: Signature = { name: "groups", params: [{ name: "n", type: "int" }], returns: "list[list[int]]" };
    const source =
      "class Solution {\npublic:\n" +
      "    std::vector<std::vector<long long>> groups(long long n) { return {{4,3},{2,1}}; }\n};\n";
    const result = await executeCpp({
      signature: sig,
      tests: [{ args: [0], expected: [[1, 2], [3, 4]] }],
      comparator: { kind: "unordered" },
      source,
      limits: baseLimits,
      image: IMAGE,
    });
    expect(result.verdict).toBe("accepted");
  }, 60_000);

  it("float_tol comparator accepts a small delta and rejects a large one, matching Python's tolerance", async () => {
    const sig: Signature = { name: "approx", params: [{ name: "x", type: "float" }], returns: "float" };
    const source = "class Solution {\npublic:\n    double approx(double x) { return x; }\n};\n";
    const passing = await executeCpp({
      signature: sig,
      tests: [{ args: [1.0], expected: 1.0000001 }],
      comparator: { kind: "float_tol", tol: 1e-4 },
      source,
      limits: baseLimits,
      image: IMAGE,
    });
    expect(passing.verdict).toBe("accepted");

    const failing = await executeCpp({
      signature: sig,
      tests: [{ args: [1.0], expected: 2.0 }],
      comparator: { kind: "float_tol", tol: 1e-4 },
      source,
      limits: baseLimits,
      image: IMAGE,
    });
    expect(failing.verdict).toBe("wrong_answer");
  }, 60_000);

  it("a run against custom_input (no expected value) reports accepted with 0/0 graded tests", async () => {
    const sig: Signature = {
      name: "add",
      params: [
        { name: "a", type: "int" },
        { name: "b", type: "int" },
      ],
      returns: "int",
    };
    const source = "class Solution {\npublic:\n    long long add(long long a, long long b) { return a + b; }\n};\n";
    const result = await executeCpp({
      signature: sig,
      tests: [{ args: [2, 3] }], // no `expected` key
      comparator: { kind: "exact" },
      source,
      limits: baseLimits,
      image: IMAGE,
      revealInputs: true,
    });
    expect(result.verdict).toBe("accepted");
    expect(result.passedTests).toBe(0);
    expect(result.totalTests).toBe(0);
  }, 60_000);

  it("checker_py comparator fails fast with internal_error, never touching the sandbox", async () => {
    const sig: Signature = { name: "identity", params: [{ name: "n", type: "int" }], returns: "int" };
    const result = await executeCpp({
      signature: sig,
      tests: [{ args: [1], expected: 1 }],
      comparator: { kind: "checker_py" },
      source: "class Solution {\npublic:\n    long long identity(long long n) { return n; }\n};\n",
      limits: baseLimits,
      image: IMAGE,
    });
    expect(result.verdict).toBe("internal_error");
    expect(result.failure?.message).toMatch(/checker_py/i);
    expect(result.raw.sandbox.imageDigest).toBeNull();
    expect(result.compile).toBeUndefined();
  }, 10_000);
});
