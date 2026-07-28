from __future__ import annotations

import uuid
from dataclasses import dataclass
from functools import lru_cache

import jwt
from fastapi import Depends, HTTPException, Request, status

from leetmind.config import Settings, get_settings

_AUDIENCE = "authenticated"


@dataclass(frozen=True)
class AuthedUser:
    id: uuid.UUID
    email: str | None


@lru_cache
def _jwks_client(supabase_url: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(f"{supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json")


def _decode(token: str, settings: Settings) -> dict[str, object]:
    """Verify a Supabase-issued access token.

    Which path a token takes is decided by its own header (`alg`), so a project mid-rotation from
    a shared HS256 secret to asymmetric keys works either way (PLAN_BACKEND.md §2 row 4).
    """
    header = jwt.get_unverified_header(token)
    if header.get("alg") == "HS256":
        if not settings.supabase_jwt_secret:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, "server has no SUPABASE_JWT_SECRET configured"
            )
        return jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience=_AUDIENCE,
        )

    if not settings.supabase_url:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "server has no SUPABASE_URL configured")
    signing_key = _jwks_client(settings.supabase_url).get_signing_key_from_jwt(token)
    return jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256", "ES256"],
        audience=_AUDIENCE,
    )


async def require_user(
    request: Request, settings: Settings = Depends(get_settings)
) -> AuthedUser:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    token = header[len("bearer ") :].strip()

    try:
        claims = _decode(token, settings)
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"invalid token: {exc}") from exc

    sub = claims.get("sub")
    if not isinstance(sub, str):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token missing a valid sub claim")
    try:
        user_id = uuid.UUID(sub)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "token missing a valid sub claim"
        ) from exc

    email = claims.get("email")
    return AuthedUser(id=user_id, email=email if isinstance(email, str) else None)
