from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Parsed once at startup; a missing required var fails loudly at boot (PLAN_BACKEND.md §9)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

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


@lru_cache
def get_settings() -> Settings:
    return Settings()
