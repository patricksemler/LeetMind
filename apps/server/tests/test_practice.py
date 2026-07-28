"""`GET /api/practice/next`, `POST /api/practice/replenish` (PLAN_BACKEND.md §9, §14 Phase 4).

Real Postgres, real auth verification via the httpx client against the real app."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

from .conftest import insert_problem, make_access_token


def _headers(user_id: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_access_token(user_id)}"}


async def test_next_requires_auth(client):
    resp = await client.get("/api/practice/next")
    assert resp.status_code == 401


async def test_next_is_stalled_for_a_brand_new_user(authed_client):
    user_id = str(uuid.uuid4())
    resp = await authed_client.get("/api/practice/next", headers=_headers(user_id))
    assert resp.status_code == 200
    assert resp.json() == {"state": "stalled", "problem_id": None, "opened": False, "job": None}


async def test_next_reports_a_live_generating_job(authed_client, pool):
    user_id = uuid.uuid4()
    await pool.execute(
        "INSERT INTO generation_jobs (user_id, status, repair_count) VALUES ($1, 'building', 1)",
        user_id,
    )
    resp = await authed_client.get("/api/practice/next", headers=_headers(str(user_id)))
    body = resp.json()
    assert body["state"] == "generating"
    assert body["job"] == {"status": "building", "repair_count": 1}


async def test_next_returns_active_problem_stub_never_the_statement(authed_client, pool):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(pool, user_id, served_at=None)

    resp = await authed_client.get("/api/practice/next", headers=_headers(str(user_id)))
    body = resp.json()
    assert body["state"] == "active"
    assert body["problem_id"] == str(problem_id)
    assert body["opened"] is False
    assert "statement_md" not in body  # amendments 36/41: stub only, never the statement

    await pool.execute(
        "UPDATE problems SET served_at = now() WHERE id = $1", problem_id
    )
    resp2 = await authed_client.get("/api/practice/next", headers=_headers(str(user_id)))
    assert resp2.json()["opened"] is True


async def test_next_performs_no_writes(authed_client, pool):
    user_id = uuid.uuid4()
    await insert_problem(pool, user_id, served_at=datetime.now(UTC))

    before_ratings = await pool.fetchval("SELECT COUNT(*) FROM ratings WHERE user_id = $1", user_id)
    before_problems = await pool.fetchval(
        "SELECT COUNT(*) FROM problems WHERE user_id = $1", user_id
    )
    before_jobs = await pool.fetchval(
        "SELECT COUNT(*) FROM generation_jobs WHERE user_id = $1", user_id
    )

    for _ in range(3):
        resp = await authed_client.get("/api/practice/next", headers=_headers(str(user_id)))
        assert resp.status_code == 200

    assert (
        await pool.fetchval("SELECT COUNT(*) FROM ratings WHERE user_id = $1", user_id)
    ) == before_ratings
    assert (
        await pool.fetchval("SELECT COUNT(*) FROM problems WHERE user_id = $1", user_id)
    ) == before_problems
    assert (
        await pool.fetchval("SELECT COUNT(*) FROM generation_jobs WHERE user_id = $1", user_id)
    ) == before_jobs


async def test_replenish_bootstraps_two_jobs_and_is_idempotent(authed_client, pool):
    user_id = str(uuid.uuid4())
    first = await authed_client.post("/api/practice/replenish", headers=_headers(user_id))
    assert first.status_code == 200
    assert len(first.json()["created"]) == 2

    second = await authed_client.post("/api/practice/replenish", headers=_headers(user_id))
    assert second.json()["created"] == []


async def test_concurrent_replenishes_produce_no_duplicate_jobs(authed_client, pool):
    user_id = str(uuid.uuid4())
    responses = await asyncio.gather(
        authed_client.post("/api/practice/replenish", headers=_headers(user_id)),
        authed_client.post("/api/practice/replenish", headers=_headers(user_id)),
    )
    assert all(r.status_code == 200 for r in responses)
    total_created = sum(len(r.json()["created"]) for r in responses)
    assert total_created == 2  # the advisory lock serializes the two requests

    live_jobs = await pool.fetchval(
        "SELECT COUNT(*) FROM generation_jobs WHERE user_id = $1", uuid.UUID(user_id)
    )
    assert live_jobs == 2
