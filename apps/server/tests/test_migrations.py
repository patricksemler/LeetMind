import asyncpg
import pytest

from leetmind.db import run_migrations
from leetmind.taxonomy import PROBLEM_TYPES


async def test_migrations_seed_taxonomy(pool):
    rows = await pool.fetch("SELECT slug FROM problem_types ORDER BY ordinal")
    assert [r["slug"] for r in rows] == list(PROBLEM_TYPES)


async def test_migrations_are_idempotent(pool):
    applied_again = await run_migrations(pool)
    assert applied_again == []


async def test_queue_invariant_unique_indexes(pool):
    # one_active_per_user / one_ready_per_user must reject a second row of the same status.
    user_id = "00000000-0000-0000-0000-000000000001"
    common = {
        "user_id": user_id,
        "primary_type": "arrays_hashing",
        "shape": "optimize_subarray",
        "problem_rating": 1200,
        "title": "t",
        "statement_md": "s",
        "signature": "{}",
        "starter_code": "",
        "public_tests": "[]",
        "private_tests": "[]",
        "hints": "[]",
        "reference_solution": "",
        "complexity": "{}",
        "par_minutes": 20,
    }

    async def insert(status: str):
        await pool.execute(
            """
            INSERT INTO problems (
              user_id, status, primary_type, shape, problem_rating, title, statement_md,
              signature, starter_code, public_tests, private_tests, hints, reference_solution,
              complexity, par_minutes
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb,
                      $12::jsonb, $13, $14::jsonb, $15)
            """,
            common["user_id"],
            status,
            common["primary_type"],
            common["shape"],
            common["problem_rating"],
            common["title"],
            common["statement_md"],
            common["signature"],
            common["starter_code"],
            common["public_tests"],
            common["private_tests"],
            common["hints"],
            common["reference_solution"],
            common["complexity"],
            common["par_minutes"],
        )

    await insert("active")
    with pytest.raises(asyncpg.UniqueViolationError, match="one_active_per_user"):
        await insert("active")
