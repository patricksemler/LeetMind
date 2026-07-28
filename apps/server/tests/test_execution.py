"""`POST /api/problems/{id}/run`, `/submit`, `/give-up` (PLAN_BACKEND.md §8.3, §9, §14 Phase 4).

The run/submit tests exercise the real judge (Docker), like test_judge.py — `judge_image` builds
the `leetmind-judge` tag the app's own `JudgeClient` defaults to, so the full FastAPI app (built
by `authed_client`) talks to the same image. give-up and the in-flight guard need neither Docker
nor an LLM.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from fastapi import HTTPException
from starlette.datastructures import State

from leetmind.routes.execution import _acquire_inflight, _release_inflight

from .conftest import insert_problem, make_access_token

CORRECT_CODE = "def solve(x):\n    return x + 1\n"
PUBLIC_FAILING_CODE = "def solve(x):\n    return x\n"  # wrong on every case
PRIVATE_FAILING_CODE = (  # public ok, private wrong
    "def solve(x):\n    return x + 1 if x < 3 else 99\n"
)


def _headers(user_id: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_access_token(user_id)}"}


class _FakeApp:
    def __init__(self) -> None:
        self.state = State()
        self.state.judge_inflight = set()


class _FakeRequest:
    def __init__(self, app: _FakeApp) -> None:
        self.app = app


def test_inflight_guard_blocks_a_second_acquire_for_the_same_user():
    request = _FakeRequest(_FakeApp())
    user_id = uuid.uuid4()

    _acquire_inflight(request, user_id)
    with pytest.raises(HTTPException) as exc_info:
        _acquire_inflight(request, user_id)
    assert exc_info.value.status_code == 409

    _release_inflight(request, user_id)
    _acquire_inflight(request, user_id)  # works again once released


async def test_run_requires_opened_and_active(authed_client, pool):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(pool, user_id, served_at=None)

    resp = await authed_client.post(
        f"/api/problems/{problem_id}/run",
        json={"code": CORRECT_CODE},
        headers=_headers(str(user_id)),
    )
    assert resp.status_code == 409


async def test_run_executes_public_tests_and_records_a_run_execution(
    authed_client, pool, judge_image
):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(pool, user_id, served_at=datetime.now(UTC))

    resp = await authed_client.post(
        f"/api/problems/{problem_id}/run",
        json={"code": CORRECT_CODE},
        headers=_headers(str(user_id)),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["passed"] is True
    assert len(body["results"]) == 2

    row = await pool.fetchrow(
        "SELECT kind, passed FROM executions WHERE problem_id = $1", problem_id
    )
    assert row["kind"] == "run"
    assert row["passed"] is True

    problem_status = await pool.fetchval("SELECT status FROM problems WHERE id = $1", problem_id)
    assert problem_status == "active"  # a plain Run never resolves anything


async def test_submit_public_failure_demotes_to_run(authed_client, pool, judge_image):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(pool, user_id, served_at=datetime.now(UTC))

    resp = await authed_client.post(
        f"/api/problems/{problem_id}/submit",
        json={"code": PUBLIC_FAILING_CODE},
        headers=_headers(str(user_id)),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "run"
    assert body["passed"] is False
    assert body["solved"] is False

    row = await pool.fetchrow(
        "SELECT kind, passed FROM executions WHERE problem_id = $1", problem_id
    )
    assert row["kind"] == "run"  # demoted, not recorded as a submission

    problem_status = await pool.fetchval("SELECT status FROM problems WHERE id = $1", problem_id)
    assert problem_status == "active"


async def test_submit_private_failure_reveals_the_failing_case(authed_client, pool, judge_image):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(pool, user_id, served_at=datetime.now(UTC))

    resp = await authed_client.post(
        f"/api/problems/{problem_id}/submit",
        json={"code": PRIVATE_FAILING_CODE},
        headers=_headers(str(user_id)),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "submit"
    assert body["passed"] is False
    assert body["failing_case"] == {"input": [3], "expected": 4, "actual": 99}

    row = await pool.fetchrow(
        "SELECT kind, passed FROM executions WHERE problem_id = $1", problem_id
    )
    assert row["kind"] == "submit"
    assert row["passed"] is False

    problem_status = await pool.fetchval("SELECT status FROM problems WHERE id = $1", problem_id)
    assert problem_status == "active"  # a failed submission isn't a resolution


async def test_submit_all_pass_solves_and_returns_rating_update(authed_client, pool, judge_image):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(pool, user_id, served_at=datetime.now(UTC))

    resp = await authed_client.post(
        f"/api/problems/{problem_id}/submit",
        json={"code": CORRECT_CODE},
        headers=_headers(str(user_id)),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "submit"
    assert body["passed"] is True
    assert body["solved"] is True
    ru = body["rating_update"]
    assert ru["type_slug"] == "arrays_hashing"
    assert ru["rating_after"] > ru["rating_before"]

    problem_status = await pool.fetchval("SELECT status FROM problems WHERE id = $1", problem_id)
    assert problem_status == "solved"

    # resubmitting a resolved problem is a conflict, not a second Elo update
    again = await authed_client.post(
        f"/api/problems/{problem_id}/submit",
        json={"code": CORRECT_CODE},
        headers=_headers(str(user_id)),
    )
    assert again.status_code == 409


async def test_give_up_returns_reference_solution_and_zero_performance(authed_client, pool):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(pool, user_id, served_at=datetime.now(UTC))

    resp = await authed_client.post(
        f"/api/problems/{problem_id}/give-up", headers=_headers(str(user_id))
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["reference_solution"]
    assert body["rating_update"]["performance_score"] == 0.0
    assert body["rating_update"]["rating_after"] < body["rating_update"]["rating_before"]

    problem_status = await pool.fetchval("SELECT status FROM problems WHERE id = $1", problem_id)
    assert problem_status == "given_up"

    again = await authed_client.post(
        f"/api/problems/{problem_id}/give-up", headers=_headers(str(user_id))
    )
    assert again.status_code == 409


async def test_code_over_the_size_cap_is_rejected(authed_client, pool):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(pool, user_id, served_at=datetime.now(UTC))

    resp = await authed_client.post(
        f"/api/problems/{problem_id}/run",
        json={"code": "x" * 70_000},
        headers=_headers(str(user_id)),
    )
    assert resp.status_code == 422
