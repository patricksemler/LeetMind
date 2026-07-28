"""`GET /api/progress` (PLAN_BACKEND.md §9): rating history per type from `rating_updates`, plus
recent resolved problems."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from leetmind.auth import AuthedUser, require_user
from leetmind.schemas import ProgressResponse, RatingHistoryPoint, ResolvedProblemSummary

router = APIRouter(prefix="/api")

RECENT_LIMIT = 20


@router.get("/progress")
async def progress(request: Request, user: AuthedUser = Depends(require_user)) -> ProgressResponse:
    pool = request.app.state.pool

    history_rows = await pool.fetch(
        """
        SELECT type_slug, rating_before, rating_after, created_at
        FROM rating_updates
        WHERE user_id = $1
        ORDER BY created_at
        """,
        user.id,
    )
    problem_rows = await pool.fetch(
        """
        SELECT id, title, primary_type, status, resolved_at, problem_rating
        FROM problems
        WHERE user_id = $1 AND status IN ('solved', 'given_up')
        ORDER BY resolved_at DESC
        LIMIT $2
        """,
        user.id,
        RECENT_LIMIT,
    )

    return ProgressResponse(
        rating_history=[
            RatingHistoryPoint(
                type_slug=r["type_slug"],
                rating_before=r["rating_before"],
                rating_after=r["rating_after"],
                delta=r["rating_after"] - r["rating_before"],
                created_at=r["created_at"],
            )
            for r in history_rows
        ],
        recent_problems=[
            ResolvedProblemSummary(
                id=str(r["id"]),
                title=r["title"],
                primary_type=r["primary_type"],
                status=r["status"],
                resolved_at=r["resolved_at"],
                problem_rating=r["problem_rating"],
            )
            for r in problem_rows
        ],
    )
