import { describe, expect, it } from "vitest";
import {
  type ProblemVersion,
  ProblemVersionSchema,
  starterCodeFor,
  toPublicProblem,
} from "./problem.js";

function makeProblemVersion(overrides: Partial<ProblemVersion> = {}): ProblemVersion {
  const base: ProblemVersion = {
    problem_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    version: 1,
    title: "Max Window Sum",
    internal_name: "max-window-sum",
    statement_md: "Given an array...",
    constraints_md: "1 <= n <= 1e5",
    signature: {
      name: "maxWindowSum",
      params: [
        { name: "nums", type: "list[int]" },
        { name: "k", type: "int" },
      ],
      returns: "int",
    },
    examples: [{ args: [[1, 2, 3], 2], expected: 5, explanation: "window [2,3]" }],
    concepts: [
      { id: "sliding_window", role: "primary", weight: 0.7 },
      { id: "arrays_hashing", role: "secondary", weight: 0.3 },
    ],
    difficulty: { rating: 1420, confidence: "generated" },
    expected_active_minutes: [10, 25],
    target_complexity: { time: "O(n)", space: "O(1)" },
    reference_solution_py: "def maxWindowSum(nums, k):\n    return SECRET_REFERENCE_IMPL",
    brute_force_py: "def maxWindowSum(nums, k):\n    return SECRET_BRUTE_FORCE_IMPL",
    input_generator_py: "def gen(seed):\n    return SECRET_GENERATOR_IMPL",
    comparator: "exact",
    checker_py: "def check(args, expected, actual):\n    return SECRET_CHECKER_IMPL",
    hidden_tests: [{ args: [[9, 9, 9], 1], expected: 9, origin: "boundary", seed: 42 }],
    mutants_py: ["def maxWindowSum(nums, k):\n    return SECRET_MUTANT_IMPL"],
    hints: {
      l1_orientation: "SECRET_HINT_L1",
      l2_conceptual: "SECRET_HINT_L2",
      l3_structural: "SECRET_HINT_L3",
      outline: "SECRET_HINT_OUTLINE",
      editorial_md: "SECRET_EDITORIAL",
    },
    provenance: {
      mode: "novel",
      model: "claude-x",
      prompt_version: "v1",
      generated_at: new Date().toISOString(),
    },
    state: "approved",
  };
  return { ...base, ...overrides };
}

describe("ProblemVersionSchema", () => {
  it("parses a well-formed ProblemVersion", () => {
    expect(() => ProblemVersionSchema.parse(makeProblemVersion())).not.toThrow();
  });

  // Mirrors content/leetmind_content/models.py's ProblemVersion model_validators — previously
  // enforced ONLY on the Python side, so a row violating either invariant would be silently
  // accepted (and trusted) by every TS consumer once it reached the database (QA-PLAN.md §4).
  it("rejects concept weights that don't sum to ~1.0", () => {
    const bad = makeProblemVersion({
      concepts: [
        { id: "sliding_window", role: "primary", weight: 0.5 },
        { id: "arrays_hashing", role: "secondary", weight: 0.2 },
      ],
    });
    expect(() => ProblemVersionSchema.parse(bad)).toThrow(/sum to ~1\.0/);
  });

  it("accepts a weight sum within the ±0.01 tolerance", () => {
    const withinTolerance = makeProblemVersion({
      concepts: [
        { id: "sliding_window", role: "primary", weight: 0.705 },
        { id: "arrays_hashing", role: "secondary", weight: 0.3 },
      ],
    });
    expect(() => ProblemVersionSchema.parse(withinTolerance)).not.toThrow();
  });

  it("rejects zero primary concepts", () => {
    const bad = makeProblemVersion({
      concepts: [{ id: "sliding_window", role: "secondary", weight: 1 }],
    });
    expect(() => ProblemVersionSchema.parse(bad)).toThrow(
      /exactly one concept must have role='primary'/,
    );
  });

  it("rejects more than one primary concept", () => {
    const bad = makeProblemVersion({
      concepts: [
        { id: "sliding_window", role: "primary", weight: 0.5 },
        { id: "arrays_hashing", role: "primary", weight: 0.5 },
      ],
    });
    expect(() => ProblemVersionSchema.parse(bad)).toThrow(
      /exactly one concept must have role='primary'/,
    );
  });
});

describe("toPublicProblem", () => {
  it("never leaks server-only fields", () => {
    const content = makeProblemVersion();
    const pub = toPublicProblem({
      problemVersionId: "pv_01",
      content,
      hintsTaken: [],
      revealConcepts: false,
    });

    // No forbidden top-level keys.
    const forbiddenKeys = [
      "hidden_tests",
      "mutants_py",
      "reference_solution_py",
      "brute_force_py",
      "input_generator_py",
      "checker_py",
      "hints",
      "internal_name",
      "provenance",
    ];
    for (const key of forbiddenKeys) {
      expect(Object.prototype.hasOwnProperty.call(pub, key), `leaked key "${key}"`).toBe(false);
    }

    // Belt-and-suspenders: none of the known secret marker strings appear anywhere in the
    // serialized output, however deeply nested.
    const serialized = JSON.stringify(pub);
    const secretMarkers = [
      "SECRET_REFERENCE_IMPL",
      "SECRET_BRUTE_FORCE_IMPL",
      "SECRET_GENERATOR_IMPL",
      "SECRET_CHECKER_IMPL",
      "SECRET_MUTANT_IMPL",
      "SECRET_HINT_L1",
      "SECRET_HINT_L2",
      "SECRET_HINT_L3",
      "SECRET_HINT_OUTLINE",
      "SECRET_EDITORIAL",
    ];
    for (const marker of secretMarkers) {
      expect(serialized.includes(marker), `serialized output leaked "${marker}"`).toBe(false);
    }
  });

  it("keeps concepts_revealed null when revealConcepts is false", () => {
    const pub = toPublicProblem({
      problemVersionId: "pv_01",
      content: makeProblemVersion(),
      hintsTaken: [],
      revealConcepts: false,
    });
    expect(pub.concepts_revealed).toBeNull();
  });

  it("reveals concepts when revealConcepts is true", () => {
    const content = makeProblemVersion();
    const pub = toPublicProblem({
      problemVersionId: "pv_01",
      content,
      hintsTaken: [],
      revealConcepts: true,
    });
    expect(pub.concepts_revealed).toEqual(content.concepts);
  });

  it("excludes taken hint levels from hint_levels_available", () => {
    const pub = toPublicProblem({
      problemVersionId: "pv_01",
      content: makeProblemVersion(),
      hintsTaken: ["l1_orientation", "l2_conceptual"],
      revealConcepts: false,
    });
    expect(pub.hint_levels_available).toEqual(["l3_structural", "outline", "editorial"]);
  });

  it("includes all hint levels when none have been taken", () => {
    const pub = toPublicProblem({
      problemVersionId: "pv_01",
      content: makeProblemVersion(),
      hintsTaken: [],
      revealConcepts: false,
    });
    expect(pub.hint_levels_available).toEqual([
      "l1_orientation",
      "l2_conceptual",
      "l3_structural",
      "outline",
      "editorial",
    ]);
  });

  it("carries through the public fields verbatim", () => {
    const content = makeProblemVersion();
    const pub = toPublicProblem({
      problemVersionId: "pv_01",
      content,
      hintsTaken: [],
      revealConcepts: false,
    });
    expect(pub.problem_version_id).toBe("pv_01");
    expect(pub.problem_id).toBe(content.problem_id);
    expect(pub.version).toBe(content.version);
    expect(pub.title).toBe(content.title);
    expect(pub.statement_md).toBe(content.statement_md);
    expect(pub.constraints_md).toBe(content.constraints_md);
    expect(pub.signature).toEqual(content.signature);
    expect(pub.examples).toEqual(content.examples);
    expect(pub.difficulty_rating).toBe(content.difficulty.rating);
    expect(pub.expected_active_minutes).toEqual(content.expected_active_minutes);
    expect(pub.target_complexity).toEqual(content.target_complexity);
    expect(pub.comparator).toBe(content.comparator);
    expect(typeof pub.starter_code.python).toBe("string");
    expect(typeof pub.starter_code.cpp).toBe("string");
  });
});

describe("starterCodeFor", () => {
  const signature = {
    name: "maxWindowSum",
    params: [
      { name: "nums", type: "list[int]" },
      { name: "k", type: "int" },
    ],
    returns: "int",
  };

  it("generates a bare top-level python def stub", () => {
    const code = starterCodeFor(signature, "python");
    expect(code).toContain("def maxWindowSum(nums: List[int], k: int) -> int:");
    expect(code).toContain("pass");
    expect(code).not.toContain("self");
    expect(code).not.toContain("class ");
  });

  it("generates a C++ Solution class stub with type-mapped params", () => {
    const code = starterCodeFor(signature, "cpp");
    expect(code).toContain("class Solution {");
    expect(code).toContain("public:");
    expect(code).toContain("long long maxWindowSum(std::vector<long long> nums, long long k)");
  });

  it("maps C++ types per docs/CONTRACTS.md §7", () => {
    const sig = {
      name: "f",
      params: [
        { name: "a", type: "int" },
        { name: "b", type: "float" },
        { name: "c", type: "bool" },
        { name: "d", type: "str" },
        { name: "e", type: "list[int]" },
        { name: "t", type: "TreeNode" },
        { name: "l", type: "ListNode" },
      ],
      returns: "bool",
    };
    const code = starterCodeFor(sig, "cpp");
    expect(code).toContain("long long a");
    expect(code).toContain("double b");
    expect(code).toContain("bool c");
    expect(code).toContain("std::string d");
    expect(code).toContain("std::vector<long long> e");
    expect(code).toContain("TreeNode* t");
    expect(code).toContain("ListNode* l");
    expect(code).toContain("bool f(");
  });

  it("maps python Optional types for nullable tree/list roots", () => {
    const sig = {
      name: "f",
      params: [{ name: "root", type: "TreeNode?" }],
      returns: "ListNode?",
    };
    const code = starterCodeFor(sig, "python");
    expect(code).toContain("root: Optional[TreeNode]");
    expect(code).toContain("-> Optional[ListNode]:");
  });
});

describe("cross-language null tolerance (regression)", () => {
  // The content plane is Python. pydantic serializes an unset `str | None` / `int | None` as JSON
  // `null`, and jsonb preserves that null rather than dropping the key. A `.optional()` schema
  // accepts only `undefined`, so it rejected valid stored content and sent every checker-less
  // problem's judge job to `dead` after 3 attempts. Caught by scripts/demo.sh, not by a unit test.
  it("accepts checker_py: null (as Python emits it) and normalizes it to undefined", () => {
    const parsed = ProblemVersionSchema.parse({ ...makeProblemVersion(), checker_py: null });
    expect(parsed.checker_py).toBeUndefined();
  });

  it("accepts an absent checker_py", () => {
    const raw = makeProblemVersion() as Record<string, unknown>;
    delete raw.checker_py;
    expect(() => ProblemVersionSchema.parse(raw)).not.toThrow();
  });

  it("accepts hidden_tests[].seed: null", () => {
    const parsed = ProblemVersionSchema.parse({
      ...makeProblemVersion(),
      hidden_tests: [{ args: [[1, 2], 1], expected: 2, origin: "random", seed: null }],
    });
    expect(parsed.hidden_tests[0]!.seed).toBeUndefined();
  });

  it("still rejects a non-string checker_py", () => {
    expect(() => ProblemVersionSchema.parse({ ...makeProblemVersion(), checker_py: 42 })).toThrow();
  });
});
