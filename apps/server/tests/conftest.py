from __future__ import annotations

import json
import os
import subprocess
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import asyncpg
import jwt
import pytest
from httpx import ASGITransport, AsyncClient

from leetmind.config import Settings, get_settings
from leetmind.db import assert_test_database, run_migrations
from leetmind.judge import JudgeClient

JUDGE_DIR = Path(__file__).resolve().parent.parent / "judge"
TEST_JWT_SECRET = "test-jwt-secret-for-leetmind-tests-only"  # HS256, never a real project secret

# A minimal, fixed problem shape for Phase 4 route tests (PLAN_BACKEND.md §14 Phase 4): a single
# int -> int function, so the same fixture code can be exercised by the real judge without any
# LLM/generation pipeline involvement.
PROBLEM_SIGNATURE = {
    "func_name": "solve",
    "params": [{"name": "x", "type": {"kind": "int", "nullable": False, "list_depth": 0}}],
    "returns": {"kind": "int", "nullable": False, "list_depth": 0},
    "order_insensitive": False,
}
PROBLEM_PUBLIC_TESTS = [{"args": [1], "expected": 2}, {"args": [2], "expected": 3}]
PROBLEM_PRIVATE_TESTS = [{"args": [3], "expected": 4}, {"args": [4], "expected": 5}]
PROBLEM_HINTS = ["orientation hint", "conceptual hint", "structural hint", "outline hint"]
PROBLEM_REFERENCE_SOLUTION = "def solve(x):\n    return x + 1\n"
PROBLEM_STARTER_CODE = "def solve(x):\n    pass\n"


async def insert_problem(
    pool: Any,
    user_id: uuid.UUID,
    *,
    status: str = "active",
    served_at: datetime | None = None,
    resolved_at: datetime | None = None,
    primary_type: str = "arrays_hashing",
    support_types: list[str] | None = None,
    shape: str = "optimize_subarray",
    problem_rating: int = 1200,
    is_probe: bool = False,
    title: str = "Add One",
    reference_solution: str = PROBLEM_REFERENCE_SOLUTION,
    par_minutes: int = 5,
) -> uuid.UUID:
    """Inserts a fully-formed problem row directly (bypassing the generation pipeline) so
    Phase 4 route tests can exercise practice/problems/execution/hints without an LLM or a real
    generation job. Kept in one place so every Phase 4 test file shares the same fixture shape."""
    problem_id: uuid.UUID = await pool.fetchval(
        """
        INSERT INTO problems (
          user_id, status, primary_type, support_types, shape, problem_rating, is_probe,
          title, statement_md, signature, starter_code, public_tests, private_tests, hints,
          reference_solution, complexity, par_minutes, served_at, resolved_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
        ) RETURNING id
        """,
        user_id,
        status,
        primary_type,
        support_types or [],
        shape,
        problem_rating,
        is_probe,
        title,
        "Add one to x. Example: solve(1) == 2.",
        json.dumps(PROBLEM_SIGNATURE),
        PROBLEM_STARTER_CODE,
        json.dumps(PROBLEM_PUBLIC_TESTS),
        json.dumps(PROBLEM_PRIVATE_TESTS),
        json.dumps(PROBLEM_HINTS),
        reference_solution,
        json.dumps({"time": "O(1)", "space": "O(1)"}),
        par_minutes,
        served_at,
        resolved_at,
    )
    return problem_id


def make_access_token(user_id: str, *, email: str | None = "user@example.com") -> str:
    """A Supabase-shaped HS256 access token for `authed_client` tests (auth.py accepts HS256 when
    `supabase_jwt_secret` is set, PLAN_BACKEND.md §2 row 4)."""
    return jwt.encode(
        {"sub": user_id, "aud": "authenticated", "email": email},
        TEST_JWT_SECRET,
        algorithm="HS256",
    )


def _test_database_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL not set — see apps/server/.env.example")
    assert_test_database(url)
    return url


@pytest.fixture
async def pool():
    url = _test_database_url()
    conn = await asyncpg.connect(url)
    try:
        await conn.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
    finally:
        await conn.close()

    p = await asyncpg.create_pool(url, min_size=1, max_size=5)
    await run_migrations(p)
    try:
        yield p
    finally:
        await p.close()


@pytest.fixture(scope="session")
def judge_image() -> str:
    """Real Docker, not a mock (PLAN_BACKEND.md §12): builds the actual leetmind-judge image once
    per test session and hands back its tag. Skips the whole judge suite if Docker isn't
    reachable rather than failing every test with the same root cause."""
    try:
        subprocess.run(
            ["docker", "info"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        pytest.skip("docker daemon not reachable — see PLAN_BACKEND.md §12")

    result = subprocess.run(
        ["docker", "build", "-q", "-t", "leetmind-judge", str(JUDGE_DIR)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        pytest.fail(f"failed to build leetmind-judge image:\n{result.stderr}")
    return "leetmind-judge"


@pytest.fixture
def judge_client(judge_image: str) -> JudgeClient:
    settings = Settings(
        _env_file=None,
        judge_image=judge_image,
        judge_interactive_wall_s=15.0,
        judge_per_test_limit_s=2.0,
    )
    return JudgeClient(settings)


@pytest.fixture
async def client(pool):
    # `pool` already reset the schema and applied migrations; the app opens its own pool against
    # the same database via DATABASE_URL and finds nothing left to migrate. The generation worker
    # (PLAN_BACKEND.md §7.1) is disabled here — route-level tests don't need a live background
    # task polling the DB, and worker tests drive a `GenerationWorker` directly for deterministic
    # control (see test_worker.py).
    from leetmind.main import create_app

    os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]
    os.environ["WORKER_ENABLED"] = "false"
    get_settings.cache_clear()
    app = create_app()
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
    del os.environ["WORKER_ENABLED"]
    get_settings.cache_clear()


@pytest.fixture
async def authed_client(pool):
    # Same wiring as `client`, plus an HS256 secret so `make_access_token` tokens verify.
    from leetmind.main import create_app

    os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]
    os.environ["WORKER_ENABLED"] = "false"
    os.environ["SUPABASE_JWT_SECRET"] = TEST_JWT_SECRET
    get_settings.cache_clear()
    app = create_app()
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
    del os.environ["SUPABASE_JWT_SECRET"]
    del os.environ["WORKER_ENABLED"]
    get_settings.cache_clear()
