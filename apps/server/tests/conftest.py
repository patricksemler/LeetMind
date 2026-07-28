from __future__ import annotations

import os
import subprocess
from pathlib import Path

import asyncpg
import pytest
from httpx import ASGITransport, AsyncClient

from leetmind.config import Settings, get_settings
from leetmind.db import assert_test_database, run_migrations
from leetmind.judge import JudgeClient

JUDGE_DIR = Path(__file__).resolve().parent.parent / "judge"


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
    # the same database via DATABASE_URL and finds nothing left to migrate.
    from leetmind.main import create_app

    os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]
    get_settings.cache_clear()
    app = create_app()
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
    get_settings.cache_clear()
