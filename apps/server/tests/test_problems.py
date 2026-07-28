"""`GET /api/problems/{id}`, `POST /api/problems/{id}/open` (PLAN_BACKEND.md §9, §14 Phase 4).

Real Postgres, real auth. No Docker/LLM needed — problems are inserted directly via
`insert_problem` (conftest.py)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from leetmind.routes.problems import _description_only, _legacy_constraints

from .conftest import insert_problem, make_access_token


def _headers(user_id: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_access_token(user_id)}"}


def test_legacy_statement_sections_are_split_for_display():
    statement = """\
Return the longest valid span.

### Example 1
input = [1, 2]
output = 2

### Constraints
- `1 <= nums.length <= 100`
- `0 <= nums[i] <= 10`
"""
    assert _description_only(statement) == "Return the longest valid span."
    assert _legacy_constraints(statement) == [
        "1 <= nums.length <= 100",
        "0 <= nums[i] <= 10",
    ]


async def test_get_problem_requires_auth(client):
    resp = await client.get(f"/api/problems/{uuid.uuid4()}")
    assert resp.status_code == 401


async def test_foreign_problem_id_is_404(authed_client, pool):
    owner = uuid.uuid4()
    stranger = str(uuid.uuid4())
    problem_id = await insert_problem(pool, owner, served_at=datetime.now(UTC))

    resp = await authed_client.get(f"/api/problems/{problem_id}", headers=_headers(stranger))
    assert resp.status_code == 404


async def test_unopened_problem_is_409(authed_client, pool):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(pool, user_id, served_at=None)

    resp = await authed_client.get(
        f"/api/problems/{problem_id}", headers=_headers(str(user_id))
    )
    assert resp.status_code == 409


async def test_open_stamps_served_at_once_and_is_idempotent(authed_client, pool):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(pool, user_id, served_at=None)

    first = await authed_client.post(
        f"/api/problems/{problem_id}/open", headers=_headers(str(user_id))
    )
    assert first.status_code == 200
    served_at_1 = first.json()["served_at"]
    assert served_at_1 is not None

    second = await authed_client.post(
        f"/api/problems/{problem_id}/open", headers=_headers(str(user_id))
    )
    assert second.json()["served_at"] == served_at_1  # unchanged on repeat calls


async def test_unresolved_problem_view_never_leaks_private_fields(authed_client, pool):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(pool, user_id, served_at=datetime.now(UTC))

    resp = await authed_client.get(
        f"/api/problems/{problem_id}", headers=_headers(str(user_id))
    )
    body = resp.json()
    assert "private_tests" not in body
    assert "reference_solution" not in body
    assert "hints" not in body  # only revealed_hints is present pre-resolution
    assert body["revealed_hints"] == []
    assert len(body["public_tests"]) == 2
    assert body["constraints"] == ["-100 <= x <= 100"]


async def test_resolved_problem_view_includes_reference_and_private_tests(authed_client, pool):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(
        pool,
        user_id,
        status="solved",
        served_at=datetime.now(UTC),
        resolved_at=datetime.now(UTC),
    )

    resp = await authed_client.get(
        f"/api/problems/{problem_id}", headers=_headers(str(user_id))
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["reference_solution"]
    assert len(body["private_tests"]) == 2
    assert len(body["hints"]) == 4
    assert "revealed_hints" not in body


async def test_revealed_hints_reflects_only_revealed_rungs(authed_client, pool):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(pool, user_id, served_at=datetime.now(UTC))
    await pool.execute(
        "INSERT INTO hint_reveals (problem_id, rung) VALUES ($1, 1), ($1, 2)", problem_id
    )

    resp = await authed_client.get(
        f"/api/problems/{problem_id}", headers=_headers(str(user_id))
    )
    body = resp.json()
    assert body["revealed_hints"] == ["orientation hint", "conceptual hint"]
