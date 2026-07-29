"""`GET /api/practice/next`, `POST /api/practice/replenish` (PLAN_BACKEND.md §9).

`next` is a fully pure read (amendments 36, 41) — no writes, not even ratings lazy-init — so it's
safe for the frontend to poll or prefetch. `replenish` is the one path that mutates the queue:
bootstrap for a new user, self-heal for anyone `next` reports `stalled` for.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from fastapi import APIRouter, Depends, Request

from leetmind.auth import AuthedUser, require_user
from leetmind.schemas import (
    GenerationFailureCode,
    GenerationJobStatus,
    GenerationPhase,
    GenerationRecoveryReason,
    JobStub,
    PracticeNextResponse,
    ReplenishResponse,
)

router = APIRouter(prefix="/api")


def _job_stub(job: Mapping[str, Any]) -> JobStub:
    return JobStub(
        job_id=str(job["id"]),
        status=GenerationJobStatus(job["status"]),
        phase=GenerationPhase(job["phase"]),
        repair_count=job["repair_count"],
        attempt=min(job["repair_count"] + 1, 2),
        max_attempts=2,
        started_at=job["created_at"],
        phase_started_at=job["phase_started_at"],
        recovery_reason=GenerationRecoveryReason(job["recovery_reason"])
        if job["recovery_reason"]
        else None,
        failure_code=GenerationFailureCode(job["failure_code"]) if job["failure_code"] else None,
    )


@router.get("/practice/next")
async def practice_next(
    request: Request, user: AuthedUser = Depends(require_user)
) -> PracticeNextResponse:
    pool = request.app.state.pool

    active = await pool.fetchrow(
        "SELECT id, served_at FROM problems WHERE user_id = $1 AND status = 'active'", user.id
    )
    if active is not None:
        return PracticeNextResponse(
            state="active",
            problem_id=str(active["id"]),
            opened=active["served_at"] is not None,
        )

    job = await pool.fetchrow(
        """
        SELECT id, status, phase, repair_count, created_at, phase_started_at,
               recovery_reason, failure_code
        FROM generation_jobs
        WHERE user_id = $1 AND status NOT IN ('ready', 'failed')
        -- Replenishment deliberately keeps a small buffer.  Show the job the worker actually
        -- claimed, not a newer reserve job that is still waiting behind it.  Two bootstrap rows
        -- can also have the exact same created_at, so the id tie-breaker keeps this deterministic.
        ORDER BY (lease_token IS NOT NULL) DESC, created_at ASC, id ASC
        LIMIT 1
        """,
        user.id,
    )
    if job is not None:
        return PracticeNextResponse(
            state="generating",
            job=_job_stub(job),
        )

    failed = await pool.fetchrow(
        """
        SELECT id, status, phase, repair_count, created_at, phase_started_at,
               recovery_reason, failure_code
        FROM generation_jobs
        WHERE user_id = $1 AND status = 'failed'
        ORDER BY created_at DESC
        LIMIT 1
        """,
        user.id,
    )
    if failed is not None:
        return PracticeNextResponse(state="generation_failed", job=_job_stub(failed))

    return PracticeNextResponse(state="stalled")


@router.post("/practice/replenish")
async def replenish(
    request: Request, user: AuthedUser = Depends(require_user)
) -> ReplenishResponse:
    worker = request.app.state.worker
    created = await worker.replenish(user.id)
    return ReplenishResponse(created=[str(job_id) for job_id in created])
