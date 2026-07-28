"""`GET /api/practice/next`, `POST /api/practice/replenish` (PLAN_BACKEND.md §9).

`next` is a fully pure read (amendments 36, 41) — no writes, not even ratings lazy-init — so it's
safe for the frontend to poll or prefetch. `replenish` is the one path that mutates the queue:
bootstrap for a new user, self-heal for anyone `next` reports `stalled` for.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from leetmind.auth import AuthedUser, require_user
from leetmind.schemas import GenerationJobStatus, JobStub, PracticeNextResponse, ReplenishResponse

router = APIRouter(prefix="/api")


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
        SELECT status, repair_count FROM generation_jobs
        WHERE user_id = $1 AND status NOT IN ('ready', 'failed')
        ORDER BY created_at DESC
        LIMIT 1
        """,
        user.id,
    )
    if job is not None:
        return PracticeNextResponse(
            state="generating",
            job=JobStub(
                status=GenerationJobStatus(job["status"]), repair_count=job["repair_count"]
            ),
        )

    return PracticeNextResponse(state="stalled")


@router.post("/practice/replenish")
async def replenish(
    request: Request, user: AuthedUser = Depends(require_user)
) -> ReplenishResponse:
    worker = request.app.state.worker
    created = await worker.replenish(user.id)
    return ReplenishResponse(created=[str(job_id) for job_id in created])
