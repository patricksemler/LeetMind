"""Stage 2 — compile (CONTRACTS.md §10).

Fails when: reference or brute force fails to import/run a smoke case (the FIRST public example)
in the sandbox. A `wrong_answer` verdict here is NOT a compile failure — it just means the
solution ran but the example-vs-output check (real correctness) hasn't been verified yet, which
is stage 5's job. Only verdicts that mean "never produced a usable run" fail this stage.
"""

from __future__ import annotations

import time

from leetmind_content.models import ProblemVersion, StageResult
from leetmind_content.sandbox import SandboxLimits, run_python

STAGE = "compile"

#: Verdicts meaning "the solution never produced a real result" — i.e. failed to import/run.
_FAILED_TO_RUN_VERDICTS = frozenset(
    {
        "compilation_error",
        "runtime_error",
        "internal_error",
        "time_limit",
        "memory_limit",
        "output_limit",
    }
)


def _smoke_check(
    label: str,
    source: str,
    problem: ProblemVersion,
    comparator_spec: dict[str, object],
    limits: SandboxLimits,
) -> dict[str, object] | None:
    """Runs `source` against the first public example. Returns `None` on success, or a details
    dict describing the failure."""
    example = problem.examples[0]
    result = run_python(
        problem.signature,
        [{"args": example.args, "expected": example.expected}],
        comparator_spec,
        source,
        limits,
        checker_source=problem.checker_py,
        reveal_inputs=True,
    )
    if result.verdict in _FAILED_TO_RUN_VERDICTS:
        message = result.failure.message if result.failure else result.verdict
        return {"solution": label, "verdict": result.verdict, "message": message}
    return None


def run(
    problem: ProblemVersion,
    *,
    limits: SandboxLimits,
    comparator_spec: dict[str, object],
) -> StageResult:
    started = time.monotonic()

    failure = _smoke_check(
        "reference", problem.reference_solution_py, problem, comparator_spec, limits
    )
    if failure is None:
        failure = _smoke_check(
            "brute_force", problem.brute_force_py, problem, comparator_spec, limits
        )

    duration_ms = int((time.monotonic() - started) * 1000)
    if failure is not None:
        return StageResult(stage=STAGE, status="failed", duration_ms=duration_ms, details=failure)

    return StageResult(stage=STAGE, status="passed", duration_ms=duration_ms, details={})
