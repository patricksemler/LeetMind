"""The generation pipeline's job/stage machine (PLAN_BACKEND.md §7.1).

One asyncio task claims jobs from `generation_jobs` via `FOR UPDATE SKIP LOCKED`, fully processing
each one — planning, building, verifying, and any repairs — before claiming the next. A single
lease (fencing token + heartbeat) is held for the job's entire lifetime, which is what makes
per-user planning serial "for free" (amendment 31): a second job for the same user simply can't be
claimed while this one's lease is live. Every DB write that matters is fenced (`WHERE id = $job
AND lease_token = $token`), so a worker that lost its lease to a reclaim can no longer affect the
job — it just returns quietly and the reclaiming worker picks up from `plan_json`/`problem_id`.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any

import asyncpg

from leetmind.builder import BuilderError, BuiltProblem, RepairContext, build_problem
from leetmind.config import Settings, get_settings
from leetmind.db import load_jsonb
from leetmind.judge import JudgeClient
from leetmind.llm import LLMClient, LLMError
from leetmind.planner import Plan, plan_generation
from leetmind.schemas import GenerationEvent, GenerationJobStatus
from leetmind.verify import verify_problem

logger = logging.getLogger("leetmind.worker")

NOTIFY_CHANNEL = "leetmind_generation_events"
MAX_REPAIRS = 3  # §7.1: repair_count max, then one full regenerate, then the job fails


def _rowcount(result: str) -> int:
    """asyncpg's `Connection.execute` returns a status tag like `"UPDATE 1"`."""
    return int(result.rsplit(" ", 1)[-1])


@dataclass(frozen=True)
class ClaimedJob:
    id: uuid.UUID
    user_id: uuid.UUID
    lease_token: uuid.UUID
    status: str
    plan_json: dict[str, Any] | None
    problem_id: uuid.UUID | None
    repair_count: int


class GenerationWorker:
    def __init__(
        self,
        pool: asyncpg.Pool,
        *,
        llm: LLMClient | None = None,
        judge: JudgeClient | None = None,
        settings: Settings | None = None,
    ) -> None:
        self._pool = pool
        self._settings = settings or get_settings()
        self._llm = llm or LLMClient(self._settings)
        self._judge = judge or JudgeClient(self._settings)
        self._running = False

    # -- main loop ---------------------------------------------------------------------------

    async def run_forever(self) -> None:
        self._running = True
        while self._running:
            try:
                claimed_something = await self.run_once()
            except Exception:
                logger.exception("worker iteration failed")
                claimed_something = False
            if not claimed_something:
                await asyncio.sleep(self._settings.worker_poll_interval_s)

    def stop(self) -> None:
        self._running = False

    async def run_once(self) -> bool:
        """Claims and fully processes at most one job. Returns whether one was claimed — callers
        that want a tight test loop (rather than `run_forever`'s poll-and-sleep) can call this
        directly until it returns `False`."""
        job = await self._claim_job()
        if job is None:
            return False
        await self._process_job(job)
        return True

    # -- claiming -----------------------------------------------------------------------------

    async def _claim_job(self) -> ClaimedJob | None:
        lease_token = uuid.uuid4()
        stale_after = self._settings.worker_lease_stale_s
        async with self._pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow(
                """
                SELECT j.id, j.user_id, j.status, j.plan_json, j.problem_id, j.repair_count
                FROM generation_jobs j
                WHERE j.status NOT IN ('ready', 'failed')
                  AND (j.lease_token IS NULL OR j.heartbeat_at < now() - (interval '1 second' * $1))
                  AND NOT EXISTS (
                    SELECT 1 FROM generation_jobs o
                    WHERE o.user_id = j.user_id AND o.id <> j.id
                      AND o.status NOT IN ('ready', 'failed')
                      AND o.lease_token IS NOT NULL
                      AND o.heartbeat_at >= now() - (interval '1 second' * $1)
                  )
                ORDER BY j.created_at
                LIMIT 1
                FOR UPDATE OF j SKIP LOCKED
                """,
                stale_after,
            )
            if row is None:
                return None
            await conn.execute(
                "UPDATE generation_jobs SET lease_token = $1, heartbeat_at = now(), "
                "updated_at = now() WHERE id = $2",
                lease_token,
                row["id"],
            )
        return ClaimedJob(
            id=row["id"],
            user_id=row["user_id"],
            lease_token=lease_token,
            status=row["status"],
            plan_json=load_jsonb(row["plan_json"]),
            problem_id=row["problem_id"],
            repair_count=row["repair_count"],
        )

    async def _heartbeat_loop(self, job_id: uuid.UUID, lease_token: uuid.UUID) -> None:
        interval = self._settings.worker_heartbeat_interval_s
        while True:
            await asyncio.sleep(interval)
            await self._pool.execute(
                "UPDATE generation_jobs SET heartbeat_at = now() "
                "WHERE id = $1 AND lease_token = $2",
                job_id,
                lease_token,
            )

    # -- stage machine ------------------------------------------------------------------------

    async def _process_job(self, job: ClaimedJob) -> None:
        heartbeat_task = asyncio.create_task(self._heartbeat_loop(job.id, job.lease_token))
        # Tracked outside the try body so the except clause below can mark the *current* problems
        # row failed (amendment 42), not the stale value captured at claim time — a build/oracle
        # failure partway through a repair attempt must still clean up that attempt's row.
        problem_id = job.problem_id
        try:
            plan = await self._resolve_plan(job)
            if plan is None:
                return

            await self._notify(
                job.user_id, job.id, GenerationJobStatus.BUILDING, problem_id=job.problem_id
            )

            repair_count = job.repair_count
            used_full_regenerate = repair_count > MAX_REPAIRS
            repair_ctx: RepairContext | None = None

            while True:
                built = await build_problem(self._llm, plan, repair=repair_ctx)

                if problem_id is None:
                    problem_id = await self._insert_problem(
                        job.id, job.lease_token, job.user_id, plan, built
                    )
                    if problem_id is None:
                        return  # lease reclaimed
                elif not await self._update_problem(job.id, job.lease_token, problem_id, built):
                    return

                if not await self._advance_status(job.id, job.lease_token, "verifying"):
                    return
                await self._notify(
                    job.user_id, job.id, GenerationJobStatus.VERIFYING, problem_id=problem_id
                )

                result = await verify_problem(self._judge, built)
                if result.ok:
                    break

                if repair_count < MAX_REPAIRS:
                    repair_count += 1
                    repair_ctx = RepairContext(
                        previous_output=built.output.model_dump(mode="json"),
                        failure_report=result.report(),
                    )
                elif not used_full_regenerate:
                    # One last fresh attempt from the same plan_json before giving up entirely.
                    used_full_regenerate = True
                    repair_count += 1
                    repair_ctx = None
                else:
                    await self._fail_job(job.id, job.lease_token, problem_id, result.report())
                    await self._notify(
                        job.user_id,
                        job.id,
                        GenerationJobStatus.FAILED,
                        problem_id=problem_id,
                        error=result.report(),
                    )
                    return

                if not await self._set_repair_and_status(
                    job.id, job.lease_token, repair_count, "building"
                ):
                    return
                await self._notify(
                    job.user_id,
                    job.id,
                    GenerationJobStatus.BUILDING,
                    problem_id=problem_id,
                    repair_count=repair_count,
                )

            assert problem_id is not None
            if not await self._promote_and_finish(job.id, job.lease_token, job.user_id, problem_id):
                return
            await self._notify(
                job.user_id, job.id, GenerationJobStatus.READY, problem_id=problem_id
            )
            await self.replenish(job.user_id)
        except (LLMError, BuilderError) as exc:
            logger.exception("job %s failed", job.id)
            await self._fail_job(job.id, job.lease_token, problem_id, str(exc))
            await self._notify(
                job.user_id,
                job.id,
                GenerationJobStatus.FAILED,
                problem_id=problem_id,
                error=str(exc),
            )
        finally:
            heartbeat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat_task

    async def _resolve_plan(self, job: ClaimedJob) -> Plan | None:
        """`queued → planning`, or resume straight from an already-persisted `plan_json` (§7.1:
        "resumes from plan_json, never re-plans") — the only path that (re-)runs the planner is a
        job whose plan was never durably written, whether fresh or crash-resumed mid-planning."""
        if job.plan_json is not None:
            return Plan.from_json(job.plan_json)

        if not await self._advance_status(job.id, job.lease_token, "planning"):
            return None
        await self._notify(job.user_id, job.id, GenerationJobStatus.PLANNING)

        async with self._pool.acquire() as conn:
            plan = await plan_generation(conn, self._llm, user_id=job.user_id, job_id=job.id)

        if not await self._write_plan(job.id, job.lease_token, plan):
            return None
        return plan

    # -- fenced writes --------------------------------------------------------------------------

    async def _advance_status(self, job_id: uuid.UUID, lease_token: uuid.UUID, status: str) -> bool:
        result = await self._pool.execute(
            "UPDATE generation_jobs SET status = $3, updated_at = now() "
            "WHERE id = $1 AND lease_token = $2",
            job_id,
            lease_token,
            status,
        )
        return _rowcount(result) == 1

    async def _write_plan(self, job_id: uuid.UUID, lease_token: uuid.UUID, plan: Plan) -> bool:
        result = await self._pool.execute(
            "UPDATE generation_jobs SET plan_json = $3, status = 'building', updated_at = now() "
            "WHERE id = $1 AND lease_token = $2",
            job_id,
            lease_token,
            json.dumps(plan.to_json()),
        )
        return _rowcount(result) == 1

    async def _set_repair_and_status(
        self, job_id: uuid.UUID, lease_token: uuid.UUID, repair_count: int, status: str
    ) -> bool:
        result = await self._pool.execute(
            "UPDATE generation_jobs SET repair_count = $3, status = $4, updated_at = now() "
            "WHERE id = $1 AND lease_token = $2",
            job_id,
            lease_token,
            repair_count,
            status,
        )
        return _rowcount(result) == 1

    @staticmethod
    def _problem_columns(built: BuiltProblem) -> tuple[Any, ...]:
        output = built.output
        return (
            output.title,
            output.statement_md,
            json.dumps(output.signature.model_dump(mode="json")),
            output.starter_code,
            json.dumps([t.model_dump(mode="json") for t in output.public_tests]),
            json.dumps([t.model_dump(mode="json") for t in output.private_tests]),
            json.dumps(output.hints),
            output.reference_solution,
            json.dumps(output.complexity.model_dump(mode="json")),
            output.par_minutes,
        )

    async def _insert_problem(
        self,
        job_id: uuid.UUID,
        lease_token: uuid.UUID,
        user_id: uuid.UUID,
        plan: Plan,
        built: BuiltProblem,
    ) -> uuid.UUID | None:
        async with self._pool.acquire() as conn, conn.transaction():
            lease_row = await conn.fetchrow(
                "SELECT 1 FROM generation_jobs WHERE id = $1 AND lease_token = $2 FOR UPDATE",
                job_id,
                lease_token,
            )
            if lease_row is None:
                return None
            (
                title,
                statement_md,
                signature,
                starter_code,
                public_tests,
                private_tests,
                hints,
                reference_solution,
                complexity,
                par_minutes,
            ) = self._problem_columns(built)
            problem_id: uuid.UUID = await conn.fetchval(
                """
                INSERT INTO problems (
                  user_id, status, primary_type, support_types, shape, problem_rating, is_probe,
                  title, statement_md, signature, starter_code, public_tests, private_tests,
                  hints, reference_solution, complexity, par_minutes
                ) VALUES (
                  $1, 'building', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
                )
                RETURNING id
                """,
                user_id,
                plan.primary_type,
                plan.support_types,
                plan.shape,
                plan.problem_rating,
                plan.is_probe,
                title,
                statement_md,
                signature,
                starter_code,
                public_tests,
                private_tests,
                hints,
                reference_solution,
                complexity,
                par_minutes,
            )
            await conn.execute(
                "UPDATE generation_jobs SET problem_id = $1 WHERE id = $2", problem_id, job_id
            )
        return problem_id

    async def _update_problem(
        self,
        job_id: uuid.UUID,
        lease_token: uuid.UUID,
        problem_id: uuid.UUID,
        built: BuiltProblem,
    ) -> bool:
        """A repair or full-regenerate attempt overwrites the same row in place — the job's
        `problem_id` is set once (schema comment, migration 0001) and never changes."""
        async with self._pool.acquire() as conn, conn.transaction():
            lease_row = await conn.fetchrow(
                "SELECT 1 FROM generation_jobs WHERE id = $1 AND lease_token = $2 FOR UPDATE",
                job_id,
                lease_token,
            )
            if lease_row is None:
                return False
            (
                title,
                statement_md,
                signature,
                starter_code,
                public_tests,
                private_tests,
                hints,
                reference_solution,
                complexity,
                par_minutes,
            ) = self._problem_columns(built)
            await conn.execute(
                """
                UPDATE problems SET
                  title = $2, statement_md = $3, signature = $4, starter_code = $5,
                  public_tests = $6, private_tests = $7, hints = $8, reference_solution = $9,
                  complexity = $10, par_minutes = $11
                WHERE id = $1
                """,
                problem_id,
                title,
                statement_md,
                signature,
                starter_code,
                public_tests,
                private_tests,
                hints,
                reference_solution,
                complexity,
                par_minutes,
            )
        return True

    async def _fail_job(
        self,
        job_id: uuid.UUID,
        lease_token: uuid.UUID,
        problem_id: uuid.UUID | None,
        error: str,
    ) -> None:
        async with self._pool.acquire() as conn, conn.transaction():
            result = await conn.execute(
                "UPDATE generation_jobs SET status = 'failed', error = $3, updated_at = now() "
                "WHERE id = $1 AND lease_token = $2",
                job_id,
                lease_token,
                error[:4000],
            )
            if _rowcount(result) != 1:
                return
            if problem_id is not None:
                # Amendment 42: a dead 'building' row must not reserve its type/shape forever.
                await conn.execute(
                    "UPDATE problems SET status = 'failed' WHERE id = $1 AND status = 'building'",
                    problem_id,
                )

    async def _promote_and_finish(
        self, job_id: uuid.UUID, lease_token: uuid.UUID, user_id: uuid.UUID, problem_id: uuid.UUID
    ) -> bool:
        """§7.1/§8.3: under the per-user advisory lock, this problem becomes `active` if none is,
        else `ready`; the job is marked `ready` in the same transaction."""
        async with self._pool.acquire() as conn, conn.transaction():
            lease_row = await conn.fetchrow(
                "SELECT 1 FROM generation_jobs WHERE id = $1 AND lease_token = $2 FOR UPDATE",
                job_id,
                lease_token,
            )
            if lease_row is None:
                return False
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", str(user_id)
            )
            active_exists = await conn.fetchval(
                "SELECT EXISTS(SELECT 1 FROM problems WHERE user_id = $1 AND status = 'active')",
                user_id,
            )
            new_status = "ready" if active_exists else "active"
            await conn.execute(
                "UPDATE problems SET status = $2 WHERE id = $1", problem_id, new_status
            )
            await conn.execute(
                "UPDATE generation_jobs SET status = 'ready', updated_at = now() WHERE id = $1",
                job_id,
            )
        return True

    # -- queue invariant maintenance ------------------------------------------------------------

    async def replenish(self, user_id: uuid.UUID) -> list[uuid.UUID]:
        """Tops the queue up to only what the invariant is missing (§7.1, §9): a brand-new user
        needs both an active-track and a ready-track job (bootstrap); an established user just
        needs a `ready` problem or a live job to exist. Runs under the per-user advisory lock so
        concurrent replenishes can't double-enqueue. Idempotent; returns any job ids created."""
        async with self._pool.acquire() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", str(user_id)
            )
            has_ever_practiced = await conn.fetchval(
                "SELECT EXISTS(SELECT 1 FROM problems WHERE user_id = $1)", user_id
            )
            live_jobs = await conn.fetchval(
                "SELECT COUNT(*) FROM generation_jobs "
                "WHERE user_id = $1 AND status NOT IN ('ready', 'failed')",
                user_id,
            )

            if not has_ever_practiced:
                to_create = max(0, 2 - live_jobs)
            else:
                ready_exists = await conn.fetchval(
                    "SELECT EXISTS(SELECT 1 FROM problems WHERE user_id = $1 AND status = 'ready')",
                    user_id,
                )
                to_create = 0 if (ready_exists or live_jobs > 0) else 1

            created: list[uuid.UUID] = []
            for _ in range(to_create):
                job_id = await conn.fetchval(
                    "INSERT INTO generation_jobs (user_id) VALUES ($1) RETURNING id", user_id
                )
                created.append(job_id)
        return created

    # -- SSE ------------------------------------------------------------------------------------

    async def _notify(
        self,
        user_id: uuid.UUID,
        job_id: uuid.UUID,
        status: GenerationJobStatus,
        *,
        problem_id: uuid.UUID | None = None,
        error: str | None = None,
        repair_count: int = 0,
    ) -> None:
        event = GenerationEvent(
            job_id=str(job_id),
            status=status,
            repair_count=repair_count,
            problem_id=str(problem_id) if problem_id is not None else None,
            error=error,
        )
        payload = json.dumps({"user_id": str(user_id), **event.model_dump(mode="json")})
        await self._pool.execute("SELECT pg_notify($1, $2)", NOTIFY_CHANNEL, payload)
