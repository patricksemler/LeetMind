"""API-level test for ratings lazy-init and `GET /api/me` (PLAN_BACKEND.md §4, §9, §14 Phase 2
accept criteria). Real Postgres, real auth verification — the httpx client hits the real app."""

from __future__ import annotations

import uuid

from leetmind.taxonomy import DEFAULT_RATING, PROBLEM_TYPES

from .conftest import make_access_token


async def test_me_requires_auth(client):
    resp = await client.get("/api/me")
    assert resp.status_code == 401


async def test_me_lazily_creates_all_types_at_default_rating(authed_client):
    user_id = str(uuid.uuid4())
    token = make_access_token(user_id)

    resp = await authed_client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    body = resp.json()

    assert [t["slug"] for t in body["types"]] == list(PROBLEM_TYPES)  # taxonomy-ordinal order
    for t in body["types"]:
        assert t["rating"] == DEFAULT_RATING
        assert t["attempts"] == 0
        assert t["evidenced"] is False


async def test_me_is_idempotent_and_scoped_per_user(authed_client):
    user_a = str(uuid.uuid4())
    user_b = str(uuid.uuid4())

    first = await authed_client.get(
        "/api/me", headers={"Authorization": f"Bearer {make_access_token(user_a)}"}
    )
    second = await authed_client.get(
        "/api/me", headers={"Authorization": f"Bearer {make_access_token(user_a)}"}
    )
    assert first.json() == second.json()

    other = await authed_client.get(
        "/api/me", headers={"Authorization": f"Bearer {make_access_token(user_b)}"}
    )
    assert len(other.json()["types"]) == len(PROBLEM_TYPES)
