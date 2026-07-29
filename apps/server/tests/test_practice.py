"""`GET /api/practice/next`, `POST /api/practice/replenish` (PLAN_BACKEND.md §9, §14 Phase 4).

Real Postgres, real auth verification via the httpx client against the real app."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

import pytest

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
        """
        INSERT INTO generation_jobs (user_id, status, phase, repair_count)
        VALUES ($1, 'building', 'drafting', 1)
        """,
        user_id,
    )
    resp = await authed_client.get("/api/practice/next", headers=_headers(str(user_id)))
    body = resp.json()
    assert body["state"] == "generating"
    assert body["job"]["status"] == "building"
    assert body["job"]["phase"] == "drafting"
    assert body["job"]["repair_count"] == 1
    assert body["job"]["attempt"] == 2
    assert body["job"]["max_attempts"] == 2
    assert body["job"]["job_id"]
    assert body["job"]["started_at"]
    assert body["job"]["phase_started_at"]


async def test_next_prefers_the_claimed_job_over_a_waiting_reserve(authed_client, pool):
    user_id = uuid.uuid4()
    waiting_id = await pool.fetchval(
        """
        INSERT INTO generation_jobs (user_id, status, phase, created_at)
        VALUES ($1, 'queued', 'waiting', now())
        RETURNING id
        """,
        user_id,
    )
    claimed_id = await pool.fetchval(
        """
        INSERT INTO generation_jobs (
          user_id, status, phase, created_at, claimed_at, lease_token
        )
        VALUES (
          $1, 'building', 'drafting', now() - interval '1 second', now(), $2
        )
        RETURNING id
        """,
        user_id,
        uuid.uuid4(),
    )

    resp = await authed_client.get("/api/practice/next", headers=_headers(str(user_id)))

    assert resp.status_code == 200
    assert resp.json()["job"]["job_id"] == str(claimed_id)
    assert resp.json()["job"]["job_id"] != str(waiting_id)
    assert resp.json()["job"]["phase"] == "drafting"


@pytest.mark.parametrize(
    ("phase", "status"),
    [
        ("waiting", "queued"),
        ("selecting", "planning"),
        ("drafting", "building"),
        ("independent_review", "building"),
        ("checking_examples", "verifying"),
        ("stress_testing", "verifying"),
        ("repairing", "building"),
        ("finalizing", "verifying"),
    ],
)
async def test_next_reconciles_every_live_detailed_phase(
    authed_client, pool, phase: str, status: str
):
    user_id = uuid.uuid4()
    await pool.execute(
        """
        INSERT INTO generation_jobs (user_id, status, phase)
        VALUES ($1, $2, $3)
        """,
        user_id,
        status,
        phase,
    )

    resp = await authed_client.get("/api/practice/next", headers=_headers(str(user_id)))

    assert resp.status_code == 200
    assert resp.json()["job"]["phase"] == phase


async def test_next_returns_active_problem_stub_never_the_statement(authed_client, pool):
    user_id = uuid.uuid4()
    problem_id = await insert_problem(pool, user_id, served_at=None)

    resp = await authed_client.get("/api/practice/next", headers=_headers(str(user_id)))
    body = resp.json()
    assert body["state"] == "active"
    assert body["problem_id"] == str(problem_id)
    assert body["opened"] is False
    assert "statement_md" not in body  # amendments 36/41: stub only, never the statement

    await pool.execute("UPDATE problems SET served_at = now() WHERE id = $1", problem_id)
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


async def test_next_reports_terminal_failure_with_only_a_safe_code(authed_client, pool):
    user_id = uuid.uuid4()
    await pool.execute(
        """
        INSERT INTO generation_jobs (
          user_id, status, phase, failure_code, error
        ) VALUES (
          $1, 'failed', 'failed', 'verification_failed',
          'private args=[[secret]] expected=123 traceback=do-not-expose'
        )
        """,
        user_id,
    )

    resp = await authed_client.get("/api/practice/next", headers=_headers(str(user_id)))
    body = resp.json()

    assert body["state"] == "generation_failed"
    assert body["job"]["failure_code"] == "verification_failed"
    assert "error" not in body["job"]
    assert "secret" not in resp.text


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
