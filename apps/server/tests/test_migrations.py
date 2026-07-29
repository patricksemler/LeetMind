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


async def test_generation_progress_columns_and_transition_constraints(pool):
    user_id = "00000000-0000-0000-0000-000000000002"
    job_id = await pool.fetchval(
        "INSERT INTO generation_jobs (user_id) VALUES ($1) RETURNING id", user_id
    )
    row = await pool.fetchrow(
        """
        SELECT phase, phase_started_at, claimed_at, failure_code, recovery_reason,
               background_restart_count
        FROM generation_jobs
        WHERE id = $1
        """,
        job_id,
    )
    assert row["phase"] == "waiting"
    assert row["phase_started_at"] is not None
    assert row["claimed_at"] is None
    assert row["background_restart_count"] == 0
    assert (
        await pool.fetchval(
            """
            SELECT COUNT(*) FROM generation_job_transitions
            WHERE job_id = $1 AND phase = 'waiting' AND attempt = 1
            """,
            job_id,
        )
        == 1
    )

    await pool.execute(
        """
        INSERT INTO generation_job_transitions (job_id, phase, attempt, recovery_reason)
        VALUES ($1, 'drafting', 1, 'format')
        """,
        job_id,
    )
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute(
            """
            INSERT INTO generation_job_transitions (job_id, phase, attempt)
            VALUES ($1, 'drafting', 3)
            """,
            job_id,
        )
