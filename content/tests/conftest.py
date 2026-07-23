from __future__ import annotations

import copy
import json
import os
import socket
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import psycopg
import pytest
from psycopg import sql
from ulid import ULID

from algolift_content.db import assert_test_database, set_test_schema, test_database_url

FIXTURES_DIR = Path(__file__).parent / "fixtures"
# packages/db/migrations/*.sql (content/tests -> content -> repo root -> packages/db/migrations).
MIGRATIONS_DIR = Path(__file__).parent.parent.parent / "packages" / "db" / "migrations"

# ---------------------------------------------------------------------------
# Test database isolation (docs/CONTRACTS.md §13 — NORMATIVE, MANDATORY).
#
# This runs at conftest import time — before pytest collects or imports a single test module —
# so it is the very first thing that happens in any `pytest` invocation under content/. Tests
# never read DATABASE_URL (which defaults to the development database); they read
# TEST_DATABASE_URL, guarded by assert_test_database so a misconfigured/unset TEST_DATABASE_URL
# fails the whole run loudly instead of truncating real data. Every test/fixture in this suite
# (and every module-level `get_settings()`/`get_pool()` call, since Settings reads DATABASE_URL
# from the environment) transitively goes through this redirection.
# ---------------------------------------------------------------------------
_TEST_DATABASE_URL = test_database_url()
assert_test_database(_TEST_DATABASE_URL)
os.environ["DATABASE_URL"] = _TEST_DATABASE_URL


# ---------------------------------------------------------------------------
# Schema-per-pytest-xdist-worker isolation (docs/CONTRACTS.md §13, "Concrete mechanism" 1-4).
#
# The guard above stops tests from ever touching the *development* database; it does nothing to
# stop two concurrent processes sharing `algolift_test` from colliding with EACH OTHER (two
# `pytest` processes truncating the same tables deadlock — the concrete, observed defect this
# section documents). The fix composes with the guard rather than replacing it: this block runs
# strictly after the guard above, and only changes WHICH SCHEMA inside the already-guarded
# database gets used.
#
# `PYTEST_XDIST_WORKER` ("gw0", "gw1", ...) is set by pytest-xdist in each worker process's
# environment once `-n` spawns it; unset for a plain single-process `pytest` run (`-n` omitted),
# which keeps that case exactly as fast/simple as today — no schema created, no migrations
# applied, straight onto `public`, matching every other repo convention (e.g. `algolift_test`
# itself is documented as "exists and is migrated" ahead of time).
# ---------------------------------------------------------------------------


def _xdist_worker_schema() -> str | None:
    """`f"pytest_{worker}"` when running under `pytest-xdist -n`, else `None` (meaning: use the
    default `public` schema, today's unchanged behaviour)."""
    worker = os.environ.get("PYTEST_XDIST_WORKER")
    return f"pytest_{worker}" if worker else None


def _ensure_schema_migrated(url: str, schema: str, migrations_dir: Path) -> None:
    """Creates `schema` if missing and applies every `packages/db/migrations/*.sql` file into it
    that isn't already recorded as applied (tracked via a schema-local `schema_migrations` table,
    the same bookkeeping `packages/db/src/migrate.ts`'s `up()` uses) — so a worker schema left
    over from a previous run is self-healing (CONTRACTS.md §13 rule 5) rather than re-applying
    migrations that would fail on already-existing tables.

    This applies the migration SQL files directly from Python rather than shelling out to the TS
    runner (`tsx packages/db/src/migrate.ts up`): content/ has no Node/tsx runtime dependency
    today, and invoking one here only to run search_path-scoped SQL would add a cross-language
    process-spawn dependency for no behavioural difference — the SQL executed is byte-for-byte the
    same `*.sql` file either way, applied with the same one-transaction-per-file /
    already-applied-versions-skipped bookkeeping migrate.ts itself uses. If migrate.ts's
    bookkeeping logic (not just the SQL) ever grows real complexity worth not duplicating, that's
    the point to switch to shelling out instead.
    """
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(sql.Identifier(schema)))
        conn.execute(sql.SQL("SET search_path TO {}, public").format(sql.Identifier(schema)))
        conn.execute(
            """
            create table if not exists schema_migrations (
              version text primary key,
              applied_at timestamptz not null default now()
            )
            """
        )
        applied = {row[0] for row in conn.execute("select version from schema_migrations").fetchall()}

        for path in sorted(migrations_dir.glob("*.sql")):
            version = path.stem
            if version in applied:
                continue
            migration_sql = path.read_text()
            conn.execute("BEGIN")
            try:
                conn.execute(migration_sql)  # type: ignore[arg-type]
                conn.execute(
                    "insert into schema_migrations (version) values (%s)", (version,)
                )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise


_TEST_SCHEMA = _xdist_worker_schema()
if _TEST_SCHEMA is not None:
    _ensure_schema_migrated(_TEST_DATABASE_URL, _TEST_SCHEMA, MIGRATIONS_DIR)
set_test_schema(_TEST_SCHEMA)


@pytest.fixture()
def sample_problem_dict() -> dict:
    """Loads `tests/fixtures/sample_problem.json` — a complete, valid ProblemVersion for
    "maximum sum of a length-k subarray"."""
    with open(FIXTURES_DIR / "sample_problem.json") as f:
        return json.load(f)


def postgres_reachable(timeout: float = 1.0) -> bool:
    """Cheap TCP-level reachability probe (doesn't require valid credentials, just that
    something is listening) used to decide whether DB-dependent tests should skip. Always probes
    TEST_DATABASE_URL (docs/CONTRACTS.md §13), never DATABASE_URL directly."""
    try:
        parsed = urlparse(test_database_url())
        host = parsed.hostname or "localhost"
        port = parsed.port or 5432
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    """Best-effort `DROP SCHEMA ... CASCADE` for this worker's schema at the end of the run
    (docs/CONTRACTS.md §13 rule 5: teardown is optional and idempotent either way — a leftover
    schema self-heals via `_ensure_schema_migrated`'s `IF NOT EXISTS` + already-applied-versions
    skip on the next run, so failing to clean up here is never a correctness problem, only
    housekeeping). Wrapped in try/except so a teardown hiccup (e.g. Postgres already gone) never
    turns a green test run red."""
    if _TEST_SCHEMA is None or not postgres_reachable():
        return
    try:
        with psycopg.connect(_TEST_DATABASE_URL, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(_TEST_SCHEMA)))
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Verification-gate DB fixtures (content/algolift_content/verification/*).
#
# Uses the REAL migrated schema (packages/db/migrations/001_init.sql /
# 002_seed_taxonomy.sql) rather than a local fixture schema, since the verification gate's own
# runner reads/writes `problem_versions` / `problem_concepts` / `verification_reports` directly.
# Each inserted `problems` row is deleted (cascades to problem_versions -> problem_concepts /
# verification_reports) in a fixture finalizer, so tests never truncate shared tables.
# ---------------------------------------------------------------------------


def fresh_problem_version_content(sample_problem_dict: dict[str, Any]) -> dict[str, Any]:
    """Returns a deep copy of `sample_problem_dict` with fresh `problem_id` (so parallel test
    runs never collide on the `problem_versions(problem_id, version)` unique constraint)."""
    content = copy.deepcopy(sample_problem_dict)
    content["problem_id"] = str(ULID())
    return content


@pytest.fixture()
def make_problem_version() -> Iterator[Any]:
    """Yields a factory `make_problem_version(content_dict) -> version_id` that inserts a
    `problems` row and a `state='candidate'` `problem_versions` row (content = the given dict,
    verbatim) using the real schema. Every version_id it hands out is deleted (via its `problems`
    row, cascading) when the test finishes."""
    from psycopg.types.json import Json

    from algolift_content.db import get_pool

    pool = get_pool()
    created_problem_ids: list[str] = []

    def factory(content: dict[str, Any]) -> str:
        problem_id = content["problem_id"]
        version_id = str(ULID())
        with pool.connection() as conn:
            conn.execute(
                "insert into problems (id, internal_name) values (%s, %s)",
                (problem_id, content.get("internal_name", "test_problem")),
            )
            conn.execute(
                """
                insert into problem_versions
                  (id, problem_id, version, state, content, title, difficulty_rating,
                   difficulty_confidence, comparator, provenance)
                values (%s, %s, %s, 'candidate', %s, %s, %s, %s, %s, %s)
                """,
                (
                    version_id,
                    problem_id,
                    content.get("version", 1),
                    Json(content),
                    content.get("title", "Test Problem"),
                    content.get("difficulty", {}).get("rating", 1000),
                    content.get("difficulty", {}).get("confidence", "generated"),
                    content.get("comparator", "exact"),
                    Json(content.get("provenance", {})),
                ),
            )
        created_problem_ids.append(problem_id)
        return version_id

    yield factory

    with pool.connection() as conn:
        for pid in created_problem_ids:
            # problem_versions.problem_id -> problems.id has no ON DELETE CASCADE (only rows
            # keyed off problem_versions.id, e.g. problem_concepts/verification_reports, cascade)
            # so the version row must go first.
            conn.execute("delete from problem_versions where problem_id = %s", (pid,))
            conn.execute("delete from problems where id = %s", (pid,))


@pytest.fixture()
def fast_settings() -> Any:
    """A `Settings` instance identical to the real environment except
    `VERIFY_DIFFERENTIAL_CASES` is cut down, so the full six-stage gate runs against real Docker
    in a few seconds per test instead of the production default (200 cases)."""
    from algolift_content.config import Settings

    return Settings(VERIFY_DIFFERENTIAL_CASES=25)
