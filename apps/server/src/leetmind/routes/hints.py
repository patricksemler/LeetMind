"""`POST /api/problems/{id}/hints/{rung}` (PLAN_BACKEND.md §9).

Requires the problem opened; reveals rung `n` only once rungs `1..n-1` are already revealed.
Locks the `problems` row (not `hint_reveals`, which has no natural single row) so two concurrent
reveal calls for the same problem serialize instead of racing past the "in order" check.
"""

from __future__ import annotations

import uuid
from typing import Annotated

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Path, Request, status

from leetmind.auth import AuthedUser, require_user
from leetmind.db import load_jsonb
from leetmind.routes.problems import require_problem
from leetmind.schemas import HintResponse

router = APIRouter(prefix="/api")

MAX_RUNG = 4


@router.post("/problems/{problem_id}/hints/{rung}")
async def reveal_hint(
    problem_id: uuid.UUID,
    rung: Annotated[int, Path(ge=1, le=MAX_RUNG)],
    request: Request,
    user: AuthedUser = Depends(require_user),
    problem: asyncpg.Record = Depends(require_problem),
) -> HintResponse:
    if problem["served_at"] is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "not_opened")
    if problem["status"] != "active":
        raise HTTPException(status.HTTP_409_CONFLICT, "problem is not active")

    pool = request.app.state.pool
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("SELECT 1 FROM problems WHERE id = $1 FOR UPDATE", problem_id)
        rows = await conn.fetch("SELECT rung FROM hint_reveals WHERE problem_id = $1", problem_id)
        revealed = {r["rung"] for r in rows}
        if rung not in revealed:
            missing = sorted(set(range(1, rung)) - revealed)
            if missing:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    f"reveal hints in order; missing rung(s) {missing}",
                )
            await conn.execute(
                "INSERT INTO hint_reveals (problem_id, rung) VALUES ($1, $2) "
                "ON CONFLICT (problem_id, rung) DO NOTHING",
                problem_id,
                rung,
            )

    hints: list[str] = load_jsonb(problem["hints"])
    return HintResponse(rung=rung, text=hints[rung - 1])
