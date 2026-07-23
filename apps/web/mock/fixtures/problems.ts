import type { ProblemVersion } from "@algolift/shared";
import { fixedId } from "../ids.js";

export interface ProblemFixture {
  problemVersionId: string;
  content: ProblemVersion;
}

const NOW = "2026-07-01T00:00:00.000Z";

function provenance(model: string) {
  return { mode: "novel" as const, model, prompt_version: "v1", generated_at: NOW };
}

// --- 1. arrays_hashing — "Pair Sum Indices" ------------------------------------------------

const pairSum: ProblemFixture = {
  problemVersionId: fixedId("pair-sum-indices"),
  content: {
    problem_id: fixedId("problem:pair-sum-indices"),
    version: 1,
    title: "Pair Sum Indices",
    internal_name: "pair-sum-indices",
    statement_md:
      "A market stall owner tags every item with a price. Given the list of tagged prices `nums` " +
      "and a `target` amount, find the indices of the two items whose prices add up exactly to " +
      "`target`.\n\n" +
      "Return the two indices in any order. Assume exactly one valid pair exists, and you may not " +
      "use the same item twice.\n\n" +
      "```text\n" +
      "nums:   [2, 7, 11, 15]\n" +
      "target: 9\n" +
      "output: [0, 1]   # nums[0] + nums[1] == 9\n" +
      "```",
    constraints_md:
      "- `2 <= nums.length <= 10^4`\n" +
      "- `-10^9 <= nums[i] <= 10^9`\n" +
      "- `-10^9 <= target <= 10^9`\n" +
      "- Exactly one valid pair of indices exists.",
    signature: {
      name: "pairSumIndices",
      params: [
        { name: "nums", type: "list[int]" },
        { name: "target", type: "int" },
      ],
      returns: "list[int]",
    },
    examples: [
      { args: [[2, 7, 11, 15], 9], expected: [0, 1], explanation: "nums[0] + nums[1] = 2 + 7 = 9." },
      { args: [[3, 2, 4], 6], expected: [1, 2], explanation: "nums[1] + nums[2] = 2 + 4 = 6." },
    ],
    concepts: [
      { id: "arrays_hashing", role: "primary", weight: 0.7 },
      { id: "two_pointers", role: "secondary", weight: 0.3 },
    ],
    difficulty: { rating: 1050, confidence: "verified" },
    expected_active_minutes: [4, 10],
    target_complexity: { time: "O(n)", space: "O(n)" },
    reference_solution_py:
      "def pairSumIndices(nums, target):\n" +
      "    seen = {}\n" +
      "    for i, x in enumerate(nums):\n" +
      "        need = target - x\n" +
      "        if need in seen:\n" +
      "            return [seen[need], i]\n" +
      "        seen[x] = i\n" +
      "    raise ValueError('no pair found')\n",
    brute_force_py:
      "def pairSumIndices(nums, target):\n" +
      "    for i in range(len(nums)):\n" +
      "        for j in range(i + 1, len(nums)):\n" +
      "            if nums[i] + nums[j] == target:\n" +
      "                return [i, j]\n" +
      "    raise ValueError('no pair found')\n",
    input_generator_py:
      "def generate(rng, size_hint):\n" +
      "    n = rng.randint(2, size_hint)\n" +
      "    nums = [rng.randint(-1000, 1000) for _ in range(n)]\n" +
      "    i, j = rng.sample(range(n), 2)\n" +
      "    target = nums[i] + nums[j]\n" +
      "    return [nums, target]\n",
    comparator: "unordered",
    hidden_tests: [
      { args: [[1, 5, 3, 8], 11], expected: [1, 3], origin: "example" },
      { args: [[-3, 4, 3, 90], 0], expected: [0, 2], origin: "random" },
      { args: [[1, 1], 2], expected: [0, 1], origin: "boundary" },
      { args: [[5, -2, 100000, 3], 3], expected: [1, 3], origin: "adversarial" },
    ],
    mutants_py: [
      "def pairSumIndices(nums, target):\n    seen = {}\n    for i, x in enumerate(nums):\n        need = target - x\n        if need in seen:\n            return [i, seen[need]]\n        seen[x] = i\n",
    ],
    hints: {
      l1_orientation:
        "You only get to look at each price once as you scan the list. What would you need to " +
        "remember about the prices you've already seen to answer 'have I seen the complement of " +
        "this price before?' in constant time?",
      l2_conceptual:
        "A lookup keyed by value, built incrementally as you scan left to right, turns 'has the " +
        "complement appeared yet' into a single lookup instead of a second scan.",
      l3_structural:
        "Walk the array once. At index i, compute `need = target - nums[i]`. Check a hash map " +
        "for `need`; if present, you're done. Otherwise record `nums[i] -> i` and continue.",
      outline:
        "1. Create an empty dict `seen`.\n2. For i, x in enumerate(nums): compute need = target - x.\n" +
        "3. If need in seen, return [seen[need], i].\n4. Otherwise seen[x] = i.\n5. Continue to the next index.",
      editorial_md:
        "## Approach\n\nMaintain a hash map from **value seen so far → its index**. For each new " +
        "value `x`, its required partner is `target - x`; if that partner is already in the map " +
        "we're done in O(1). This turns the naive O(n²) pair check into a single O(n) pass, at the " +
        "cost of O(n) extra space for the map.\n\n" +
        "**Complexity:** O(n) time, O(n) space.\n\n" +
        "**Common mistake:** using the same element twice — the map is populated *after* the check, " +
        "so an index can never pair with itself.",
    },
    provenance: provenance("claude-mock-v1"),
    state: "approved",
  },
};

// --- 2. sliding_window — "Longest Distinct Run" --------------------------------------------

const longestDistinctRun: ProblemFixture = {
  problemVersionId: fixedId("longest-distinct-run"),
  content: {
    problem_id: fixedId("problem:longest-distinct-run"),
    version: 1,
    title: "Longest Distinct Run",
    internal_name: "longest-distinct-run",
    statement_md:
      "A festival wristband scanner logs one letter per attendee as they pass a gate, in order. " +
      "Security wants the length of the **longest stretch of consecutive scans with no repeated " +
      "letter** — the longest run where nobody who already passed shows up again before the run " +
      "resets.\n\n" +
      "Given the scan log `s` as a string, return the length of that longest run.",
    constraints_md: "- `0 <= s.length <= 5 * 10^4`\n- `s` consists of printable ASCII characters.",
    signature: { name: "longestDistinctRun", params: [{ name: "s", type: "str" }], returns: "int" },
    examples: [
      { args: ["abcabcbb"], expected: 3, explanation: "The run \"abc\" has length 3." },
      { args: ["bbbbb"], expected: 1, explanation: "The run \"b\" has length 1." },
      { args: ["pwwkew"], expected: 3, explanation: "The run \"wke\" has length 3." },
    ],
    concepts: [
      { id: "sliding_window", role: "primary", weight: 0.75 },
      { id: "arrays_hashing", role: "secondary", weight: 0.25 },
    ],
    difficulty: { rating: 1220, confidence: "verified" },
    expected_active_minutes: [8, 18],
    target_complexity: { time: "O(n)", space: "O(min(n, alphabet))" },
    reference_solution_py:
      "def longestDistinctRun(s):\n" +
      "    last = {}\n    start = 0\n    best = 0\n" +
      "    for i, ch in enumerate(s):\n" +
      "        if ch in last and last[ch] >= start:\n" +
      "            start = last[ch] + 1\n" +
      "        last[ch] = i\n" +
      "        best = max(best, i - start + 1)\n" +
      "    return best\n",
    brute_force_py:
      "def longestDistinctRun(s):\n" +
      "    best = 0\n" +
      "    for i in range(len(s)):\n" +
      "        seen = set()\n" +
      "        for j in range(i, len(s)):\n" +
      "            if s[j] in seen:\n                break\n" +
      "            seen.add(s[j])\n" +
      "            best = max(best, j - i + 1)\n" +
      "    return best\n",
    input_generator_py:
      "import string\n" +
      "def generate(rng, size_hint):\n" +
      "    n = rng.randint(0, size_hint)\n" +
      "    alphabet = string.ascii_lowercase[: rng.randint(1, 26)]\n" +
      "    return [''.join(rng.choice(alphabet) for _ in range(n))]\n",
    comparator: "exact",
    hidden_tests: [
      { args: [""], expected: 0, origin: "boundary" },
      { args: ["a"], expected: 1, origin: "boundary" },
      { args: ["dvdf"], expected: 3, origin: "random" },
      { args: ["abba"], expected: 2, origin: "adversarial" },
    ],
    mutants_py: [
      "def longestDistinctRun(s):\n    last = {}\n    start = 0\n    best = 0\n    for i, ch in enumerate(s):\n        if ch in last:\n            start = last[ch] + 1\n        last[ch] = i\n        best = max(best, i - start + 1)\n    return best\n",
    ],
    hints: {
      l1_orientation:
        "You're tracking a stretch of the log that must stay repeat-free. When a repeat shows up, " +
        "does the whole stretch need to reset, or just the part before the earlier occurrence?",
      l2_conceptual:
        "Keep a moving stretch bounded by a start and end position. When the letter at the end has " +
        "appeared before *inside the current stretch*, only the start needs to jump forward — past " +
        "the earlier occurrence, not back to zero.",
      l3_structural:
        "Track the last-seen index of every letter. As you extend the stretch one letter at a " +
        "time, if that letter's last-seen index is inside the current stretch, move the start just " +
        "past it. Update the best length after every extension.",
      outline:
        "1. last = {} (letter -> most recent index)\n2. start = 0, best = 0\n" +
        "3. For i, ch in enumerate(s):\n   a. if ch in last and last[ch] >= start: start = last[ch] + 1\n" +
        "   b. last[ch] = i\n   c. best = max(best, i - start + 1)\n4. return best",
      editorial_md:
        "## Approach\n\nA moving window `[start, i]` that always holds repeat-free letters. A hash " +
        "map records the last index each letter was seen at. When the current letter's last " +
        "occurrence falls inside the window, `start` jumps to just past it — never backward — so " +
        "each pointer only moves forward, giving O(n) total work instead of re-scanning.\n\n" +
        "**Complexity:** O(n) time, O(min(n, alphabet size)) space.",
    },
    provenance: provenance("claude-mock-v1"),
    state: "approved",
  },
};

// --- 3. binary_search — "Find Insertion Band" ----------------------------------------------

const findInsertionBand: ProblemFixture = {
  problemVersionId: fixedId("find-insertion-band"),
  content: {
    problem_id: fixedId("problem:find-insertion-band"),
    version: 1,
    title: "Find Insertion Band",
    internal_name: "find-insertion-band",
    statement_md:
      "A price list `nums` is sorted from lowest to highest, with no duplicate prices. Given a new " +
      "`target` price, return the index at which it belongs — either the index of an existing " +
      "match, or the index it should be inserted at to keep the list sorted.",
    constraints_md:
      "- `1 <= nums.length <= 10^4`\n- `-10^4 <= nums[i], target <= 10^4`\n- `nums` is sorted, strictly increasing.",
    signature: {
      name: "findInsertionBand",
      params: [
        { name: "nums", type: "list[int]" },
        { name: "target", type: "int" },
      ],
      returns: "int",
    },
    examples: [
      { args: [[1, 3, 5, 6], 5], expected: 2, explanation: "5 is already at index 2." },
      { args: [[1, 3, 5, 6], 2], expected: 1, explanation: "2 belongs between 1 and 3, at index 1." },
      { args: [[1, 3, 5, 6], 7], expected: 4, explanation: "7 is larger than everything; it goes at the end." },
    ],
    concepts: [{ id: "binary_search", role: "primary", weight: 1.0 }],
    difficulty: { rating: 1150, confidence: "verified" },
    expected_active_minutes: [5, 12],
    target_complexity: { time: "O(log n)", space: "O(1)" },
    reference_solution_py:
      "def findInsertionBand(nums, target):\n" +
      "    lo, hi = 0, len(nums)\n" +
      "    while lo < hi:\n" +
      "        mid = (lo + hi) // 2\n" +
      "        if nums[mid] < target:\n            lo = mid + 1\n" +
      "        else:\n            hi = mid\n" +
      "    return lo\n",
    brute_force_py:
      "def findInsertionBand(nums, target):\n" +
      "    for i, x in enumerate(nums):\n        if x >= target:\n            return i\n" +
      "    return len(nums)\n",
    input_generator_py:
      "def generate(rng, size_hint):\n" +
      "    n = rng.randint(1, size_hint)\n" +
      "    nums = sorted(rng.sample(range(-10000, 10000), n))\n" +
      "    target = rng.randint(-10000, 10000)\n" +
      "    return [nums, target]\n",
    comparator: "exact",
    hidden_tests: [
      { args: [[1], 0], expected: 0, origin: "boundary" },
      { args: [[1], 2], expected: 1, origin: "boundary" },
      { args: [[1, 2, 4, 8, 16], 9], expected: 4, origin: "random" },
      { args: [[-5, -1, 0, 3, 7], -10], expected: 0, origin: "adversarial" },
    ],
    mutants_py: [
      "def findInsertionBand(nums, target):\n    lo, hi = 0, len(nums)\n    while lo < hi:\n        mid = (lo + hi) // 2\n        if nums[mid] <= target:\n            lo = mid + 1\n        else:\n            hi = mid\n    return lo\n",
    ],
    hints: {
      l1_orientation:
        "The list is sorted, so checking one price near the middle rules out an entire half of the " +
        "remaining candidates. How could you use that to avoid checking every price?",
      l2_conceptual:
        "Keep a shrinking window of possible answer positions. Each check at the window's midpoint " +
        "tells you which half of the window can be discarded.",
      l3_structural:
        "Maintain `lo, hi = 0, len(nums)`. While `lo < hi`, look at `mid = (lo+hi)//2`. If " +
        "`nums[mid]` is too small, the answer is strictly to the right; otherwise it's `mid` or to " +
        "the left. Narrow the window accordingly until it collapses to one index.",
      outline:
        "1. lo, hi = 0, len(nums)\n2. while lo < hi:\n   a. mid = (lo + hi) // 2\n" +
        "   b. if nums[mid] < target: lo = mid + 1\n   c. else: hi = mid\n3. return lo",
      editorial_md:
        "## Approach\n\nHalve the search space every step. Keep an invariant: the answer always " +
        "lies in `[lo, hi)`. If the midpoint value is too small, the answer must be to its right; " +
        "otherwise the midpoint is a valid candidate and the answer is at or before it. The loop " +
        "ends when the window collapses to a single index, which is the answer.\n\n" +
        "**Complexity:** O(log n) time, O(1) space.",
    },
    provenance: provenance("claude-mock-v1"),
    state: "approved",
  },
};

// --- 4. trees_bst — "Tree Height" (exercises TreeNode starter code) ------------------------

const treeHeight: ProblemFixture = {
  problemVersionId: fixedId("tree-height"),
  content: {
    problem_id: fixedId("problem:tree-height"),
    version: 1,
    title: "Tree Height",
    internal_name: "tree-height",
    statement_md:
      "An org chart is modeled as a binary tree: each node is a role with at most two direct " +
      "reports, `left` and `right`. Given the `root` of the chart (or `None` for an empty " +
      "organization), return its height — the number of roles on the longest chain from the root " +
      "down to a report with no reports of their own. An empty organization has height `0`, and a " +
      "single role with no reports has height `1`.",
    constraints_md: "- `0 <= number of nodes <= 10^4`\n- `-10^5 <= Node.val <= 10^5`",
    signature: { name: "treeHeight", params: [{ name: "root", type: "TreeNode?" }], returns: "int" },
    examples: [
      { args: [[3, 9, 20, null, null, 15, 7]], expected: 3, explanation: "root -> 20 -> 15 (or 7) is 3 deep." },
      { args: [[]], expected: 0, explanation: "An empty tree has height 0." },
      { args: [[1]], expected: 1, explanation: "A single node has height 1." },
    ],
    concepts: [{ id: "trees_bst", role: "primary", weight: 1.0 }],
    difficulty: { rating: 1300, confidence: "verified" },
    expected_active_minutes: [6, 14],
    target_complexity: { time: "O(n)", space: "O(h)" },
    reference_solution_py:
      "def treeHeight(root):\n" +
      "    if root is None:\n        return 0\n" +
      "    return 1 + max(treeHeight(root.left), treeHeight(root.right))\n",
    brute_force_py:
      "def treeHeight(root):\n" +
      "    if root is None:\n        return 0\n" +
      "    stack = [(root, 1)]\n    best = 0\n" +
      "    while stack:\n        node, depth = stack.pop()\n        best = max(best, depth)\n" +
      "        if node.left:\n            stack.append((node.left, depth + 1))\n" +
      "        if node.right:\n            stack.append((node.right, depth + 1))\n" +
      "    return best\n",
    input_generator_py:
      "def generate(rng, size_hint):\n" +
      "    # builds a random level-order array with occasional null holes\n" +
      "    n = rng.randint(0, size_hint)\n" +
      "    return [[rng.randint(-100, 100) if rng.random() > 0.15 else None for _ in range(n)]]\n",
    comparator: "exact",
    hidden_tests: [
      { args: [[]], expected: 0, origin: "boundary" },
      { args: [[5, 3, 8, 1, 4, 7, 9, 0]], expected: 4, origin: "random" },
      { args: [[1, null, 2, null, 3, null, 4]], expected: 4, origin: "adversarial" },
    ],
    mutants_py: [
      "def treeHeight(root):\n    if root is None:\n        return 0\n    return max(treeHeight(root.left), treeHeight(root.right))\n",
    ],
    hints: {
      l1_orientation:
        "The height of the whole chart depends on the heights of the two reporting lines below the " +
        "root. What's the smallest chart you could answer this for directly, without looking below it?",
      l2_conceptual:
        "An empty chart has a height you know immediately. Every other chart's height is one more " +
        "than the taller of its two direct reporting lines — each of which is the same kind of " +
        "question, just smaller.",
      l3_structural:
        "Define the answer for `None` as `0`. Otherwise, compute the answer for `root.left` and for " +
        "`root.right`, then combine them as `1 + max(left_answer, right_answer)`.",
      outline:
        "1. If root is None: return 0.\n2. left = treeHeight(root.left)\n3. right = treeHeight(root.right)\n" +
        "4. return 1 + max(left, right)",
      editorial_md:
        "## Approach\n\nThe height of a tree rooted at `root` is `0` for an empty tree, otherwise " +
        "`1 + max(height(left), height(right))` — each subtree answers the exact same question at " +
        "a smaller scale. Every node is visited once.\n\n" +
        "**Complexity:** O(n) time, O(h) space for the call stack (h = height).",
    },
    provenance: provenance("claude-mock-v1"),
    state: "approved",
  },
};

export const PROBLEM_FIXTURES: ProblemFixture[] = [pairSum, longestDistinctRun, findInsertionBand, treeHeight];
