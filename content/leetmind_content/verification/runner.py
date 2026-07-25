"""The six-stage verification gate orchestrator (CONTRACTS.md §10).

`verify_problem_version` runs the six stages in order, short-circuiting on the first failure,
accumulates `StageResult`s into one `VerificationReport`, and persists the outcome transactionally:

- On success: writes the built hidden suite into `problem_versions.content->hidden_tests`,
  `problem_versions.state='approved'`, `approved_at=now()`, and populates `problem_concepts`
  from `content.concepts`.
- On failure: `problem_versions.state='rejected'`, `rejected_reason` set to a short description
  of the failing stage.
- Always writes exactly one `verification_reports` row.
- Idempotent: if `version_id` is already in a terminal state (`approved`/`rejected`) when this is
  called, the existing report is returned unchanged rather than re-verifying.

Execution of reference/brute-force/mutant/generator code always goes through
`leetmind_content.sandbox` / `leetmind_content.codegen` (never imported/exec'd in this process —
PLAN.md §3).
"""

from __future__ import annotations

import hashlib
import time
from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Json

from leetmind_content.config import Settings, get_settings
from leetmind_content.db import query_one, transaction
from leetmind_content.logging import get_logger
from leetmind_content.models import ProblemVersion, StageResult, TestCase, VerificationReport
from leetmind_content.sandbox import SandboxLimits
from leetmind_content.verification import (
    stage_boundary,
    stage_compile,
    stage_differential,
    stage_examples,
    stage_mutation,
    stage_schema,
)
from leetmind_content.verification.hidden_suite import build_hidden_suite

log = get_logger("content-verify-runner")

_TERMINAL_STATES = ("approved", "rejected")


class _ShortCircuit(Exception):
    def __init__(self, stage: str) -> None:
        super().__init__(stage)
        self.stage = stage


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _report_from_row(row: dict[str, Any]) -> VerificationReport:
    stages_raw = row["stages"] if isinstance(row["stages"], list) else []
    return VerificationReport(
        id=row["id"],
        problem_version_id=row["problem_version_id"],
        passed=row["passed"],
        failed_stage=row.get("failed_stage"),
        stages=[StageResult.model_validate(s) for s in stages_raw],
        seeds=row.get("seeds") or [],
        counterexample=row.get("counterexample"),
        solution_hashes=row.get("solution_hashes") or {},
        duration_ms=row.get("duration_ms"),
        correlation_id=row.get("correlation_id"),
        created_at=row["created_at"],
    )


_REPORT_COLUMNS = """
    id, problem_version_id, passed, failed_stage, stages, seeds,
    counterexample, solution_hashes, duration_ms, correlation_id, created_at
"""


def _latest_report_row(version_id: str, conn: Any) -> dict[str, Any] | None:
    return query_one(
        f"""
        select {_REPORT_COLUMNS}
        from verification_reports
        where problem_version_id = %s
        order by created_at desc
        limit 1
        """,
        (version_id,),
        conn=conn,
    )


def _load_existing_terminal_report(version_id: str) -> VerificationReport | None:
    with transaction() as conn:
        row = query_one(
            "select state from problem_versions where id = %s", (version_id,), conn=conn
        )
        if row is None or row["state"] not in _TERMINAL_STATES:
            return None
        report_row = _latest_report_row(version_id, conn)
        if report_row is None:
            return None
    return _report_from_row(report_row)


def _rejected_reason(failed_stage: str, stages: list[StageResult]) -> str:
    for s in stages:
        if s.stage == failed_stage:
            reason = s.details.get("reason") if isinstance(s.details, dict) else None
            return f"{failed_stage}: {reason}" if reason else failed_stage
    return failed_stage


def _persist(
    version_id: str,
    problem: ProblemVersion | None,
    report: VerificationReport,
    hidden_suite: list[TestCase] | None,
) -> VerificationReport:
    with transaction() as conn:
        # Race guard: another worker may have concurrently verified (and terminalized) this same
        # version between our pre-check and now. `for update` blocks any concurrent verifier
        # until we commit, so at most one writer ever terminalizes a given version.
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "select state from problem_versions where id = %s for update", (version_id,)
            )
            row = cur.fetchone()
        if row is None:
            raise RuntimeError(f"problem_versions row not found for id={version_id!r}")
        current_state = row["state"]
        if current_state in _TERMINAL_STATES:
            report_row = _latest_report_row(version_id, conn)
            if report_row is not None:
                return _report_from_row(report_row)
            # Terminal state but somehow no report row — fall through and write ours anyway.

        with conn.cursor() as cur:
            cur.execute(
                """
                insert into verification_reports
                  (id, problem_version_id, passed, failed_stage, stages, seeds, counterexample,
                   solution_hashes, duration_ms, correlation_id)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    report.id,
                    version_id,
                    report.passed,
                    report.failed_stage,
                    Json([s.model_dump(mode="json") for s in report.stages]),
                    Json(report.seeds),
                    Json(report.counterexample) if report.counterexample is not None else None,
                    Json(report.solution_hashes),
                    report.duration_ms,
                    report.correlation_id,
                ),
            )

            if report.passed:
                assert problem is not None and hidden_suite is not None
                approved_problem = problem.model_copy(
                    update={"hidden_tests": hidden_suite, "state": "approved"}
                )
                cur.execute(
                    """
                    update problem_versions
                    set content = %s, state = 'approved', approved_at = now()
                    where id = %s
                    """,
                    (Json(approved_problem.model_dump(mode="json")), version_id),
                )
                cur.execute(
                    "delete from problem_concepts where problem_version_id = %s", (version_id,)
                )
                for concept in problem.concepts:
                    cur.execute(
                        """
                        insert into problem_concepts (problem_version_id, concept_id, role, weight)
                        values (%s, %s, %s, %s)
                        """,
                        (version_id, concept.id, concept.role, concept.weight),
                    )
            else:
                reason = _rejected_reason(report.failed_stage or "unknown", report.stages)
                cur.execute(
                    "update problem_versions set state = 'rejected', rejected_reason = %s "
                    "where id = %s",
                    (reason, version_id),
                )
    return report


def verify_problem_version(
    version_id: str,
    *,
    content: dict[str, Any] | ProblemVersion,
    correlation_id: str | None = None,
    settings: Settings | None = None,
) -> VerificationReport:
    """Runs the six-stage gate for `version_id` (whose candidate content is `content`) and
    persists the outcome. Idempotent: returns the existing report unchanged if `version_id` is
    already `approved`/`rejected`."""
    existing = _load_existing_terminal_report(version_id)
    if existing is not None:
        return existing

    s = settings or get_settings()
    limits = SandboxLimits.from_settings(s)

    started = time.monotonic()
    stages: list[StageResult] = []
    seeds: list[int] = []
    counterexample: dict[str, Any] | None = None
    solution_hashes: dict[str, str] = {}
    problem: ProblemVersion | None = None
    hidden_suite: list[TestCase] | None = None
    failed_stage: str | None = None

    def record(sr: StageResult) -> None:
        stages.append(sr)
        if sr.status != "passed":
            raise _ShortCircuit(sr.stage)

    try:
        sr1, parsed = stage_schema.run(content)
        record(sr1)
        problem = parsed
        assert problem is not None

        solution_hashes = {
            "reference": _sha256(problem.reference_solution_py),
            "brute": _sha256(problem.brute_force_py),
            "generator": _sha256(problem.input_generator_py),
        }
        comparator_spec: dict[str, Any] = {"kind": problem.comparator}

        sr2 = stage_compile.run(problem, limits=limits, comparator_spec=comparator_spec)
        record(sr2)

        sr3, diff_data = stage_differential.run(
            problem, limits=limits, comparator_spec=comparator_spec, settings=s
        )
        seeds = diff_data.get("seeds", [])
        if sr3.status != "passed":
            counterexample = diff_data.get("counterexample")
        record(sr3)
        random_cases: list[TestCase] = diff_data.get("verified_cases", [])

        sr4, boundary_data = stage_boundary.run(
            problem, limits=limits, comparator_spec=comparator_spec
        )
        if sr4.status != "passed":
            counterexample = boundary_data.get("counterexample")
        record(sr4)
        boundary_cases: list[TestCase] = boundary_data.get("verified_cases", [])

        sr5 = stage_examples.run(problem, limits=limits, comparator_spec=comparator_spec)
        record(sr5)

        hidden_suite = build_hidden_suite(problem, random_cases, boundary_cases)

        sr6 = stage_mutation.run(
            problem, hidden_suite, limits=limits, comparator_spec=comparator_spec
        )
        record(sr6)

    except _ShortCircuit as sc:
        failed_stage = sc.stage

    passed = failed_stage is None
    duration_ms = int((time.monotonic() - started) * 1000)

    report = VerificationReport(
        problem_version_id=version_id,
        passed=passed,
        failed_stage=failed_stage,
        stages=stages,
        seeds=seeds,
        counterexample=counterexample,
        solution_hashes=solution_hashes,
        duration_ms=duration_ms,
        correlation_id=correlation_id,
    )

    return _persist(version_id, problem, report, hidden_suite if passed else None)
