from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from leetmind.auth import AuthedUser, require_user
from leetmind.ratings import get_profile
from leetmind.schemas import MeResponse, TypeProfileView

router = APIRouter(prefix="/api")


@router.get("/me")
async def me(request: Request, user: AuthedUser = Depends(require_user)) -> MeResponse:
    profile = await get_profile(request.app.state.pool, user.id)
    return MeResponse(
        types=[
            TypeProfileView(
                slug=p.slug,
                name=p.name,
                rating=p.rating,
                attempts=p.attempts,
                evidenced=p.evidenced,
            )
            for p in profile
        ]
    )
