"""Configuration for the content plane, parsed once at startup.

Mirrors `packages/shared/src/config.ts` on the TS side and docs/CONTRACTS.md §2. Missing/invalid
required env vars must fail loudly at import/first-load time — never at first use — per
CONTRACTS.md §1 ("Config").

Usage:
    from leetmind_content.config import get_settings
    settings = get_settings()  # cached; raises on first call if env is invalid
"""

from __future__ import annotations

import os
import socket
from functools import lru_cache
from typing import Literal

from pydantic import Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

GeneratorInvoker = Literal["claude", "codex", "stub"]


def _default_worker_id() -> str:
    return f"{socket.gethostname()}-{os.getpid()}"


class Settings(BaseSettings):
    """All env vars relevant to the content plane, per CONTRACTS.md §2.

    `CONTENT_WORKER_ID` and (for parity with the judge side) worker-id-shaped defaults are
    computed at process start when unset, matching the TS convention
    (`${hostname}-${pid}`) documented in `.env.example`.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=True,
    )

    # --- core / shared -----------------------------------------------------
    DATABASE_URL: str = "postgres://leetmind:leetmind@localhost:5432/leetmind"
    PGPOOL_MAX: int = 10
    LOG_LEVEL: str = "info"
    SINGLE_USER_ID: str = "00000000000000000000000001"

    # --- content -------------------------------------------------------------
    CONTENT_WORKER_ID: str = Field(default_factory=_default_worker_id)
    GENERATOR_INVOKER: GeneratorInvoker = "claude"
    CLAUDE_BIN: str = "claude"
    #: Model passed as `claude -p ... --model <GENERATOR_MODEL>` (CONTRACTS.md §11). Unset (the
    #: default) means no `--model` flag at all, i.e. whatever the CLI defaults to — but generation
    #: quality is the product's ceiling (PLAN.md §12 risk 1), so which model runs generation
    #: should be a recorded, deliberate choice, not an accident of the CLI's own default.
    GENERATOR_MODEL: str | None = None
    GENERATOR_TIMEOUT_MS: int = 600_000
    GENERATOR_MAX_SCHEMA_RETRIES: int = 2
    BUFFER_LOW_WATERMARK: int = 3
    REPLENISH_INTERVAL_MS: int = 60_000
    VERIFY_DIFFERENTIAL_CASES: int = 200

    # --- sandbox (@leetmind/sandbox, used by judge/content) -----------------
    SANDBOX_PYTHON_IMAGE: str = "leetmind/runner-python:1"
    SANDBOX_CPP_IMAGE: str = "leetmind/runner-cpp:1"
    SANDBOX_MEMORY_MB: int = 256
    SANDBOX_CPUS: float = 1.0
    SANDBOX_PIDS_LIMIT: int = 64
    SANDBOX_WALL_TIMEOUT_MS: int = 10_000
    SANDBOX_OUTPUT_LIMIT_BYTES: int = 65_536
    SANDBOX_WORK_DIR: str = "/tmp/leetmind-sandbox"
    DOCKER_BIN: str = "docker"

    # --- queue (@leetmind/queue, used by judge/content) ----------------------
    QUEUE_LEASE_SECONDS: int = 30
    QUEUE_HEARTBEAT_MS: int = 10_000
    QUEUE_REAPER_INTERVAL_MS: int = 5_000
    QUEUE_POLL_INTERVAL_MS: int = 500

    # --- repo location --------------------------------------------------------
    LEETMIND_REPO_ROOT: str | None = None


def _format_validation_error(exc: ValidationError) -> str:
    lines = [
        f"  - {'.'.join(str(p) for p in err['loc']) or '(root)'}: {err['msg']}"
        for err in exc.errors()
    ]
    header = "Invalid or missing environment variables for leetmind_content.config.Settings:"
    return header + "\n" + "\n".join(lines)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Loads and caches Settings. Fails loudly (raises RuntimeError) with a clear listing of
    what's wrong/missing, rather than deferring to first use of a bad value."""
    try:
        return Settings()
    except ValidationError as exc:
        raise RuntimeError(_format_validation_error(exc)) from exc
