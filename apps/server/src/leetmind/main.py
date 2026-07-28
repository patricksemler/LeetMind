from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from leetmind.config import get_settings
from leetmind.db import create_pool, run_migrations
from leetmind.routes import health, me


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    logging.basicConfig(level=settings.log_level.upper())

    pool = await create_pool(settings.database_url)
    applied = await run_migrations(pool)
    if applied:
        logging.getLogger("leetmind").info("applied migrations: %s", ", ".join(applied))

    app.state.pool = pool
    # The generation worker (PLAN_BACKEND.md §7.1) starts here once it exists (Phase 3).
    app.state.worker_started_at = None
    try:
        yield
    finally:
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

    return app


app = create_app()
