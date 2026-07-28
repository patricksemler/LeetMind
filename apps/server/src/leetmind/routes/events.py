"""`GET /api/events` (PLAN_BACKEND.md §9): generation job transitions for the authenticated user,
over SSE. The worker publishes every transition via `pg_notify` on one shared channel (§7.1); this
route LISTENs on it and filters to the requesting user server-side, since a Postgres NOTIFY
channel has no per-listener addressing of its own.

Consumed with fetch-based streaming on the frontend, not the native `EventSource` API, which can't
send the `Authorization` header (§9) — this endpoint is a plain authenticated GET either way.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator

import asyncpg
from fastapi import APIRouter, Depends, Request
from sse_starlette.sse import EventSourceResponse

from leetmind.auth import AuthedUser, require_user
from leetmind.worker import NOTIFY_CHANNEL

logger = logging.getLogger("leetmind.routes.events")

router = APIRouter(prefix="/api")

HEARTBEAT_S = 15
_POLL_S = 1.0


@router.get("/events")
async def events(request: Request, user: AuthedUser = Depends(require_user)) -> EventSourceResponse:
    pool = request.app.state.pool

    async def stream() -> AsyncIterator[dict[str, str]]:
        queue: asyncio.Queue[str] = asyncio.Queue()

        def _on_notify(
            _connection: asyncpg.Connection, _pid: int, _channel: str, payload: str
        ) -> None:
            queue.put_nowait(payload)

        conn = await pool.acquire()
        try:
            await conn.add_listener(NOTIFY_CHANNEL, _on_notify)
            try:
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        payload = await asyncio.wait_for(queue.get(), timeout=_POLL_S)
                    except TimeoutError:
                        continue
                    try:
                        data = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    if data.get("user_id") != str(user.id):
                        continue
                    yield {"event": "generation", "data": json.dumps(data)}
            finally:
                with contextlib.suppress(asyncpg.InterfaceError):
                    await conn.remove_listener(NOTIFY_CHANNEL, _on_notify)
        finally:
            await pool.release(conn)

    return EventSourceResponse(stream(), ping=HEARTBEAT_S)
