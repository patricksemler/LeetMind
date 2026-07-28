"""Ratings lazy-init and profile read (PLAN_BACKEND.md §4, §9). The server never writes to
`auth.users` and has no signup hook, so a user's 20 rating rows don't exist until something asks
for them; every read path ensures them first, in the same transaction, so a first-ever request
can't race a second one into inserting the same row twice (`ON CONFLICT DO NOTHING` makes it
harmless either way)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

import asyncpg


@dataclass(frozen=True)
class TypeProfile:
    slug: str
    name: str
    rating: float
    attempts: int

    @property
    def evidenced(self) -> bool:
        return self.attempts > 0


async def ensure_ratings(conn: Any, user_id: UUID) -> None:
    """Insert any of the 20 taxonomy rows this user doesn't have yet, seeded at DEFAULT_RATING /
    0 attempts by the column defaults (§4)."""
    await conn.execute(
        """
        INSERT INTO ratings (user_id, type_slug)
        SELECT $1, slug FROM problem_types
        ON CONFLICT (user_id, type_slug) DO NOTHING
        """,
        user_id,
    )


async def get_profile(pool: asyncpg.Pool, user_id: UUID) -> list[TypeProfile]:
    """The full per-type profile (`/api/me`), taxonomy-ordered, ratings lazily created first."""
    async with pool.acquire() as conn, conn.transaction():
        await ensure_ratings(conn, user_id)
        rows = await conn.fetch(
            """
            SELECT pt.slug, pt.name, r.rating, r.attempts
            FROM problem_types pt
            JOIN ratings r ON r.type_slug = pt.slug AND r.user_id = $1
            ORDER BY pt.ordinal
            """,
            user_id,
        )
    return [
        TypeProfile(
            slug=row["slug"], name=row["name"], rating=row["rating"], attempts=row["attempts"]
        )
        for row in rows
    ]
