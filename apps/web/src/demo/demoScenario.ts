import type {
  HintResponse,
  ProblemDetail,
  RatingUpdateView,
  RunResponse,
  SubmitResponse,
  TestOutcome,
} from "@shared";

export const DEMO_SOURCE = `# This solution is preloaded and read-only in the demo.

def solve(nums, target):
    seen = {}

    for index, value in enumerate(nums):
        complement = target - value
        if complement in seen:
            return [seen[complement], index]
        seen[value] = index

    return []`;

export const DEMO_PROBLEM = {
  id: "demo-pair-sum",
  status: "active",
  primary_type: "arrays_hashing",
  support_types: [],
  shape: "pairing_matching",
  problem_rating: 1050,
  is_probe: false,
  title: "Pair Sum Indices",
  statement_md:
    "Given a list of integers `nums` and an integer `target`, return the indices of the two values whose sum equals `target`.\n\nYou may assume every input has exactly one solution, and you may not use the same element twice.",
  constraints: [
    "2 <= nums.length <= 10^5",
    "-10^9 <= nums[i], target <= 10^9",
    "Exactly one valid pair exists",
  ],
  signature: {
    func_name: "solve",
    params: [
      { name: "nums", type: { kind: "int", nullable: false, list_depth: 1 } },
      { name: "target", type: { kind: "int", nullable: false, list_depth: 0 } },
    ],
    returns: { kind: "int", nullable: false, list_depth: 1 },
    order_insensitive: false,
  },
  starter_code: DEMO_SOURCE,
  public_tests: [
    { args: [[2, 7, 11, 15], 9], expected: [0, 1] },
    { args: [[3, 2, 4], 6], expected: [1, 2] },
  ],
  complexity: { time: "O(n)", space: "O(n)" },
  par_minutes: 10,
  created_at: "2026-07-28T00:00:00Z",
  served_at: "2026-07-28T00:00:00Z",
  revealed_hints: [],
} satisfies ProblemDetail;

const PASSING_RESULTS = [
  {
    index: 0,
    verdict: "pass",
    value: [0, 1],
    printed: "",
    duration_ms: 4,
  },
  {
    index: 1,
    verdict: "pass",
    value: [1, 2],
    printed: "",
    duration_ms: 3,
  },
] satisfies TestOutcome[];

export const DEMO_RATING_UPDATE = {
  type_slug: "arrays_hashing",
  rating_before: 1035,
  rating_after: 1048,
  delta: 13,
  problem_rating: 1050,
  expected_score: 0.48,
  performance_score: 0.92,
  k_factor: 30,
  metrics: {
    active_minutes: 4.6,
  },
} satisfies RatingUpdateView;

const HINTS = [
  "As you scan the list, ask what value would complete the target for the current number.",
  "A hash map can tell you in constant time whether that complementary value appeared earlier.",
  "Store each value with its index. Before storing the current value, look up `target - value`.",
  "Loop over `(index, value)`. Return the stored index and current index when the complement exists.",
];

export interface DemoExecutor {
  run: () => Promise<RunResponse>;
  submit: () => Promise<SubmitResponse>;
  revealHint: (rung: number) => Promise<HintResponse>;
}

function pause(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

/**
 * A contract-shaped, deterministic stand-in for the backend. Because every response is checked
 * against the generated shared API types, a backend contract change breaks the demo at build time
 * instead of silently letting it drift.
 */
export function createDemoExecutor({ delayMs = 650 }: { delayMs?: number } = {}): DemoExecutor {
  return {
    async run() {
      await pause(delayMs);
      return { passed: true, results: PASSING_RESULTS };
    },
    async submit() {
      await pause(delayMs);
      return {
        kind: "submit",
        passed: true,
        solved: true,
        results: PASSING_RESULTS,
        failing_case: null,
        rating_update: DEMO_RATING_UPDATE,
      };
    },
    async revealHint(rung) {
      await pause(Math.min(delayMs, 350));
      const text = HINTS[rung - 1];
      if (!text) throw new Error("That hint does not exist.");
      return { rung, text };
    },
  };
}
