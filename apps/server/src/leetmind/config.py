from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# apps/server/.env, anchored to this file rather than the CWD so launching from the repo root
# doesn't silently load the legacy root .env instead. A missing file is fine (every field has a
# default; the Docker image ships no .env at all).
_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    """Parsed once at startup; a missing required var fails loudly at boot (PLAN_BACKEND.md §9)."""

    model_config = SettingsConfigDict(env_file=_ENV_FILE, extra="ignore")

    database_url: str = Field(
        default="postgres://leetmind:leetmind@localhost:5432/leetmind",
        description="asyncpg DSN for the primary pool.",
    )
    test_database_url: str | None = Field(
        default=None,
        description="Used by the test suite only. Must end in '_test' or be exactly 'test' "
        "(enforced by assert_test_database in db.py) — tests never touch database_url.",
    )

    # Presence of supabase_url is what turns auth on; production must set it (see auth.py).
    supabase_url: str | None = None
    # Symmetric HS256 secret. Leave unset for projects that sign with asymmetric keys (hosted
    # Supabase, local `supabase start`) — those verify against the project's published JWKS.
    supabase_jwt_secret: str | None = None

    web_origin: str = "http://localhost:5173"

    host: str = "0.0.0.0"
    port: int = 8080
    log_level: str = "info"

    # Judge tunables (PLAN_BACKEND.md §8, §13).
    judge_image: str = "leetmind-judge"
    judge_concurrency: int = 4
    judge_interactive_wall_s: float = 60.0
    judge_verify_wall_s: float = 300.0
    judge_per_test_limit_s: float = 2.0
    judge_oracle_limit_s: float = 10.0
    judge_memory: str = "256m"
    judge_cpus: str = "1"
    judge_pids_limit: int = 64

    # LLM CLI transport (PLAN_BACKEND.md §7.5, decision 12). `llm_args` is a whitespace-split
    # extra-flags string (e.g. the CLI's own tool-disable flags) — kept in config, not code, so
    # flags can change without a deploy.
    llm_cli: str = "claude"  # "claude" (default), "codex", or "fixture" (canned responses, §12)
    llm_bin: str | None = None  # override the executable name/path; defaults to llm_cli
    llm_model: str = "claude-sonnet-5"
    llm_effort: Literal["low", "medium", "high", "xhigh", "max"] = "low"
    llm_args: str = ""
    llm_timeout_s: float = 600.0
    # Amendment 40: cwd + a read-only sandbox alone doesn't stop absolute-path reads; this is an
    # optional genuine boundary (its own container, no volume mounts beyond the temp/auth dirs)
    # for hosted deployments. Off by default — local-first (decision 19).
    llm_container: bool = False
    llm_container_image: str = "leetmind-llm-cli"

    # Generation worker (PLAN_BACKEND.md §7.1, §13).
    worker_enabled: bool = True
    worker_concurrency: int = Field(default=2, ge=1, le=8)
    worker_poll_interval_s: float = 2.0
    worker_heartbeat_interval_s: float = 60.0
    worker_lease_stale_s: float = 300.0
    generation_job_timeout_s: float = Field(default=120.0, ge=30.0)
    generation_repair_min_remaining_s: float = Field(default=35.0, ge=1.0)
    generation_background_restart_limit: int = Field(default=2, ge=0, le=5)


@lru_cache
def get_settings() -> Settings:
    return Settings()
