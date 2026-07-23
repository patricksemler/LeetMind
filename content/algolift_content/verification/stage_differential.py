"""Stage 3 — differential (CONTRACTS.md §10).

Fails when reference != brute-force on any of `VERIFY_DIFFERENTIAL_CASES` seeded inputs (drawn
from the problem's own `input_generator_py`, executed inside the sandbox via
`algolift_content.codegen.seeded_inputs`). On disagreement, the counterexample is shrunk
(`algolift_content.verification.shrink`) before being reported.

On success, returns every case as a verified `TestCase` (origin='random', expected = the
*reference* solution's actual output) — this is the "random" contribution to the hidden suite
built after stage 4.

Sandbox calls: 1 to generate inputs, 1 to run brute-force over all of them, 1 to run reference
over all of them (comparing against brute's outputs with the real comparator) — batched
regardless of `VERIFY_DIFFERENTIAL_CASES`'s size, plus whatever `shrink_counterexample` needs
(only on a disagreement).
"""

from __future__ import annotations

import time
from typing import Any

from algolift_content.codegen import GeneratorContractError, seeded_inputs
from algolift_content.config import Settings, get_settings
from algolift_content.models import ProblemVersion, StageResult, TestCase
from algolift_content.sandbox import SandboxLimits
from algolift_content.verification.execution import actual_outputs, compare_against
from algolift_content.verification.shrink import shrink_counterexample, size_metric

STAGE = "differential"

#: Arbitrary but fixed starting seed for the differential batch — kept far from stage_boundary's
#: reserved seed range (see stage_boundary.py) so the two stages never accidentally reuse seeds.
SEED_START = 1


def run(
    problem: ProblemVersion,
    *,
    limits: SandboxLimits,
    comparator_spec: dict[str, Any],
    settings: Settings | None = None,
) -> tuple[StageResult, dict[str, Any]]:
    started = time.monotonic()
    s = settings or get_settings()
    count = s.VERIFY_DIFFERENTIAL_CASES

    try:
        cases = seeded_inputs(
            problem.input_generator_py, problem.signature, count, SEED_START, limits=limits
        )
    except GeneratorContractError as exc:
        duration_ms = int((time.monotonic() - started) * 1000)
        return (
            StageResult(
                stage=STAGE,
                status="failed",
                duration_ms=duration_ms,
                details={"reason": "generator_contract_error", "message": str(exc)},
            ),
            {"seeds": []},
        )

    seeds = [c["seed"] for c in cases]
    args_list = [c["args"] for c in cases]

    if not args_list:
        duration_ms = int((time.monotonic() - started) * 1000)
        return (
            StageResult(
                stage=STAGE, status="passed", duration_ms=duration_ms, details={"cases": 0}
            ),
            {"seeds": [], "verified_cases": []},
        )

    brute_results, _brute_raw = actual_outputs(
        problem.brute_force_py, args_list, problem.signature, limits
    )
    expected_pairs = [
        (args_list[i], brute_results[i].output if brute_results[i].ok else None)
        for i in range(len(args_list))
    ]
    result, reference_outputs = compare_against(
        problem.reference_solution_py,
        expected_pairs,
        problem.signature,
        comparator_spec,
        limits,
        checker_source=problem.checker_py,
    )

    mismatched = [i for i, pt in enumerate(result.per_test) if not pt.passed]

    duration_ms = int((time.monotonic() - started) * 1000)

    if mismatched:
        idx = mismatched[0]
        original_args = args_list[idx]
        shrunk_args, attempts_used = shrink_counterexample(
            original_args,
            brute_source=problem.brute_force_py,
            reference_source=problem.reference_solution_py,
            signature=problem.signature,
            comparator_spec=comparator_spec,
            limits=limits,
            checker_source=problem.checker_py,
        )
        counterexample = {
            "seed": seeds[idx],
            "original_args": original_args,
            "original_size": size_metric(original_args),
            "shrunk_args": shrunk_args,
            "shrunk_size": size_metric(shrunk_args),
            "shrink_attempts": attempts_used,
            "brute_status": brute_results[idx].status,
            "reference_status": result.per_test[idx].status,
        }
        return (
            StageResult(
                stage=STAGE,
                status="failed",
                duration_ms=duration_ms,
                details={
                    "reason": "reference_brute_disagreement",
                    "mismatched_count": len(mismatched),
                    "counterexample": counterexample,
                },
            ),
            {"seeds": seeds, "counterexample": counterexample},
        )

    verified_cases = [
        TestCase(args=args_list[i], expected=reference_outputs[i], origin="random", seed=seeds[i])
        for i in range(len(args_list))
    ]
    return (
        StageResult(
            stage=STAGE, status="passed", duration_ms=duration_ms, details={"cases": len(args_list)}
        ),
        {"seeds": seeds, "verified_cases": verified_cases},
    )
