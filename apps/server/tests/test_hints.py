"""`POST /api/problems/{id}/hints/{rung}` (PLAN_BACKEND.md §9, §14 Phase 4)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from .conftest import insert_problem, make_access_token


def _headers(user_id: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_access_token(user_id)}"}


async def test_reveal_hint_requires_opened(authed_client, pool):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(pool, user_id, served_at=None)

    resp = await authed_client.post(
        f"/api/problems/{problem_id}/hints/1", headers=_headers(str(user_id))
    )
    assert resp.status_code == 409


async def test_reveal_hint_out_of_order_is_rejected(authed_client, pool):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(pool, user_id, served_at=datetime.now(UTC))

    resp = await authed_client.post(
        f"/api/problems/{problem_id}/hints/2", headers=_headers(str(user_id))
    )
    assert resp.status_code == 409

    still_none = await pool.fetchval(
        "SELECT COUNT(*) FROM hint_reveals WHERE problem_id = $1", problem_id
    )
    assert still_none == 0


async def test_reveal_hints_in_order_returns_text_and_records_reveal(authed_client, pool):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(pool, user_id, served_at=datetime.now(UTC))
    headers = _headers(str(user_id))

    first = await authed_client.post(f"/api/problems/{problem_id}/hints/1", headers=headers)
    assert first.status_code == 200
    assert first.json() == {"rung": 1, "text": "orientation hint"}

    second = await authed_client.post(f"/api/problems/{problem_id}/hints/2", headers=headers)
    assert second.json() == {"rung": 2, "text": "conceptual hint"}

    revealed = await pool.fetch(
        "SELECT rung FROM hint_reveals WHERE problem_id = $1 ORDER BY rung", problem_id
    )
    assert [r["rung"] for r in revealed] == [1, 2]


async def test_reveal_hint_is_idempotent_on_repeat(authed_client, pool):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(pool, user_id, served_at=datetime.now(UTC))
    headers = _headers(str(user_id))

    await authed_client.post(f"/api/problems/{problem_id}/hints/1", headers=headers)
    repeat = await authed_client.post(f"/api/problems/{problem_id}/hints/1", headers=headers)
    assert repeat.status_code == 200
    assert repeat.json() == {"rung": 1, "text": "orientation hint"}

    count = await pool.fetchval(
        "SELECT COUNT(*) FROM hint_reveals WHERE problem_id = $1", problem_id
    )
    assert count == 1


async def test_reveal_hint_rung_out_of_range_is_422(authed_client, pool):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(pool, user_id, served_at=datetime.now(UTC))

    resp = await authed_client.post(
        f"/api/problems/{problem_id}/hints/5", headers=_headers(str(user_id))
    )
    assert resp.status_code == 422
