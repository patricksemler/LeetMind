"""End-to-end tests for the six-stage verification gate (CONTRACTS.md §10), against the REAL
sandbox (Docker + `algolift/runner-python:1`) and the REAL migrated Postgres schema.

This is the M2 "done when" criterion from PLAN.md §10: "a deliberately-broken candidate (wrong
reference, weak tests, surviving mutant) is rejected at the right stage with a stored report."
Each test below builds one deliberately-broken candidate and asserts it's rejected at the exact
stage responsible for catching that class of bug — not just "rejected somewhere".

Auto-skips (module-wide) when Docker/the sandbox bridge or Postgres aren't reachable.
"""

from __future__ import annotations

import copy
import threading
from datetime import UTC, datetime
from typing import Any

import pytest
from conftest import fresh_problem_version_content, postgres_reachable

from algolift_content.db import query_one
from algolift_content.queue import Job, WorkerContext
from algolift_content.sandbox import SandboxUnavailable, sandbox_probe
from algolift_content.verification import handle_verify, verify_problem_version
from algolift_content.verification.stage_schema import run as run_schema_stage

_sandbox_ok, _sandbox_reason = sandbox_probe()

pytestmark = [
    pytest.mark.skipif(
        not postgres_reachable(), reason="Postgres not reachable on TEST_DATABASE_URL"
    ),
    pytest.mark.skipif(not _sandbox_ok, reason=f"sandbox unavailable: {_sandbox_reason}"),
]


def _pv_state(version_id: str) -> dict[str, Any] | None:
    return query_one(
        "select state, rejected_reason, approved_at, content from problem_versions where id = %s",
        (version_id,),
    )


def _problem_concepts(version_id: str) -> list[dict[str, Any]]:
    from algolift_content.db import query

    return query(
        "select concept_id, role, weight from problem_concepts where problem_version_id = %s",
        (version_id,),
    )


def _verification_report_count(version_id: str) -> int:
    row = query_one(
        "select count(*) as n from verification_reports where problem_version_id = %s",
        (version_id,),
    )
    assert row is not None
    return int(row["n"])


# ---------------------------------------------------------------------------
# 1. Valid problem -> passes all six stages.
# ---------------------------------------------------------------------------


def test_valid_problem_passes_all_six_stages_and_approves(
    sample_problem_dict: dict[str, Any], make_problem_version: Any, fast_settings: Any
) -> None:
    content = fresh_problem_version_content(sample_problem_dict)
    version_id = make_problem_version(content)

    report = verify_problem_version(
        version_id, content=content, correlation_id="test-1", settings=fast_settings
    )

    assert report.passed is True
    assert report.failed_stage is None
    assert [s.stage for s in report.stages] == [
        "schema",
        "compile",
        "differential",
        "boundary",
        "examples",
        "mutation",
    ]
    assert all(s.status == "passed" for s in report.stages)
    assert len(report.seeds) == fast_settings.VERIFY_DIFFERENTIAL_CASES
    assert report.solution_hashes.keys() == {"reference", "brute", "generator"}

    row = _pv_state(version_id)
    assert row is not None
    assert row["state"] == "approved"
    assert row["approved_at"] is not None
    hidden_tests = row["content"]["hidden_tests"]
    assert len(hidden_tests) > 0
    assert len(hidden_tests) <= 60

    concepts = _problem_concepts(version_id)
    assert {c["concept_id"] for c in concepts} == {"sliding_window", "arrays_hashing"}


# ---------------------------------------------------------------------------
# 2. Banned hint vocabulary -> rejected at schema (plus the "adapt"/"dprint" non-false-positive
#    check, at the stage level rather than the unit level covered by
#    test_verification_banned_words.py).
# ---------------------------------------------------------------------------


def test_hint_l2_naming_sliding_window_rejected_at_schema(
    sample_problem_dict: dict[str, Any], make_problem_version: Any, fast_settings: Any
) -> None:
    content = fresh_problem_version_content(sample_problem_dict)
    content["hints"]["l2_conceptual"] = "This is a classic sliding window problem."
    version_id = make_problem_version(content)

    report = verify_problem_version(
        version_id, content=content, correlation_id="test-2", settings=fast_settings
    )

    assert report.passed is False
    assert report.failed_stage == "schema"
    row = _pv_state(version_id)
    assert row is not None
    assert row["state"] == "rejected"


def test_adapt_and_dprint_do_not_false_positive_at_schema_stage(
    sample_problem_dict: dict[str, Any],
) -> None:
    content = copy.deepcopy(sample_problem_dict)
    content["hints"]["l1_orientation"] = "Try to adapt your approach; you could even dprint(x)."
    content["hints"]["l2_conceptual"] = "Think about how the window adapts as you move along."

    result, parsed = run_schema_stage(content)

    assert result.status == "passed"
    assert parsed is not None


# ---------------------------------------------------------------------------
# 3. Reference solution that throws -> rejected at compile.
# ---------------------------------------------------------------------------


def test_reference_that_throws_rejected_at_compile(
    sample_problem_dict: dict[str, Any], make_problem_version: Any, fast_settings: Any
) -> None:
    content = fresh_problem_version_content(sample_problem_dict)
    content["reference_solution_py"] = (
        "def maxSumSubarray(nums, k):\n    raise RuntimeError('deliberately broken')\n"
    )
    version_id = make_problem_version(content)

    report = verify_problem_version(
        version_id, content=content, correlation_id="test-3", settings=fast_settings
    )

    assert report.passed is False
    assert report.failed_stage == "compile"
    row = _pv_state(version_id)
    assert row is not None and row["state"] == "rejected"


# ---------------------------------------------------------------------------
# 4. Reference disagrees with brute force -> rejected at differential, with a genuinely smaller
#    shrunk counterexample.
# ---------------------------------------------------------------------------


def test_reference_disagreeing_with_brute_force_rejected_at_differential_with_shrink(
    sample_problem_dict: dict[str, Any], make_problem_version: Any, fast_settings: Any
) -> None:
    content = fresh_problem_version_content(sample_problem_dict)
    # Deliberately off-by-one: wrong for EVERY valid input, so this is a deterministic (not
    # flaky) trigger regardless of what the generator happens to draw.
    content["reference_solution_py"] = (
        "def maxSumSubarray(nums, k):\n"
        "    n = len(nums)\n"
        "    if k <= 0 or k > n:\n"
        "        raise ValueError('invalid k')\n"
        "    window_sum = sum(nums[:k])\n"
        "    best = window_sum\n"
        "    for i in range(k, n):\n"
        "        window_sum += nums[i] - nums[i - k]\n"
        "        if window_sum > best:\n"
        "            best = window_sum\n"
        "    return best + 1\n"
    )
    version_id = make_problem_version(content)

    report = verify_problem_version(
        version_id, content=content, correlation_id="test-4", settings=fast_settings
    )

    assert report.passed is False
    assert report.failed_stage == "differential"
    assert report.counterexample is not None
    ce = report.counterexample
    assert ce["shrunk_size"] < ce["original_size"]
    # The bug fires on every valid input, so the fully-shrunk case should collapse to the
    # smallest legal shape: a single-element list with k=1.
    assert len(ce["shrunk_args"][0]) <= len(ce["original_args"][0])

    row = _pv_state(version_id)
    assert row is not None and row["state"] == "rejected"


# ---------------------------------------------------------------------------
# 5. Solution that breaks on an empty list -> rejected at boundary.
# ---------------------------------------------------------------------------


def _empty_list_edge_case_problem() -> dict[str, Any]:
    return {
        "problem_id": "placeholder",
        "version": 1,
        "title": "Sum of a List",
        "internal_name": "sum_of_a_list",
        "statement_md": "Given a list of integers `nums`, return the sum of its elements. An "
        "empty list sums to 0.",
        "constraints_md": "- `0 <= len(nums) <= 100`\n- `-1000 <= nums[i] <= 1000`",
        "signature": {
            "name": "sumList",
            "params": [{"name": "nums", "type": "list[int]"}],
            "returns": "int",
        },
        "examples": [
            {"args": [[1, 2, 3]], "expected": 6, "explanation": "1 + 2 + 3 = 6."},
        ],
        "concepts": [{"id": "arrays_hashing", "role": "primary", "weight": 1.0}],
        "difficulty": {"rating": 800, "confidence": "generated"},
        "expected_active_minutes": [2, 5],
        "target_complexity": {"time": "O(n)", "space": "O(1)"},
        # Broken: crashes on an empty list (`nums[0]` on an empty list raises IndexError).
        "reference_solution_py": (
            "def sumList(nums):\n"
            "    total = nums[0]\n"
            "    for x in nums[1:]:\n"
            "        total += x\n"
            "    return total\n"
        ),
        "brute_force_py": "def sumList(nums):\n    return sum(nums)\n",
        # Deliberately never draws an empty list, so this bug is invisible to differential and
        # can only be caught by the constraint-derived boundary case.
        "input_generator_py": (
            "def generate(rng):\n"
            "    n = rng.randint(1, 20)\n"
            "    nums = [rng.randint(-1000, 1000) for _ in range(n)]\n"
            "    return [nums]\n"
        ),
        "comparator": "exact",
        "checker_py": None,
        "hidden_tests": [],
        "mutants_py": [],
        "hints": {
            "l1_orientation": "Think about how you'd total up a collection of numbers.",
            "l2_conceptual": "Consider what running total looks like as you go one at a time.",
            "l3_structural": "Keep an accumulator starting at zero and add each element to it.",
            "outline": "1) Start a running total at 0.\n2) Add each element to the total.\n"
            "3) Return the total.",
            "editorial_md": "## Approach\n\nSum every element with a running total.\n\n"
            "## Complexity\n\n- Time: O(n)\n- Space: O(1)",
        },
        "provenance": {
            "mode": "novel",
            "model": "fixture",
            "prompt_version": "v1",
            "generated_at": "2026-01-01T00:00:00Z",
        },
        "state": "candidate",
    }


def test_solution_that_breaks_on_empty_list_rejected_at_boundary(
    make_problem_version: Any, fast_settings: Any
) -> None:
    content = fresh_problem_version_content(_empty_list_edge_case_problem())
    version_id = make_problem_version(content)

    report = verify_problem_version(
        version_id, content=content, correlation_id="test-5", settings=fast_settings
    )

    assert report.passed is False
    assert report.failed_stage == "boundary"
    row = _pv_state(version_id)
    assert row is not None and row["state"] == "rejected"


# ---------------------------------------------------------------------------
# 6. A stated example whose `expected` is wrong -> rejected at examples.
# ---------------------------------------------------------------------------


def test_wrong_example_expected_rejected_at_examples(
    sample_problem_dict: dict[str, Any], make_problem_version: Any, fast_settings: Any
) -> None:
    content = fresh_problem_version_content(sample_problem_dict)
    assert content["examples"][0]["expected"] == 9
    content["examples"][0]["expected"] = 999  # actually 9, per the reference solution
    version_id = make_problem_version(content)

    report = verify_problem_version(
        version_id, content=content, correlation_id="test-6", settings=fast_settings
    )

    assert report.passed is False
    assert report.failed_stage == "examples"
    examples_stage = next(s for s in report.stages if s.stage == "examples")
    mismatch = examples_stage.details["mismatches"][0]
    assert mismatch["example_index"] == 0
    assert mismatch["expected"] == 999
    assert mismatch["actual"] == 9

    row = _pv_state(version_id)
    assert row is not None and row["state"] == "rejected"


# ---------------------------------------------------------------------------
# 7. A mutant the hidden suite fails to kill -> rejected at mutation, naming the survivor.
# ---------------------------------------------------------------------------


def test_surviving_mutant_rejected_at_mutation(
    sample_problem_dict: dict[str, Any], make_problem_version: Any, fast_settings: Any
) -> None:
    content = fresh_problem_version_content(sample_problem_dict)
    # An exact duplicate of the reference is behaviourally indistinguishable from it — it will
    # survive ANY hidden suite, no matter how strong, so this is a deterministic trigger.
    content["mutants_py"] = [content["reference_solution_py"]]
    version_id = make_problem_version(content)

    report = verify_problem_version(
        version_id, content=content, correlation_id="test-7", settings=fast_settings
    )

    assert report.passed is False
    assert report.failed_stage == "mutation"
    mutation_stage = next(s for s in report.stages if s.stage == "mutation")
    assert mutation_stage.details["survivors"][0]["mutant_index"] == 0

    row = _pv_state(version_id)
    assert row is not None and row["state"] == "rejected"


# ---------------------------------------------------------------------------
# 8. Idempotency: re-running verification on an already-terminal version returns the existing
#    report instead of re-verifying.
# ---------------------------------------------------------------------------


def test_reverifying_an_approved_version_is_idempotent(
    sample_problem_dict: dict[str, Any], make_problem_version: Any, fast_settings: Any
) -> None:
    content = fresh_problem_version_content(sample_problem_dict)
    version_id = make_problem_version(content)

    first = verify_problem_version(
        version_id, content=content, correlation_id="test-8a", settings=fast_settings
    )
    assert first.passed is True
    assert _verification_report_count(version_id) == 1

    second = verify_problem_version(
        version_id, content=content, correlation_id="test-8b", settings=fast_settings
    )

    assert second.id == first.id
    assert second.passed == first.passed
    # No second report was written, and the original correlation_id (from the run that actually
    # verified) is preserved rather than overwritten by the no-op re-run's.
    assert second.correlation_id == "test-8a"
    assert _verification_report_count(version_id) == 1


def test_reverifying_a_rejected_version_is_idempotent(
    sample_problem_dict: dict[str, Any], make_problem_version: Any, fast_settings: Any
) -> None:
    content = fresh_problem_version_content(sample_problem_dict)
    content["reference_solution_py"] = (
        "def maxSumSubarray(nums, k):\n    raise RuntimeError('deliberately broken')\n"
    )
    version_id = make_problem_version(content)

    first = verify_problem_version(
        version_id, content=content, correlation_id="test-8c", settings=fast_settings
    )
    assert first.passed is False

    second = verify_problem_version(
        version_id, content=content, correlation_id="test-8d", settings=fast_settings
    )
    assert second.id == first.id
    assert _verification_report_count(version_id) == 1


# ---------------------------------------------------------------------------
# 9. handle_verify: acks (doesn't raise) on a legitimate rejection; raises on infra failure.
# ---------------------------------------------------------------------------


def _make_job(problem_version_id: str, correlation_id: str) -> Job:
    now = datetime.now(UTC)
    return Job(
        id="01JJOBIDXXXXXXXXXXXXXXXXXX",
        kind="verify",
        priority=50,
        payload={"problem_version_id": problem_version_id, "correlation_id": correlation_id},
        status="leased",
        attempts=1,
        max_attempts=3,
        run_at=now,
        lease_expires_at=None,
        leased_by="test-worker",
        last_error=None,
        idempotency_key=f"verify:{problem_version_id}",
        correlation_id=correlation_id,
        created_at=now,
        updated_at=now,
    )


def _make_ctx() -> WorkerContext:
    return WorkerContext(stop_event=threading.Event(), heartbeat=lambda: True, logger=None)


def test_handle_verify_acks_on_legitimate_rejection(
    sample_problem_dict: dict[str, Any], make_problem_version: Any
) -> None:
    content = fresh_problem_version_content(sample_problem_dict)
    content["reference_solution_py"] = (
        "def maxSumSubarray(nums, k):\n    raise RuntimeError('deliberately broken')\n"
    )
    version_id = make_problem_version(content)
    job = _make_job(version_id, "test-9a")

    # Must NOT raise: a genuine rejection is a successful job outcome.
    handle_verify(job, _make_ctx())

    row = _pv_state(version_id)
    assert row is not None and row["state"] == "rejected"


def test_handle_verify_raises_on_missing_problem_version_row() -> None:
    job = _make_job("01NONEXISTENTVERSIONIDXXXXX", "test-9b")
    with pytest.raises(RuntimeError):
        handle_verify(job, _make_ctx())


def test_handle_verify_raises_on_infrastructure_failure(
    sample_problem_dict: dict[str, Any], make_problem_version: Any, monkeypatch: Any
) -> None:
    content = fresh_problem_version_content(sample_problem_dict)
    version_id = make_problem_version(content)
    job = _make_job(version_id, "test-9c")

    def _boom(*args: Any, **kwargs: Any) -> Any:
        raise SandboxUnavailable("simulated docker outage")

    monkeypatch.setattr("algolift_content.verification.worker.verify_problem_version", _boom)

    with pytest.raises(SandboxUnavailable):
        handle_verify(job, _make_ctx())
