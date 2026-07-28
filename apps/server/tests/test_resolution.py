"""`resolve_problem` (PLAN_BACKEND.md §6.1, §8.3, §9 #22, §14 Phase 4).

No Docker/LLM needed: metrics are derived from `executions`/`hint_reveals` rows inserted
directly, and `GenerationWorker.replenish` (called at the end of a resolution) is pure DB."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

from leetmind.resolution import resolve_problem
from leetmind.worker import GenerationWorker

from .conftest import insert_problem


async def test_solve_applies_rating_update_and_promotes_ready_to_active(pool):
    user_id = uuid.uuid4()
    worker = GenerationWorker(pool)
    served_at = datetime.now(UTC) - timedelta(minutes=3)
    problem_id = await insert_problem(pool, user_id, served_at=served_at)
    on_deck_id = await insert_problem(pool, user_id, status="ready", served_at=None)

    outcome = await resolve_problem(
        pool, worker, user_id=user_id, problem_id=problem_id, gave_up=False
    )

    assert outcome is not None
    assert outcome.problem_status == "solved"
    # S=1.0 (clean solve, no penalties) > E=0.5 (equal ratings) -> rating goes up.
    assert outcome.rating_update.rating_after > outcome.rating_update.rating_before

    problem_row = await pool.fetchrow(
        "SELECT status, resolved_at FROM problems WHERE id = $1", problem_id
    )
    assert problem_row["status"] == "solved"
    assert problem_row["resolved_at"] is not None

    on_deck_row = await pool.fetchrow("SELECT status FROM problems WHERE id = $1", on_deck_id)
    assert on_deck_row["status"] == "active"  # promoted, served_at still untouched (stays NULL)

    rating_row = await pool.fetchrow(
        "SELECT rating, attempts FROM ratings WHERE user_id = $1 AND type_slug = 'arrays_hashing'",
        user_id,
    )
    assert rating_row["attempts"] == 1
    assert rating_row["rating"] == outcome.rating_update.rating_after

    ru_row = await pool.fetchrow(
        "SELECT * FROM rating_updates WHERE problem_id = $1", problem_id
    )
    assert ru_row is not None
    assert ru_row["performance_score"] > 0

    # the replacement job for the now-empty ready slot
    live_jobs = await pool.fetchval(
        "SELECT COUNT(*) FROM generation_jobs WHERE user_id = $1", user_id
    )
    assert live_jobs == 1


async def test_give_up_scores_zero_performance(pool):
    user_id = uuid.uuid4()
    worker = GenerationWorker(pool)
    problem_id = await insert_problem(pool, user_id, served_at=datetime.now(UTC))

    outcome = await resolve_problem(
        pool, worker, user_id=user_id, problem_id=problem_id, gave_up=True
    )

    assert outcome is not None
    assert outcome.problem_status == "given_up"
    assert outcome.rating_update.performance_score == 0.0
    assert outcome.rating_update.rating_after < outcome.rating_update.rating_before


async def test_metrics_are_derived_from_recorded_executions_and_hints(pool):
    user_id = uuid.uuid4()
    worker = GenerationWorker(pool)
    problem_id = await insert_problem(pool, user_id, served_at=datetime.now(UTC))

    for _ in range(8):  # beyond the 6 free runs -> run_penalty kicks in
        await pool.execute(
            "INSERT INTO executions (problem_id, user_id, kind, code, passed, results, "
            "duration_ms) VALUES ($1, $2, 'run', 'x', true, '[]', 1)",
            problem_id,
            user_id,
        )
    await pool.execute(
        "INSERT INTO executions (problem_id, user_id, kind, code, passed, results, duration_ms) "
        "VALUES ($1, $2, 'submit', 'x', false, '[]', 1)",
        problem_id,
        user_id,
    )
    await pool.execute("INSERT INTO hint_reveals (problem_id, rung) VALUES ($1, 1)", problem_id)

    outcome = await resolve_problem(
        pool, worker, user_id=user_id, problem_id=problem_id, gave_up=False
    )

    assert outcome is not None
    metrics = outcome.rating_update.metrics
    assert metrics["runs"] == 8
    assert metrics["failed_submissions"] == 1
    assert metrics["hints_revealed"] == 1
    assert outcome.rating_update.performance_score < 1.0  # penalties applied


async def test_a_non_active_problem_cannot_be_resolved(pool):
    user_id = uuid.uuid4()
    worker = GenerationWorker(pool)
    problem_id = await insert_problem(
        pool, user_id, status="solved", served_at=datetime.now(UTC), resolved_at=datetime.now(UTC)
    )

    outcome = await resolve_problem(
        pool, worker, user_id=user_id, problem_id=problem_id, gave_up=False
    )
    assert outcome is None


async def test_concurrent_resolutions_of_the_same_problem_produce_exactly_one_rating_update(pool):
    """§8.3/#27: a concurrent duplicate resolves to a no-op; `rating_updates.problem_id` UNIQUE
    is the second guard past any bug — this exercises the advisory-lock/FOR-UPDATE path itself,
    independent of the process-local in-flight guard the HTTP routes also apply."""
    user_id = uuid.uuid4()
    worker = GenerationWorker(pool)
    problem_id = await insert_problem(pool, user_id, served_at=datetime.now(UTC))

    results = await asyncio.gather(
        resolve_problem(pool, worker, user_id=user_id, problem_id=problem_id, gave_up=False),
        resolve_problem(pool, worker, user_id=user_id, problem_id=problem_id, gave_up=False),
    )

    non_none = [r for r in results if r is not None]
    assert len(non_none) == 1

    count = await pool.fetchval(
        "SELECT COUNT(*) FROM rating_updates WHERE problem_id = $1", problem_id
    )
    assert count == 1

    status = await pool.fetchval("SELECT status FROM problems WHERE id = $1", problem_id)
    assert status == "solved"
