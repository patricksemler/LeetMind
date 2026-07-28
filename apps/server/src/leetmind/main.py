from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from leetmind.config import get_settings
from leetmind.db import create_pool, run_migrations
from leetmind.judge import JudgeClient
from leetmind.routes import events, execution, health, hints, me, practice, problems, progress
from leetmind.worker import GenerationWorker

MAX_BODY_BYTES = 128 * 1024  # §9: JSON bodies capped at 128 KB


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    logging.basicConfig(level=settings.log_level.upper())

    pool = await create_pool(settings.database_url)
    applied = await run_migrations(pool)
    if applied:
        logging.getLogger("leetmind").info("applied migrations: %s", ", ".join(applied))

    app.state.pool = pool
    app.state.worker_started_at = None
    inflight: set[uuid.UUID] = set()
    app.state.judge_inflight = inflight

    judge = JudgeClient(settings)
    worker = GenerationWorker(pool, judge=judge, settings=settings)
    app.state.judge = judge
    app.state.worker = worker

    worker_task: asyncio.Task[None] | None = None
    if settings.worker_enabled:
        app.state.worker_started_at = datetime.now(UTC)
        worker_task = asyncio.create_task(worker.run_forever())
    try:
        yield
    finally:
        if worker_task is not None:
            worker_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await worker_task
        await pool.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="LeetMind", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.web_origin],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def limit_body_size(request: Request, call_next):  # type: ignore[no-untyped-def]
        content_length = request.headers.get("content-length")
        if content_length is not None and int(content_length) > MAX_BODY_BYTES:
            return JSONResponse(status_code=413, content={"detail": "request body too large"})
        return await call_next(request)

    app.include_router(health.router)
    app.include_router(me.router)
    app.include_router(events.router)
    app.include_router(practice.router)
    app.include_router(problems.router)
    app.include_router(execution.router)
    app.include_router(hints.router)
    app.include_router(progress.router)

    return app


app = create_app()
