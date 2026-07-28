from __future__ import annotations

import logging
from pathlib import Path

import asyncpg

logger = logging.getLogger("leetmind.db")

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent.parent / "migrations"


async def create_pool(database_url: str) -> asyncpg.Pool:
    return await asyncpg.create_pool(database_url, min_size=1, max_size=10)


def assert_test_database(database_url: str) -> None:
    """Guard against a test run truncating a real database (see config.py's test_database_url).

    LeetMind is used daily; a test suite that pointed at the dev database by mistake would
    destroy real practice history, so every destructive fixture calls this first.
    """
    name = database_url.rsplit("/", 1)[-1].split("?", 1)[0]
    if name != "test" and not name.endswith("_test"):
        raise RuntimeError(
            f"refusing to run destructive test fixtures against database {name!r} — "
            "TEST_DATABASE_URL must point at a database named 'test' or ending in '_test'"
        )


def _migration_files() -> list[Path]:
    return sorted(MIGRATIONS_DIR.glob("*.sql"))


async def run_migrations(pool: asyncpg.Pool) -> list[str]:
    """Apply every migration under migrations/ not yet recorded, in filename order.

    Idempotent: re-running against an already-migrated database applies nothing and returns an
    empty list. Each migration runs in its own transaction so a partial failure never leaves the
    ledger claiming a migration applied when it didn't.
    """
    applied: list[str] = []
    async with pool.acquire() as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
              filename    text PRIMARY KEY,
              applied_at  timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        rows = await conn.fetch("SELECT filename FROM schema_migrations")
        already = {r["filename"] for r in rows}

        for path in _migration_files():
            if path.name in already:
                continue
            sql = path.read_text()
            async with conn.transaction():
                await conn.execute(sql)
                await conn.execute(
                    "INSERT INTO schema_migrations (filename) VALUES ($1)", path.name
                )
            logger.info("applied migration %s", path.name)
            applied.append(path.name)
    return applied
