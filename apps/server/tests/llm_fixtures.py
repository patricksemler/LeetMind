"""Shared canned LLM responses for planner/builder/worker tests (PLAN_BACKEND.md §12: "the LLM CLI
stubbed with recorded fixtures"). `FakeLLM` is a duck-typed stand-in for `leetmind.llm.LLMClient`
— same `async complete(prompt, schema) -> BaseModel` shape — so it drops into `plan_generation`,
`build_problem`, and `GenerationWorker` without a real subprocess; `llm.py`'s own subprocess
mechanics are covered separately in test_llm.py.

The canned data itself lives in `leetmind.fixtures`, shared with the live server's `LLM_CLI=fixture`
adapter mode (used by the Playwright e2e smoke) so both exercise the exact same problem instead of
two copies drifting apart.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from leetmind.fixtures import (
    BUILDER_MARKER,
    BUILDER_REPAIR_MARKER,
    INDEPENDENT_REVIEW_MARKER,
    ORACLE_MARKER,
    PLAN_REVIEW_MARKER,
    PLANNER_MARKER,
    QUALITY_REVIEW_MARKER,
    aligned_quality_review_output,
    aligned_independent_review_output,
    aligned_plan_review_output,
    fresh_user_plan_output,
    sum_problem_builder_output,
    sum_problem_oracle_output,
)

__all__ = [
    "BUILDER_MARKER",
    "BUILDER_REPAIR_MARKER",
    "INDEPENDENT_REVIEW_MARKER",
    "ORACLE_MARKER",
    "PLAN_REVIEW_MARKER",
    "PLANNER_MARKER",
    "QUALITY_REVIEW_MARKER",
    "FakeLLM",
    "aligned_quality_review_output",
    "aligned_independent_review_output",
    "aligned_plan_review_output",
    "fresh_user_plan_output",
    "sum_problem_builder_output",
    "sum_problem_oracle_output",
]


class FakeLLM:
    """Ordered (marker, response) rules; the first substring match in the prompt wins — put more
    specific markers (e.g. a repair prompt) before the generic one they'd otherwise also match."""

    def __init__(self, rules: list[tuple[str, dict[str, Any]]]) -> None:
        self._rules = rules
        self.calls: list[str] = []

    async def complete(self, prompt: str, schema: type[BaseModel]) -> BaseModel:
        self.calls.append(prompt)
        if schema.__name__ == "PlanReviewOutput":
            return schema.model_validate(aligned_plan_review_output())
        for marker, data in self._rules:
            if marker in prompt:
                return schema.model_validate(data)
        raise AssertionError(f"FakeLLM: no rule matched this prompt:\n{prompt[:500]}")
