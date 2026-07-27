/**
 * Cross-language parity — the M4 "done when" criterion (PLAN.md §10 M4: "the same problem passes
 * in Python and C++"). Table-driven over several signatures (scalars, nested lists, strings,
 * floats via `float_tol`, `unordered`, and a tree problem), each with a CORRECT and a WRONG
 * solution written independently in both languages. For every row, both languages must:
 *
 *   1. produce the SAME verdict against the SAME hidden test suite, for both the correct and the
 *      wrong solution (i.e. Python's verdict === C++'s verdict, not just "both non-crashing")
 *   2. match the row's own expected verdict (accepted / wrong_answer), so a bug that made both
 *      harnesses agree on the WRONG answer would still be caught
 *
 * Timings are collected and printed as a table at the end (`console.info`) so a run of this file
 * doubles as the parity report requested for M4.
 */
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeCpp } from "./cpp/execute.js";
import { executePython } from "./execute.js";
import type { BundleTestCase, ComparatorSpec, SandboxLimits, Signature, Verdict } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const PY_IMAGE = process.env.SANDBOX_PYTHON_IMAGE ?? "leetmind/runner-python:1";
const CPP_IMAGE = process.env.SANDBOX_CPP_IMAGE ?? "leetmind/runner-cpp:1";

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

const baseLimits: SandboxLimits = {
  memoryMb: 256,
  cpus: 1,
  pidsLimit: 64,
  wallTimeoutMs: 8000,
  outputLimitBytes: 65536,
};

interface ParityCase {
  name: string;
  signature: Signature;
  tests: BundleTestCase[];
  comparator: ComparatorSpec;
  pythonCorrect: string;
  cppCorrect: string;
  pythonWrong: string;
  cppWrong: string;
  expectedCorrectVerdict: Verdict;
  expectedWrongVerdict: Verdict;
}

const CASES: ParityCase[] = [
  {
    name: "two_sum (list[int], int -> list[int], exact)",
    signature: {
      name: "twoSum",
      params: [
        { name: "nums", type: "list[int]" },
        { name: "target", type: "int" },
      ],
      returns: "list[int]",
    },
    tests: [
      { args: [[2, 7, 11, 15], 9], expected: [0, 1] },
      { args: [[3, 2, 4], 6], expected: [1, 2] },
      { args: [[3, 3], 6], expected: [0, 1] },
    ],
    comparator: { kind: "exact" },
    pythonCorrect:
      "def twoSum(nums, target):\n    seen = {}\n    for i, x in enumerate(nums):\n        if target - x in seen:\n            return [seen[target - x], i]\n        seen[x] = i\n    return []\n",
    cppCorrect:
      "class Solution {\npublic:\n" +
      "    std::vector<long long> twoSum(std::vector<long long> nums, long long target) {\n" +
      "        std::unordered_map<long long, long long> seen;\n" +
      "        for (long long i = 0; i < (long long)nums.size(); i++) {\n" +
      "            long long need = target - nums[i];\n" +
      "            if (seen.count(need)) return {seen[need], i};\n" +
      "            seen[nums[i]] = i;\n" +
      "        }\n        return {};\n    }\n};\n",
    pythonWrong: "def twoSum(nums, target):\n    return [0, 0]\n",
    cppWrong:
      "class Solution {\npublic:\n" +
      "    std::vector<long long> twoSum(std::vector<long long> nums, long long target) {\n" +
      "        return {0, 0};\n    }\n};\n",
    expectedCorrectVerdict: "accepted",
    expectedWrongVerdict: "wrong_answer",
  },
  {
    name: "nested list[list[int]] (unordered comparator)",
    signature: {
      name: "pairSums",
      params: [{ name: "nums", type: "list[int]" }],
      returns: "list[list[int]]",
    },
    tests: [
      {
        args: [[1, 2, 3, 4]],
        expected: [
          [1, 2],
          [3, 4],
        ],
      },
    ],
    comparator: { kind: "unordered" },
    pythonCorrect:
      "def pairSums(nums):\n    return [[nums[i], nums[i+1]] for i in range(0, len(nums), 2)]\n",
    cppCorrect:
      "class Solution {\npublic:\n" +
      "    std::vector<std::vector<long long>> pairSums(std::vector<long long> nums) {\n" +
      "        std::vector<std::vector<long long>> out;\n" +
      "        for (size_t i = 0; i + 1 < nums.size(); i += 2) out.push_back({nums[i], nums[i+1]});\n" +
      "        return out;\n    }\n};\n",
    pythonWrong: "def pairSums(nums):\n    return [[9, 9], [9, 9]]\n",
    cppWrong:
      "class Solution {\npublic:\n" +
      "    std::vector<std::vector<long long>> pairSums(std::vector<long long> nums) {\n" +
      "        return {{9, 9}, {9, 9}};\n    }\n};\n",
    expectedCorrectVerdict: "accepted",
    expectedWrongVerdict: "wrong_answer",
  },
  {
    name: "string manipulation (str -> str, exact)",
    signature: { name: "reverseString", params: [{ name: "s", type: "str" }], returns: "str" },
    tests: [
      { args: ["hello"], expected: "olleh" },
      { args: [""], expected: "" },
      { args: ["a"], expected: "a" },
    ],
    comparator: { kind: "exact" },
    pythonCorrect: "def reverseString(s):\n    return s[::-1]\n",
    cppCorrect:
      "class Solution {\npublic:\n" +
      "    std::string reverseString(std::string s) {\n        std::reverse(s.begin(), s.end());\n        return s;\n    }\n};\n",
    pythonWrong: "def reverseString(s):\n    return s\n",
    cppWrong:
      "class Solution {\npublic:\n    std::string reverseString(std::string s) { return s; }\n};\n",
    expectedCorrectVerdict: "accepted",
    expectedWrongVerdict: "wrong_answer",
  },
  {
    name: "float_tol (float -> float)",
    signature: {
      name: "average",
      params: [
        { name: "a", type: "float" },
        { name: "b", type: "float" },
      ],
      returns: "float",
    },
    tests: [
      { args: [1.0, 3.0], expected: 2.0 },
      { args: [0.1, 0.2], expected: 0.15000005 },
    ],
    comparator: { kind: "float_tol", tol: 1e-4 },
    pythonCorrect: "def average(a, b):\n    return (a + b) / 2\n",
    cppCorrect:
      "class Solution {\npublic:\n    double average(double a, double b) { return (a + b) / 2.0; }\n};\n",
    pythonWrong: "def average(a, b):\n    return a + b\n",
    cppWrong:
      "class Solution {\npublic:\n    double average(double a, double b) { return a + b; }\n};\n",
    expectedCorrectVerdict: "accepted",
    expectedWrongVerdict: "wrong_answer",
  },
  {
    name: "tree problem: invertTree (TreeNode? -> TreeNode?)",
    signature: {
      name: "invertTree",
      params: [{ name: "root", type: "TreeNode?" }],
      returns: "TreeNode?",
    },
    tests: [
      { args: [[4, 2, 7, 1, 3, 6, 9]], expected: [4, 7, 2, 9, 6, 3, 1] },
      { args: [[]], expected: [] },
      { args: [[1]], expected: [1] },
    ],
    comparator: { kind: "exact" },
    pythonCorrect:
      "def invertTree(root):\n    if root is None:\n        return None\n    root.left, root.right = invertTree(root.right), invertTree(root.left)\n    return root\n",
    cppCorrect:
      "class Solution {\npublic:\n" +
      "    TreeNode* invertTree(TreeNode* root) {\n" +
      "        if (root == nullptr) return nullptr;\n" +
      "        TreeNode* l = invertTree(root->left);\n        TreeNode* r = invertTree(root->right);\n" +
      "        root->left = r; root->right = l;\n        return root;\n    }\n};\n",
    pythonWrong: "def invertTree(root):\n    return root\n",
    cppWrong:
      "class Solution {\npublic:\n    TreeNode* invertTree(TreeNode* root) { return root; }\n};\n",
    expectedCorrectVerdict: "accepted",
    expectedWrongVerdict: "wrong_answer",
  },
  {
    name: "linked list problem: reverseList (ListNode? -> ListNode?)",
    signature: {
      name: "reverseList",
      params: [{ name: "head", type: "ListNode?" }],
      returns: "ListNode?",
    },
    tests: [
      { args: [[1, 2, 3, 4, 5]], expected: [5, 4, 3, 2, 1] },
      { args: [[]], expected: [] },
      { args: [[1]], expected: [1] },
    ],
    comparator: { kind: "exact" },
    pythonCorrect:
      "def reverseList(head):\n    prev = None\n    cur = head\n    while cur:\n        nxt = cur.next\n        cur.next = prev\n        prev = cur\n        cur = nxt\n    return prev\n",
    cppCorrect:
      "class Solution {\npublic:\n" +
      "    ListNode* reverseList(ListNode* head) {\n" +
      "        ListNode* prev = nullptr;\n        ListNode* cur = head;\n" +
      "        while (cur != nullptr) {\n            ListNode* nxt = cur->next;\n            cur->next = prev;\n            prev = cur;\n            cur = nxt;\n        }\n        return prev;\n    }\n};\n",
    pythonWrong: "def reverseList(head):\n    return head\n",
    cppWrong:
      "class Solution {\npublic:\n    ListNode* reverseList(ListNode* head) { return head; }\n};\n",
    expectedCorrectVerdict: "accepted",
    expectedWrongVerdict: "wrong_answer",
  },
];

interface ParityRowResult {
  caseName: string;
  variant: "correct" | "wrong";
  pythonVerdict: Verdict;
  cppVerdict: Verdict;
  pythonMs: number;
  cppMs: number;
}

const report: ParityRowResult[] = [];

const canRun = dockerUp;

describe.skipIf(!canRun)("cross-language parity — Python vs C++ (M4 headline deliverable)", () => {
  beforeAll(() => {
    if (!hasImage(PY_IMAGE) || !hasImage(CPP_IMAGE)) {
      execSync(`bash ${path.join(REPO_ROOT, "scripts/build-images.sh")}`, { stdio: "inherit" });
    }
  }, 180_000);

  afterAll(() => {
    const lines = [
      "",
      "=== Cross-language parity report (Python vs C++) ===",
      "case | variant | python verdict | cpp verdict | python ms | cpp ms | match",
    ];
    for (const row of report) {
      const match = row.pythonVerdict === row.cppVerdict ? "OK" : "MISMATCH";
      lines.push(
        `${row.caseName} | ${row.variant} | ${row.pythonVerdict} | ${row.cppVerdict} | ` +
          `${row.pythonMs.toFixed(1)} | ${row.cppMs.toFixed(1)} | ${match}`,
      );
    }

    console.info(lines.join("\n"));
  });

  for (const c of CASES) {
    it(`${c.name}: correct solution -> ${c.expectedCorrectVerdict} in both languages`, async () => {
      const [py, cpp] = await Promise.all([
        executePython({
          signature: c.signature,
          tests: c.tests,
          comparator: c.comparator,
          source: c.pythonCorrect,
          limits: baseLimits,
          image: PY_IMAGE,
        }),
        executeCpp({
          signature: c.signature,
          tests: c.tests,
          comparator: c.comparator,
          source: c.cppCorrect,
          limits: baseLimits,
          image: CPP_IMAGE,
        }),
      ]);

      report.push({
        caseName: c.name,
        variant: "correct",
        pythonVerdict: py.verdict,
        cppVerdict: cpp.verdict,
        pythonMs: py.runtimeMs,
        cppMs: cpp.runtimeMs,
      });

      expect(py.verdict).toBe(c.expectedCorrectVerdict);
      expect(cpp.verdict).toBe(c.expectedCorrectVerdict);
      expect(py.verdict).toBe(cpp.verdict);
      expect(py.passedTests).toBe(c.tests.length);
      expect(cpp.passedTests).toBe(c.tests.length);
    }, 60_000);

    it(`${c.name}: wrong solution -> ${c.expectedWrongVerdict} in both languages`, async () => {
      const [py, cpp] = await Promise.all([
        executePython({
          signature: c.signature,
          tests: c.tests,
          comparator: c.comparator,
          source: c.pythonWrong,
          limits: baseLimits,
          image: PY_IMAGE,
        }),
        executeCpp({
          signature: c.signature,
          tests: c.tests,
          comparator: c.comparator,
          source: c.cppWrong,
          limits: baseLimits,
          image: CPP_IMAGE,
        }),
      ]);

      report.push({
        caseName: c.name,
        variant: "wrong",
        pythonVerdict: py.verdict,
        cppVerdict: cpp.verdict,
        pythonMs: py.runtimeMs,
        cppMs: cpp.runtimeMs,
      });

      expect(py.verdict).toBe(c.expectedWrongVerdict);
      expect(cpp.verdict).toBe(c.expectedWrongVerdict);
      expect(py.verdict).toBe(cpp.verdict);
    }, 60_000);
  }
});
