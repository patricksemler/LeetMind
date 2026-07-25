"""Stage 6 — mutation (CONTRACTS.md §10).

Runs every mutant in `mutants_py` against the hidden suite built from stages 3–5. A mutant that
PASSES the suite has SURVIVED — the hidden suite failed to distinguish it from the reference
solution, which means either the suite is too weak or the mutant is semantically equivalent;
either way CONTRACTS.md §10 says the problem is not safe to serve, so any survivor rejects the
whole candidate. Mutants run concurrently (thread pool — each is one blocking `docker run` via
the sandbox CLI bridge, so threads genuinely parallelize them, matching `leetmind_content.queue`'s
own rationale for using threads over asyncio here).

A problem with zero declared mutants passes this stage vacuously (nothing can survive what wasn't
run) — CONTRACTS.md §10 doesn't declare "zero mutants" a schema failure, and `mutants_py` has no
`min_length` on `ProblemVersion` (`leetmind_content.models`), so enforcing a minimum here would be
inventing a rule not in the contract. This is noted in the final report as worth tightening at the
generation layer instead (mutants are that layer's responsibility to produce).
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from leetmind_content.models import ProblemVersion, StageResult, TestCase
from leetmind_content.sandbox import SandboxLimits, run_python

STAGE = "mutation"

MAX_WORKERS = 4


def _run_one_mutant(
    index: int,
    mutant_source: str,
    problem: ProblemVersion,
    hidden_suite: list[TestCase],
    comparator_spec: dict[str, Any],
    limits: SandboxLimits,
) -> tuple[int, bool, str]:
    """Returns `(index, survived, verdict)`. `survived` is True iff the mutant passed every test
    in the hidden suite (i.e. was NOT killed)."""
    result = run_python(
        problem.signature,
        hidden_suite,
        comparator_spec,
        mutant_source,
        limits,
        checker_source=problem.checker_py,
    )
    return index, result.verdict == "accepted", result.verdict


def run(
    problem: ProblemVersion,
    hidden_suite: list[TestCase],
    *,
    limits: SandboxLimits,
    comparator_spec: dict[str, Any],
) -> StageResult:
    started = time.monotonic()
    mutants = problem.mutants_py

    if not mutants:
        duration_ms = int((time.monotonic() - started) * 1000)
        return StageResult(
            stage=STAGE,
            status="passed",
            duration_ms=duration_ms,
            details={"mutant_count": 0, "hidden_suite_size": len(hidden_suite)},
        )

    if not hidden_suite:
        duration_ms = int((time.monotonic() - started) * 1000)
        return StageResult(
            stage=STAGE,
            status="failed",
            duration_ms=duration_ms,
            details={"reason": "empty_hidden_suite", "mutant_count": len(mutants)},
        )

    outcomes: dict[int, tuple[bool, str]] = {}
    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(mutants))) as pool:
        futures = [
            pool.submit(_run_one_mutant, i, src, problem, hidden_suite, comparator_spec, limits)
            for i, src in enumerate(mutants)
        ]
        for fut in as_completed(futures):
            index, survived, verdict = fut.result()
            outcomes[index] = (survived, verdict)

    survivors = [
        {"mutant_index": i, "verdict": verdict, "source": mutants[i]}
        for i, (survived, verdict) in sorted(outcomes.items())
        if survived
    ]
    killed_count = len(mutants) - len(survivors)

    duration_ms = int((time.monotonic() - started) * 1000)

    if survivors:
        return StageResult(
            stage=STAGE,
            status="failed",
            duration_ms=duration_ms,
            details={
                "reason": "mutant_survived",
                "mutant_count": len(mutants),
                "killed_count": killed_count,
                "survivors": survivors,
                "hidden_suite_size": len(hidden_suite),
            },
        )

    return StageResult(
        stage=STAGE,
        status="passed",
        duration_ms=duration_ms,
        details={
            "mutant_count": len(mutants),
            "killed_count": killed_count,
            "hidden_suite_size": len(hidden_suite),
        },
    )
