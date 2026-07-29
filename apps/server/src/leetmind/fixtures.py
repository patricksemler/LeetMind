"""Canned LLM responses shared by the test suite and `LLM_CLI=fixture` (PLAN_BACKEND.md §12: "the
LLM CLI stubbed with recorded fixtures"). Marker-based: the first substring match against the
*real* prompt templates (planner.py, builder.py) wins, so a prompt-text change breaks matching
loudly instead of silently.

Living in `src/leetmind` (not `tests/`) so both the pytest suite (`tests/llm_fixtures.py`, which
wraps this in `FakeLLM` for direct injection) and the live server's fixture-mode adapter
(`llm.py`, for a real `uvicorn` process with no LLM CLI to call — e.g. Playwright's e2e smoke,
PLAN_BACKEND.md §12) exercise the exact same canned problem, rather than two copies drifting apart.
"""

from __future__ import annotations

import copy
from typing import Any

PLANNER_MARKER = "You are picking the next practice problem to generate"
PLAN_REVIEW_MARKER = "Review this candidate\nplan before any problem is built"
BUILDER_MARKER = "Generate one algorithm practice problem as JSON"
BUILDER_REPAIR_MARKER = "Your previous attempt failed verification"
ORACLE_MARKER = "You are an independent verifier"
QUALITY_REVIEW_MARKER = "You are an independent curriculum reviewer"
INDEPENDENT_REVIEW_MARKER = "independent reviewer and brute-force oracle author"

# -- a tiny, judge-executable "sum a list" problem, shared by builder/verify/worker/e2e -----------

_SUM_SIGNATURE = {
    "func_name": "solve",
    "params": [{"name": "nums", "type": {"kind": "int", "nullable": False, "list_depth": 1}}],
    "returns": {"kind": "int", "nullable": False, "list_depth": 0},
    "order_insensitive": False,
}

_SUM_PUBLIC_TESTS = [
    {"args": [[1, 2, 3]], "expected": 6},
    {"args": [[0]], "expected": 0},
    {"args": [[-1, 1]], "expected": 0},
]

_SUM_PRIVATE_TESTS = [
    {"args": [[]], "expected": 0},
    {"args": [[5]], "expected": 5},
    {"args": [[1, -1, 2, -2]], "expected": 0},
    {"args": [[10, 20, 30]], "expected": 60},
    {"args": [[-5, -5, -5]], "expected": -15},
    {"args": [[100]], "expected": 100},
    {"args": [[1, 1, 1, 1, 1, 1]], "expected": 6},
    {"args": [[7, -3, 2]], "expected": 6},
]

_SUM_INPUT_GENERATOR = (
    "def generate(seed):\n"
    "    import random\n"
    "    rng = random.Random(seed)\n"
    "    n = rng.randint(0, 5)\n"
    "    return [[rng.randint(-10, 10) for _ in range(n)]]\n"
)

_SUM_HINTS = [
    "Think about what a single running total would need to track.",
    "This is a linear scan with an accumulator.",
    "Initialize total=0, add each element once.",
    "for x in nums: total += x; return total",
]


def sum_problem_builder_output(*, buggy: bool = False, title: str = "Sum It Up") -> dict[str, Any]:
    """A minimal builder output for `def solve(nums: int[]) -> int`. `buggy=True` swaps in an
    off-by-one reference solution — wrong on every non-empty input, so verification's gate 1
    (reference vs authored tests) reliably fails (§12: "a seeded wrong-expected-output fixture",
    realized here as a seeded wrong-*reference*)."""
    reference_solution = (
        "def solve(nums):\n    return sum(nums) + 1\n"
        if buggy
        else "def solve(nums):\n    return sum(nums)\n"
    )
    return {
        "title": title,
        "statement_md": "Given a list of integers `nums`, return the sum of its elements.",
        "constraints": ["0 <= nums.length <= 100", "-100 <= nums[i] <= 100"],
        "support_types": [],
        "signature": copy.deepcopy(_SUM_SIGNATURE),
        "starter_code": "def solve(nums):\n    pass\n",
        "public_tests": copy.deepcopy(_SUM_PUBLIC_TESTS),
        "private_tests": copy.deepcopy(_SUM_PRIVATE_TESTS),
        "hints": copy.deepcopy(_SUM_HINTS),
        "reference_solution": reference_solution,
        "input_generator": _SUM_INPUT_GENERATOR,
        "complexity": {"time": "O(n)", "space": "O(1)"},
        "par_minutes": 5,
    }


def sum_problem_oracle_output() -> dict[str, str]:
    return {
        "brute_solution": (
            "def solve(nums):\n    total = 0\n    for x in nums:\n        total += x\n"
            "    return total\n"
        )
    }


def aligned_quality_review_output() -> dict[str, Any]:
    return {"aligned_with_plan": True, "issues": []}


def aligned_independent_review_output() -> dict[str, Any]:
    return {
        "aligned_with_plan": True,
        "issues": [],
        "brute_solution": sum_problem_oracle_output()["brute_solution"],
    }


def aligned_plan_review_output() -> dict[str, Any]:
    return {"aligned_with_activity": True, "issues": []}


def fresh_user_plan_output(**overrides: Any) -> dict[str, Any]:
    """A valid `PlanOutput` for a brand-new (all-unevidenced) user's very first job: with no
    history, `selection.py`'s scores tie across all 20 types, so the shortlist is deterministically
    the first 3 of `taxonomy.PROBLEM_TYPES` and the LRU shape is deterministically `SHAPES[0]`."""
    data: dict[str, Any] = {
        "primary_type": "arrays_hashing",
        "support_types": [],
        "shape": "count_structures",
        "problem_rating": 1000,
        "premise": "A warehouse robot needs the total weight of a batch of packages.",
        "rationale": "fixture",
    }
    data.update(overrides)
    return data


def fixture_response(prompt: str) -> dict[str, Any]:
    """Routes a real prompt to its canned JSON body by marker, for `LLM_CLI=fixture` (§12). Same
    rule order as `tests/llm_fixtures.py`'s `FakeLLM`: more specific markers first, since the
    builder's repair prompt also contains the generic builder marker."""
    if BUILDER_REPAIR_MARKER in prompt:
        return sum_problem_builder_output()
    if INDEPENDENT_REVIEW_MARKER in prompt:
        return aligned_independent_review_output()
    if PLANNER_MARKER in prompt:
        return fresh_user_plan_output()
    if PLAN_REVIEW_MARKER in prompt:
        return aligned_plan_review_output()
    if BUILDER_MARKER in prompt:
        return sum_problem_builder_output()
    if QUALITY_REVIEW_MARKER in prompt:
        return aligned_quality_review_output()
    if ORACLE_MARKER in prompt:
        return sum_problem_oracle_output()
    raise LookupError(f"fixture LLM: no rule matched this prompt:\n{prompt[:500]}")
