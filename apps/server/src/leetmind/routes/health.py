from __future__ import annotations

import asyncio

import asyncpg
from fastapi import APIRouter, Request

router = APIRouter()


async def _docker_available() -> bool:
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker",
            "info",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        return await asyncio.wait_for(proc.wait(), timeout=5) == 0
    except (FileNotFoundError, TimeoutError):
        return False


@router.get("/health")
async def health(request: Request) -> dict[str, bool | str]:
    pool = request.app.state.pool
    try:
        await asyncio.wait_for(pool.fetchval("SELECT 1"), timeout=5)
        db_ok = True
    except (asyncpg.PostgresError, OSError, TimeoutError):
        db_ok = False

    docker_ok = await _docker_available()

    # The generation worker doesn't exist yet (PLAN_BACKEND.md Phase 3); report its absence
    # honestly rather than faking a heartbeat.
    worker_started_at = request.app.state.worker_started_at
    worker_status = "not_started" if worker_started_at is None else "ok"

    healthy = db_ok and docker_ok
    return {
        "status": "ok" if healthy else "degraded",
        "db": db_ok,
        "docker": docker_ok,
        "worker": worker_status,
    }
