"""Stage 5 — examples (CONTRACTS.md §10).

Fails when any public example isn't reproduced exactly by the reference solution. A mismatch here
is a common LLM failure mode (the model wrote a statement/example pair its own reference doesn't
actually satisfy), so the failure details name which example and both the expected and actual
value.
"""

from __future__ import annotations

import time
from typing import Any

from leetmind_content.models import ProblemVersion, StageResult
from leetmind_content.sandbox import SandboxLimits
from leetmind_content.verification.execution import compare_against

STAGE = "examples"


def run(
    problem: ProblemVersion,
    *,
    limits: SandboxLimits,
    comparator_spec: dict[str, Any],
) -> StageResult:
    started = time.monotonic()

    cases = [(ex.args, ex.expected) for ex in problem.examples]
    result, actual = compare_against(
        problem.reference_solution_py,
        cases,
        problem.signature,
        comparator_spec,
        limits,
        checker_source=problem.checker_py,
        reveal_inputs=True,
    )

    mismatches = []
    for i, pt in enumerate(result.per_test):
        if not pt.passed:
            mismatches.append(
                {
                    "example_index": i,
                    "args": problem.examples[i].args,
                    "expected": problem.examples[i].expected,
                    "actual": actual[i],
                    "status": pt.status,
                }
            )

    duration_ms = int((time.monotonic() - started) * 1000)

    if mismatches:
        return StageResult(
            stage=STAGE,
            status="failed",
            duration_ms=duration_ms,
            details={"reason": "example_mismatch", "mismatches": mismatches},
        )

    return StageResult(
        stage=STAGE,
        status="passed",
        duration_ms=duration_ms,
        details={"examples_checked": len(cases)},
    )
