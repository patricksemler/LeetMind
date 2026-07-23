from __future__ import annotations

import pytest

from algolift_content.config import Settings, get_settings

# Every content-relevant var from CONTRACTS.md §2, since Settings.model_config picks up
# whatever's actually in the process environment regardless of env_file.
_ALL_KEYS = [
    "DATABASE_URL",
    "PGPOOL_MAX",
    "LOG_LEVEL",
    "SINGLE_USER_ID",
    "CONTENT_WORKER_ID",
    "GENERATOR_INVOKER",
    "CLAUDE_BIN",
    "GENERATOR_TIMEOUT_MS",
    "GENERATOR_MAX_SCHEMA_RETRIES",
    "BUFFER_LOW_WATERMARK",
    "REPLENISH_INTERVAL_MS",
    "VERIFY_DIFFERENTIAL_CASES",
    "SANDBOX_PYTHON_IMAGE",
    "SANDBOX_CPP_IMAGE",
    "SANDBOX_MEMORY_MB",
    "SANDBOX_CPUS",
    "SANDBOX_PIDS_LIMIT",
    "SANDBOX_WALL_TIMEOUT_MS",
    "SANDBOX_OUTPUT_LIMIT_BYTES",
    "SANDBOX_WORK_DIR",
    "DOCKER_BIN",
    "QUEUE_LEASE_SECONDS",
    "QUEUE_HEARTBEAT_MS",
    "QUEUE_REAPER_INTERVAL_MS",
    "QUEUE_POLL_INTERVAL_MS",
    "ALGOLIFT_REPO_ROOT",
]


@pytest.fixture(autouse=True)
def _clear_settings_cache() -> None:
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture()
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in _ALL_KEYS:
        monkeypatch.delenv(key, raising=False)


def test_defaults_match_contracts(_clean_env: None) -> None:
    """Every content-relevant var has a default (CONTRACTS.md §2's Default column), and those
    defaults must match exactly."""
    settings = Settings(_env_file=None)  # type: ignore[call-arg]

    assert settings.DATABASE_URL == "postgres://algolift:algolift@localhost:5432/algolift"
    assert settings.PGPOOL_MAX == 10
    assert settings.LOG_LEVEL == "info"
    assert settings.SINGLE_USER_ID == "00000000000000000000000001"

    # CONTENT_WORKER_ID default is `${hostname}-${pid}`, computed at process start.
    assert settings.CONTENT_WORKER_ID
    assert "-" in settings.CONTENT_WORKER_ID

    assert settings.GENERATOR_INVOKER == "claude"
    assert settings.CLAUDE_BIN == "claude"
    assert settings.GENERATOR_TIMEOUT_MS == 600_000
    assert settings.GENERATOR_MAX_SCHEMA_RETRIES == 2
    assert settings.BUFFER_LOW_WATERMARK == 3
    assert settings.REPLENISH_INTERVAL_MS == 60_000
    assert settings.VERIFY_DIFFERENTIAL_CASES == 200

    assert settings.SANDBOX_PYTHON_IMAGE == "algolift/runner-python:1"
    assert settings.SANDBOX_CPP_IMAGE == "algolift/runner-cpp:1"
    assert settings.SANDBOX_MEMORY_MB == 256
    assert settings.SANDBOX_CPUS == 1.0
    assert settings.SANDBOX_PIDS_LIMIT == 64
    assert settings.SANDBOX_WALL_TIMEOUT_MS == 10_000
    assert settings.SANDBOX_OUTPUT_LIMIT_BYTES == 65_536
    assert settings.SANDBOX_WORK_DIR == "/tmp/algolift-sandbox"
    assert settings.DOCKER_BIN == "docker"

    assert settings.QUEUE_LEASE_SECONDS == 30
    assert settings.QUEUE_HEARTBEAT_MS == 10_000
    assert settings.QUEUE_REAPER_INTERVAL_MS == 5_000
    assert settings.QUEUE_POLL_INTERVAL_MS == 500

    assert settings.ALGOLIFT_REPO_ROOT is None


def test_missing_or_invalid_env_fails_loudly(monkeypatch: pytest.MonkeyPatch) -> None:
    """No content var is strictly *required* (every one has a documented default per
    CONTRACTS.md §2) — but an invalid value for one must still fail loudly at load time with a
    clear listing of what's wrong, per CONTRACTS.md §1 ("Config... Missing required env vars
    must fail loudly at boot, never at first use")."""
    monkeypatch.setenv("PGPOOL_MAX", "not-a-number")
    with pytest.raises(RuntimeError, match="PGPOOL_MAX"):
        get_settings()


def test_invalid_generator_invoker_fails_loudly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GENERATOR_INVOKER", "not-a-real-invoker")
    with pytest.raises(RuntimeError, match="GENERATOR_INVOKER"):
        get_settings()


def test_get_settings_is_cached(_clean_env: None) -> None:
    a = get_settings()
    b = get_settings()
    assert a is b
