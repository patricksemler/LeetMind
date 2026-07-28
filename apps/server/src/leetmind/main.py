from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from leetmind.config import get_settings
from leetmind.db import create_pool, run_migrations
from leetmind.judge import JudgeClient
from leetmind.routes import events, health, me
from leetmind.worker import GenerationWorker


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

    app.include_router(health.router)
    app.include_router(me.router)
    app.include_router(events.router)

    return app


app = create_app()
