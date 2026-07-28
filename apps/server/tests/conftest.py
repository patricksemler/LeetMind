from __future__ import annotations

import os

import asyncpg
import pytest
from httpx import ASGITransport, AsyncClient

from leetmind.config import get_settings
from leetmind.db import assert_test_database, run_migrations


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
