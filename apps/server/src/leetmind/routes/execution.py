"""`POST /api/problems/{id}/run`, `/submit`, `/give-up` (PLAN_BACKEND.md §8.3, §9).

Run and submit share one judge container per call (§8.1/§8.2): submit always runs the full public
suite first (never stopping early — "public failures never stop the stream", §8.2), and only
streams private tests, stopping at the first failure, if every public test passed. A process-local
per-user in-flight guard (§9, amendment 35's process-local scope) rejects a second concurrent
run/submit with 409 rather than racing two judge sessions for one user.
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, status

from leetmind.auth import AuthedUser, require_user
from leetmind.db import load_jsonb
from leetmind.elo import RatingUpdate
from leetmind.resolution import resolve_problem
from leetmind.routes.problems import require_problem
from leetmind.schemas import (
    CodeRequest,
    FailingCaseView,
    GiveUpResponse,
    RatingUpdateView,
    RunResponse,
    Signature,
    SubmitResponse,
    TestCase,
    TestOutcome,
    Verdict,
)

router = APIRouter(prefix="/api")


def _require_active_and_opened(problem: asyncpg.Record) -> None:
    if problem["served_at"] is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "not_opened")
    if problem["status"] != "active":
        raise HTTPException(status.HTTP_409_CONFLICT, "problem is not active")


def _test_cases(rows: list[dict[str, Any]], signature: Signature) -> list[TestCase]:
    return [
        TestCase(
            args=r["args"],
            expected=r["expected"],
            value_type=signature.returns,
            order_insensitive=signature.order_insensitive,
        )
        for r in rows
    ]


def _acquire_inflight(request: Request, user_id: uuid.UUID) -> None:
    inflight: set[uuid.UUID] = request.app.state.judge_inflight
    if user_id in inflight:
        raise HTTPException(status.HTTP_409_CONFLICT, "an execution is already in flight")
    inflight.add(user_id)


def _release_inflight(request: Request, user_id: uuid.UUID) -> None:
    request.app.state.judge_inflight.discard(user_id)


def _rating_update_view(primary_type: str, update: RatingUpdate) -> RatingUpdateView:
    return RatingUpdateView(
        type_slug=primary_type,
        rating_before=update.rating_before,
        rating_after=update.rating_after,
        delta=update.delta,
        problem_rating=update.problem_rating,
        expected_score=update.expected_score,
        performance_score=update.performance_score,
        k_factor=update.k_factor,
        metrics=update.metrics,
    )


async def _record_execution(
    pool: asyncpg.Pool,
    *,
    problem_id: uuid.UUID,
    user_id: uuid.UUID,
    kind: str,
    code: str,
    passed: bool,
    results: list[TestOutcome],
    duration_ms: int,
) -> None:
    await pool.execute(
        """
        INSERT INTO executions (problem_id, user_id, kind, code, passed, results, duration_ms)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        """,
        problem_id,
        user_id,
        kind,
        code,
        passed,
        json.dumps([o.model_dump(mode="json") for o in results]),
        duration_ms,
    )


@router.post("/problems/{problem_id}/run")
async def run_code(
    problem_id: uuid.UUID,
    body: CodeRequest,
    request: Request,
    user: AuthedUser = Depends(require_user),
    problem: asyncpg.Record = Depends(require_problem),
) -> RunResponse:
    _require_active_and_opened(problem)
    signature = Signature.model_validate(load_jsonb(problem["signature"]))
    public_tests = _test_cases(load_jsonb(problem["public_tests"]), signature)

    _acquire_inflight(request, user.id)
    started = time.monotonic()
    try:
        judge = request.app.state.judge
        outcomes: list[TestOutcome] = []
        async with judge.session(str(uuid.uuid4()), body.code, signature.func_name) as session:
            async for outcome in session.run(public_tests):
                outcomes.append(outcome)
    finally:
        _release_inflight(request, user.id)
    duration_ms = int((time.monotonic() - started) * 1000)

    passed = all(o.verdict == Verdict.PASS for o in outcomes)
    await _record_execution(
        request.app.state.pool,
        problem_id=problem_id,
        user_id=user.id,
        kind="run",
        code=body.code,
        passed=passed,
        results=outcomes,
        duration_ms=duration_ms,
    )
    return RunResponse(results=outcomes, passed=passed)


@router.post("/problems/{problem_id}/submit")
async def submit_code(
    problem_id: uuid.UUID,
    body: CodeRequest,
    request: Request,
    user: AuthedUser = Depends(require_user),
    problem: asyncpg.Record = Depends(require_problem),
) -> SubmitResponse:
    _require_active_and_opened(problem)
    signature = Signature.model_validate(load_jsonb(problem["signature"]))
    public_rows = load_jsonb(problem["public_tests"])
    private_rows = load_jsonb(problem["private_tests"])
    public_tests = _test_cases(public_rows, signature)
    private_tests = _test_cases(private_rows, signature)

    _acquire_inflight(request, user.id)
    started = time.monotonic()
    try:
        judge = request.app.state.judge
        public_outcomes: list[TestOutcome] = []
        private_outcomes: list[TestOutcome] = []
        async with judge.session(str(uuid.uuid4()), body.code, signature.func_name) as session:
            async for outcome in session.run(public_tests):
                public_outcomes.append(outcome)
            all_public_passed = all(o.verdict == Verdict.PASS for o in public_outcomes)
            if all_public_passed:
                async for outcome in session.run(private_tests):
                    private_outcomes.append(outcome)
                    if outcome.verdict != Verdict.PASS:
                        break  # §8.2: first private failure stops the stream
    finally:
        _release_inflight(request, user.id)
    duration_ms = int((time.monotonic() - started) * 1000)

    pool = request.app.state.pool

    if not all_public_passed:
        # §8.3: a public failure demotes the execution to a 'run' — no submission consequences.
        await _record_execution(
            pool,
            problem_id=problem_id,
            user_id=user.id,
            kind="run",
            code=body.code,
            passed=False,
            results=public_outcomes,
            duration_ms=duration_ms,
        )
        return SubmitResponse(kind="run", passed=False, results=public_outcomes)

    all_private_passed = len(private_outcomes) == len(private_tests) and all(
        o.verdict == Verdict.PASS for o in private_outcomes
    )

    await _record_execution(
        pool,
        problem_id=problem_id,
        user_id=user.id,
        kind="submit",
        code=body.code,
        passed=all_private_passed,
        results=public_outcomes + private_outcomes,
        duration_ms=duration_ms,
    )

    if not all_private_passed:
        failing = private_outcomes[-1]
        failing_test = private_rows[failing.index]
        return SubmitResponse(
            kind="submit",
            passed=False,
            results=public_outcomes,
            failing_case=FailingCaseView(
                input=failing_test["args"],
                expected=failing_test["expected"],
                actual=failing.value,
            ),
        )

    worker = request.app.state.worker
    outcome = await resolve_problem(
        pool, worker, user_id=user.id, problem_id=problem_id, gave_up=False
    )
    if outcome is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "problem already resolved")

    return SubmitResponse(
        kind="submit",
        passed=True,
        solved=True,
        results=public_outcomes,
        rating_update=_rating_update_view(problem["primary_type"], outcome.rating_update),
    )


@router.post("/problems/{problem_id}/give-up")
async def give_up(
    problem_id: uuid.UUID,
    request: Request,
    user: AuthedUser = Depends(require_user),
    problem: asyncpg.Record = Depends(require_problem),
) -> GiveUpResponse:
    _require_active_and_opened(problem)

    pool = request.app.state.pool
    worker = request.app.state.worker
    outcome = await resolve_problem(
        pool, worker, user_id=user.id, problem_id=problem_id, gave_up=True
    )
    if outcome is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "problem already resolved")

    return GiveUpResponse(
        reference_solution=problem["reference_solution"],
        rating_update=_rating_update_view(problem["primary_type"], outcome.rating_update),
    )
