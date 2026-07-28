"""Resolution transaction (PLAN_BACKEND.md §6.1, §8.3, §9 #22).

Applying the Elo update when a problem resolves (solve or give-up): under the per-user advisory
lock, the problem row is re-read `FOR UPDATE` and must still be `active` — a concurrent duplicate
resolves to a no-op (`None`), and `rating_updates.problem_id` is `UNIQUE` as a second guard past
any bug (§8.3, amendment 27). Metrics (runs, failed submissions, hints revealed, minutes) are
derived entirely from server-recorded history — never trusted from the client — so nothing about
the score can be gamed by what a request claims. Promotes the on-deck problem to `active` and
enqueues the replacement job, keeping the queue invariant (§7.1).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

import asyncpg

from leetmind.elo import DEFAULT_RATING, Metrics, RatingUpdate, cap_minutes, rating_update
from leetmind.ratings import ensure_ratings
from leetmind.worker import GenerationWorker


@dataclass(frozen=True)
class ResolutionOutcome:
    rating_update: RatingUpdate
    problem_status: str


async def resolve_problem(
    pool: asyncpg.Pool,
    worker: GenerationWorker,
    *,
    user_id: UUID,
    problem_id: UUID,
    gave_up: bool,
) -> ResolutionOutcome | None:
    """Returns `None` if the problem was already resolved by a concurrent request — the caller
    should treat that as "someone else already resolved it," not a server error."""
    new_status = "given_up" if gave_up else "solved"

    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", str(user_id))

        problem = await conn.fetchrow(
            "SELECT * FROM problems WHERE id = $1 AND user_id = $2 FOR UPDATE",
            problem_id,
            user_id,
        )
        if problem is None or problem["status"] != "active":
            return None

        runs = await conn.fetchval(
            "SELECT COUNT(*) FROM executions WHERE problem_id = $1 AND kind = 'run'", problem_id
        )
        failed_submissions = await conn.fetchval(
            "SELECT COUNT(*) FROM executions WHERE problem_id = $1 AND kind = 'submit' "
            "AND passed = false",
            problem_id,
        )
        hints_revealed = await conn.fetchval(
            "SELECT COALESCE(MAX(rung), 0) FROM hint_reveals WHERE problem_id = $1", problem_id
        )

        served_at = problem["served_at"]
        now = datetime.now(UTC)
        raw_minutes = (now - served_at).total_seconds() / 60 if served_at else 0.0
        minutes = cap_minutes(raw_minutes, problem["par_minutes"])

        metrics = Metrics(
            runs=runs,
            failed_submissions=failed_submissions,
            hints_revealed=hints_revealed,
            minutes=minutes,
            gave_up=gave_up,
        )

        # Guarantees a row to read below: an established user's ratings already exist (§4), but
        # nothing upstream of this transaction is required to have created them.
        await ensure_ratings(conn, user_id)
        rating_row = await conn.fetchrow(
            "SELECT rating, attempts FROM ratings WHERE user_id = $1 AND type_slug = $2 "
            "FOR UPDATE",
            user_id,
            problem["primary_type"],
        )
        rating_before = rating_row["rating"] if rating_row else float(DEFAULT_RATING)
        attempts_before = rating_row["attempts"] if rating_row else 0

        update = rating_update(
            rating_before=rating_before,
            attempts_before=attempts_before,
            problem_rating=problem["problem_rating"],
            par_minutes=problem["par_minutes"],
            metrics=metrics,
        )

        await conn.execute(
            """
            UPDATE ratings SET rating = $3, attempts = $4, updated_at = now()
            WHERE user_id = $1 AND type_slug = $2
            """,
            user_id,
            problem["primary_type"],
            update.rating_after,
            update.attempts_after,
        )
        await conn.execute(
            """
            INSERT INTO rating_updates (
              user_id, type_slug, problem_id, rating_before, rating_after, problem_rating,
              expected_score, performance_score, k_factor, metrics
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            """,
            user_id,
            problem["primary_type"],
            problem_id,
            update.rating_before,
            update.rating_after,
            update.problem_rating,
            update.expected_score,
            update.performance_score,
            update.k_factor,
            json.dumps(update.metrics),
        )
        await conn.execute(
            "UPDATE problems SET status = $2, resolved_at = now() WHERE id = $1",
            problem_id,
            new_status,
        )

        # §8.3: promotes the on-deck problem to active; its served_at stays NULL until the
        # client opens it. Only one 'ready' problem can exist per user (partial unique index),
        # LIMIT 1 is defensive.
        ready = await conn.fetchrow(
            "SELECT id FROM problems WHERE user_id = $1 AND status = 'ready' "
            "ORDER BY created_at LIMIT 1 FOR UPDATE",
            user_id,
        )
        if ready is not None:
            await conn.execute("UPDATE problems SET status = 'active' WHERE id = $1", ready["id"])

    # Outside the transaction, same as the worker's own job-completion path (§7.1) — replenish
    # tops up only what the queue invariant is missing, under its own advisory-locked transaction.
    await worker.replenish(user_id)
    return ResolutionOutcome(rating_update=update, problem_status=new_status)
