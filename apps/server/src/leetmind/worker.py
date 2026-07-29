"""The generation pipeline's job/stage machine (PLAN_BACKEND.md §7.1).

Each asyncio worker task claims jobs from `generation_jobs` via `FOR UPDATE SKIP LOCKED`, fully
processing one — selecting, drafting, verifying, and any repair — before claiming the next.
Advisory claim locks plus a lifetime lease (fencing token + heartbeat) keep work serialized per
user while allowing independent users to run concurrently. Every DB write that matters is fenced
(`WHERE id = $job AND lease_token = $token`), so a worker that lost its lease to a reclaim can no
longer affect the job; the reclaiming worker resumes from `plan_json`/`problem_id`.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import asyncpg

from leetmind.builder import (
    BuilderError,
    BuiltProblem,
    RepairContext,
    ReviewRejected,
    build_problem,
)
from leetmind.config import Settings, get_settings
from leetmind.db import load_jsonb
from leetmind.judge import JudgeClient
from leetmind.llm import LLMClient, LLMError, LLMOutputError
from leetmind.planner import Plan, plan_generation
from leetmind.schemas import (
    GenerationEvent,
    GenerationFailureCode,
    GenerationJobStatus,
    GenerationPhase,
    GenerationRecoveryReason,
)
from leetmind.verify import verify_problem

logger = logging.getLogger("leetmind.worker")

NOTIFY_CHANNEL = "leetmind_generation_events"
MAX_CANDIDATE_ATTEMPTS = 2


class PipelineFailure(RuntimeError):
    def __init__(self, code: GenerationFailureCode, detail: str) -> None:
        super().__init__(detail)
        self.code = code


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
    background_restart_count: int
    created_at: datetime


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
            # The advisory lock closes a narrow two-worker race: before the first claim commits,
            # a second transaction cannot yet see its lease and could otherwise claim another
            # queued job for the same user. Try a few candidates so that contention on one user
            # does not prevent this worker from claiming independent work for another user.
            seen: list[uuid.UUID] = []
            row: asyncpg.Record | None = None
            for _ in range(16):
                candidate = await conn.fetchrow(
                    """
                    SELECT j.id, j.user_id, j.status, j.plan_json, j.problem_id, j.repair_count,
                           j.background_restart_count, j.created_at
                    FROM generation_jobs j
                    WHERE j.status NOT IN ('ready', 'failed')
                      AND NOT (j.id = ANY($2::uuid[]))
                      AND (
                        j.lease_token IS NULL
                        OR j.heartbeat_at < now() - (interval '1 second' * $1)
                      )
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
                    seen,
                )
                if candidate is None:
                    break
                seen.append(candidate["id"])
                user_lock = await conn.fetchval(
                    "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))",
                    str(candidate["user_id"]),
                )
                if not user_lock:
                    continue
                conflicting_lease = await conn.fetchval(
                    """
                    SELECT EXISTS(
                      SELECT 1 FROM generation_jobs
                      WHERE user_id = $1 AND id <> $2
                        AND status NOT IN ('ready', 'failed')
                        AND lease_token IS NOT NULL
                        AND heartbeat_at >= now() - (interval '1 second' * $3)
                    )
                    """,
                    candidate["user_id"],
                    candidate["id"],
                    stale_after,
                )
                if conflicting_lease:
                    continue
                row = candidate
                break
            if row is None:
                return None
            await conn.execute(
                "UPDATE generation_jobs SET lease_token = $1, heartbeat_at = now(), "
                "claimed_at = COALESCE(claimed_at, now()), updated_at = now() WHERE id = $2",
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
            background_restart_count=row["background_restart_count"],
            created_at=row["created_at"],
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
        elapsed = max(0.0, (datetime.now(UTC) - job.created_at).total_seconds())
        remaining = max(0.001, self._settings.generation_job_timeout_s - elapsed)
        deadline = asyncio.get_running_loop().time() + remaining
        try:
            await asyncio.wait_for(
                self._run_pipeline(job, deadline=deadline),
                timeout=remaining,
            )
        except TimeoutError:
            exc = PipelineFailure(
                GenerationFailureCode.DEADLINE_EXCEEDED,
                f"generation exceeded {self._settings.generation_job_timeout_s:.0f}s",
            )
            await self._record_failure(job, exc)
        except PipelineFailure as exc:
            await self._record_failure(job, exc)
        except Exception as exc:
            logger.exception("job %s failed", job.id)
            await self._record_failure(
                job,
                PipelineFailure(GenerationFailureCode.GENERATION_INVALID, str(exc)),
            )
        finally:
            heartbeat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat_task

    async def _record_failure(self, job: ClaimedJob, failure: PipelineFailure) -> None:
        logger.warning("job %s failed code=%s: %s", job.id, failure.code, failure)
        recorded = await self._fail_job(
            job.id,
            job.lease_token,
            str(failure),
            failure_code=failure.code,
        )
        if not recorded:
            return
        await self._notify(job.user_id, job.id)
        replacement_id = await self._restart_failed_background_job(job)
        if replacement_id is not None:
            logger.info(
                "restarted failed background generation user_id=%s failed_job_id=%s "
                "replacement_job_id=%s restart=%d/%d",
                job.user_id,
                job.id,
                replacement_id,
                job.background_restart_count + 1,
                self._settings.generation_background_restart_limit,
            )

    async def _run_pipeline(self, job: ClaimedJob, *, deadline: float) -> None:
        plan = await self._resolve_plan(job)
        if plan is None:
            return

        problem_id = job.problem_id
        repair_count = min(job.repair_count, MAX_CANDIDATE_ATTEMPTS - 1)
        repair_ctx: RepairContext | None = None
        repair_reason: GenerationRecoveryReason | None = None

        while True:
            phase = GenerationPhase.REPAIRING if repair_ctx else GenerationPhase.DRAFTING
            if not await self._transition(
                job,
                phase,
                status=GenerationJobStatus.BUILDING,
                repair_count=repair_count,
                recovery_reason=repair_reason,
            ):
                return

            async def on_review(*, count: int = repair_count) -> None:
                await self._transition(
                    job,
                    GenerationPhase.INDEPENDENT_REVIEW,
                    status=GenerationJobStatus.BUILDING,
                    repair_count=count,
                )

            try:
                built = await build_problem(self._llm, plan, repair=repair_ctx, on_review=on_review)
            except ReviewRejected as exc:
                if self._can_repair(repair_count, deadline):
                    repair_count += 1
                    repair_ctx = RepairContext(
                        previous_output=exc.output.model_dump(mode="json"),
                        failure_report="; ".join(exc.issues),
                    )
                    repair_reason = GenerationRecoveryReason(exc.reason)
                    continue
                code = (
                    GenerationFailureCode.DEADLINE_EXCEEDED
                    if self._remaining(deadline) < self._settings.generation_repair_min_remaining_s
                    else GenerationFailureCode.QUALITY_MISMATCH
                )
                raise PipelineFailure(code, str(exc)) from exc
            except BuilderError as exc:
                code = (
                    GenerationFailureCode.PROVIDER_UNAVAILABLE
                    if isinstance(exc.__cause__, LLMError)
                    and not isinstance(exc.__cause__, LLMOutputError)
                    else GenerationFailureCode.GENERATION_INVALID
                )
                raise PipelineFailure(code, str(exc)) from exc

            if problem_id is None:
                problem_id = await self._insert_problem(
                    job.id, job.lease_token, job.user_id, plan, built
                )
                if problem_id is None:
                    return
            elif not await self._update_problem(job.id, job.lease_token, problem_id, built):
                return

            async def on_verify_phase(phase_name: str, *, count: int = repair_count) -> None:
                await self._transition(
                    job,
                    GenerationPhase(phase_name),
                    status=GenerationJobStatus.VERIFYING,
                    repair_count=count,
                )

            result = await verify_problem(self._judge, built, on_phase=on_verify_phase)
            if result.ok:
                break

            if result.retryable_infrastructure:
                await self._transition(
                    job,
                    GenerationPhase.CHECKING_EXAMPLES,
                    status=GenerationJobStatus.VERIFYING,
                    repair_count=repair_count,
                    recovery_reason=GenerationRecoveryReason.VERIFICATION_INFRASTRUCTURE,
                )
                result = await verify_problem(self._judge, built, on_phase=on_verify_phase)
                if result.ok:
                    break
                if result.retryable_infrastructure:
                    raise PipelineFailure(
                        GenerationFailureCode.VERIFICATION_UNAVAILABLE,
                        result.report(),
                    )

            if self._can_repair(repair_count, deadline):
                repair_count += 1
                repair_ctx = RepairContext(
                    previous_output=built.output.model_dump(mode="json"),
                    failure_report=result.report(),
                )
                repair_reason = GenerationRecoveryReason.TEST_DISAGREEMENT
                continue

            code = (
                GenerationFailureCode.DEADLINE_EXCEEDED
                if self._remaining(deadline) < self._settings.generation_repair_min_remaining_s
                else GenerationFailureCode.VERIFICATION_FAILED
            )
            raise PipelineFailure(code, result.report())

        assert problem_id is not None
        await self._transition(
            job,
            GenerationPhase.FINALIZING,
            status=GenerationJobStatus.VERIFYING,
            repair_count=repair_count,
        )
        if not await self._promote_and_finish(job.id, job.lease_token, job.user_id, problem_id):
            return
        await self._notify(job.user_id, job.id, problem_id=problem_id)
        await self.replenish(job.user_id)

    def _remaining(self, deadline: float) -> float:
        return max(0.0, deadline - asyncio.get_running_loop().time())

    def _can_repair(self, repair_count: int, deadline: float) -> bool:
        return (
            repair_count + 1 < MAX_CANDIDATE_ATTEMPTS
            and self._remaining(deadline) >= self._settings.generation_repair_min_remaining_s
        )

    async def _resolve_plan(self, job: ClaimedJob) -> Plan | None:
        """`queued → planning`, or resume straight from an already-persisted `plan_json` (§7.1:
        "resumes from plan_json, never re-plans") — the only path that (re-)runs the planner is a
        job whose plan was never durably written, whether fresh or crash-resumed mid-planning."""
        if job.plan_json is not None:
            return Plan.from_json(job.plan_json)

        if not await self._transition(
            job,
            GenerationPhase.SELECTING,
            status=GenerationJobStatus.PLANNING,
            repair_count=job.repair_count,
        ):
            return None

        async with self._pool.acquire() as conn:
            plan = await plan_generation(conn, user_id=job.user_id, job_id=job.id)

        if not await self._write_plan(job.id, job.lease_token, plan):
            return None
        return plan

    # -- fenced writes --------------------------------------------------------------------------

    async def _transition(
        self,
        job: ClaimedJob,
        phase: GenerationPhase,
        *,
        status: GenerationJobStatus,
        repair_count: int,
        recovery_reason: GenerationRecoveryReason | None = None,
    ) -> bool:
        """Persist and publish a fenced, append-only progress transition."""
        async with self._pool.acquire() as conn, conn.transaction():
            previous = await conn.fetchrow(
                """
                SELECT phase, phase_started_at
                FROM generation_jobs
                WHERE id = $1 AND lease_token = $2
                FOR UPDATE
                """,
                job.id,
                job.lease_token,
            )
            if previous is None:
                return False
            row = await conn.fetchrow(
                """
                UPDATE generation_jobs SET
                  status = $3, phase = $4, repair_count = $5,
                  phase_started_at = now(), recovery_reason = $6,
                  failure_code = NULL, updated_at = now()
                WHERE id = $1 AND lease_token = $2
                RETURNING phase_started_at
                """,
                job.id,
                job.lease_token,
                status,
                phase,
                repair_count,
                recovery_reason,
            )
            assert row is not None
            await conn.execute(
                """
                INSERT INTO generation_job_transitions (
                  job_id, phase, attempt, recovery_reason
                ) VALUES ($1, $2, $3, $4)
                """,
                job.id,
                phase,
                min(repair_count + 1, MAX_CANDIDATE_ATTEMPTS),
                recovery_reason,
            )
        duration_ms = max(
            0,
            int((row["phase_started_at"] - previous["phase_started_at"]).total_seconds() * 1000),
        )
        logger.info(
            "generation phase transition job_id=%s user_id=%s from_phase=%s phase=%s "
            "status=%s attempt=%d duration_ms=%d recovery_reason=%s",
            job.id,
            job.user_id,
            previous["phase"],
            phase,
            status,
            min(repair_count + 1, MAX_CANDIDATE_ATTEMPTS),
            duration_ms,
            recovery_reason,
        )
        await self._notify(job.user_id, job.id)
        return True

    async def _write_plan(self, job_id: uuid.UUID, lease_token: uuid.UUID, plan: Plan) -> bool:
        result = await self._pool.execute(
            "UPDATE generation_jobs SET plan_json = $3, status = 'building', updated_at = now() "
            "WHERE id = $1 AND lease_token = $2",
            job_id,
            lease_token,
            json.dumps(plan.to_json()),
        )
        return _rowcount(result) == 1

    @staticmethod
    def _problem_columns(built: BuiltProblem) -> tuple[Any, ...]:
        output = built.output
        return (
            output.title,
            output.statement_md,
            json.dumps(output.constraints),
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
                constraints,
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
                  title, statement_md, constraints, signature, starter_code, public_tests,
                  private_tests, hints, reference_solution, complexity, par_minutes
                ) VALUES (
                  $1, 'building', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                  $15, $16, $17
                )
                RETURNING id
                """,
                user_id,
                plan.primary_type,
                built.output.support_types,
                plan.shape,
                plan.problem_rating,
                plan.is_probe,
                title,
                statement_md,
                constraints,
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
                constraints,
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
                  support_types = $2, title = $3, statement_md = $4, constraints = $5,
                  signature = $6, starter_code = $7, public_tests = $8, private_tests = $9,
                  hints = $10, reference_solution = $11, complexity = $12, par_minutes = $13
                WHERE id = $1
                """,
                problem_id,
                built.output.support_types,
                title,
                statement_md,
                constraints,
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
        error: str,
        *,
        failure_code: GenerationFailureCode,
    ) -> bool:
        async with self._pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow(
                """
                UPDATE generation_jobs SET
                  status = 'failed', phase = 'failed', phase_started_at = now(),
                  error = $3, failure_code = $4, recovery_reason = NULL, updated_at = now()
                WHERE id = $1 AND lease_token = $2
                RETURNING problem_id, repair_count
                """,
                job_id,
                lease_token,
                error[:4000],
                failure_code,
            )
            if row is None:
                return False
            await conn.execute(
                """
                INSERT INTO generation_job_transitions (job_id, phase, attempt)
                VALUES ($1, 'failed', $2)
                """,
                job_id,
                min(int(row["repair_count"]) + 1, MAX_CANDIDATE_ATTEMPTS),
            )
            problem_id = row["problem_id"]
            if problem_id is not None:
                # Amendment 42: a dead 'building' row must not reserve its type/shape forever.
                await conn.execute(
                    "UPDATE problems SET status = 'failed' WHERE id = $1 AND status = 'building'",
                    problem_id,
                )
        return True

    async def _restart_failed_background_job(self, job: ClaimedJob) -> uuid.UUID | None:
        """Replace a failed on-deck job while the learner still has something to solve.

        Foreground failures remain terminal and learner-controlled. Background replacements carry
        a bounded lineage counter so a persistent provider or content failure cannot spin forever.
        The per-user advisory lock serializes this with problem resolution and ordinary replenish.
        """
        if job.background_restart_count >= self._settings.generation_background_restart_limit:
            return None

        async with self._pool.acquire() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", str(job.user_id)
            )
            active_exists = await conn.fetchval(
                "SELECT EXISTS(SELECT 1 FROM problems WHERE user_id = $1 AND status = 'active')",
                job.user_id,
            )
            if not active_exists:
                return None

            buffer_exists = await conn.fetchval(
                """
                SELECT EXISTS(
                  SELECT 1 FROM problems WHERE user_id = $1 AND status = 'ready'
                  UNION ALL
                  SELECT 1 FROM generation_jobs
                  WHERE user_id = $1 AND status NOT IN ('ready', 'failed')
                )
                """,
                job.user_id,
            )
            if buffer_exists:
                return None

            replacement_id: uuid.UUID | None = await conn.fetchval(
                """
                INSERT INTO generation_jobs (user_id, background_restart_count)
                VALUES ($1, $2)
                RETURNING id
                """,
                job.user_id,
                job.background_restart_count + 1,
            )
            return replacement_id

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
            repair_count = await conn.fetchval(
                """
                UPDATE generation_jobs SET
                  status = 'ready', phase = 'ready', phase_started_at = now(),
                  recovery_reason = NULL, failure_code = NULL, updated_at = now()
                WHERE id = $1
                RETURNING repair_count
                """,
                job_id,
            )
            await conn.execute(
                """
                INSERT INTO generation_job_transitions (job_id, phase, attempt)
                VALUES ($1, 'ready', $2)
                """,
                job_id,
                min(int(repair_count) + 1, MAX_CANDIDATE_ATTEMPTS),
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
        *,
        problem_id: uuid.UUID | None = None,
    ) -> None:
        row = await self._pool.fetchrow(
            """
            SELECT status, phase, repair_count, created_at, phase_started_at,
                   recovery_reason, failure_code, problem_id
            FROM generation_jobs
            WHERE id = $1
            """,
            job_id,
        )
        if row is None:
            return
        event = GenerationEvent(
            job_id=str(job_id),
            status=GenerationJobStatus(row["status"]),
            phase=GenerationPhase(row["phase"]),
            repair_count=row["repair_count"],
            attempt=min(row["repair_count"] + 1, MAX_CANDIDATE_ATTEMPTS),
            max_attempts=MAX_CANDIDATE_ATTEMPTS,
            started_at=row["created_at"],
            phase_started_at=row["phase_started_at"],
            recovery_reason=row["recovery_reason"],
            failure_code=row["failure_code"],
            problem_id=str(problem_id or row["problem_id"])
            if (problem_id or row["problem_id"]) is not None
            else None,
        )
        payload = json.dumps({"user_id": str(user_id), **event.model_dump(mode="json")})
        await self._pool.execute("SELECT pg_notify($1, $2)", NOTIFY_CHANNEL, payload)
