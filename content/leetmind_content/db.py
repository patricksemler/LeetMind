"""psycopg 3 connection pool + query helpers for the content plane.

One process-wide pool built from `DATABASE_URL` (CONTRACTS.md §2), using `dict_row` so query
results come back as `dict[str, Any]` rows (matching the shape `models.py` / `queue.py` expect).
Slow queries (>250ms) are logged at warn.
"""

from __future__ import annotations

import contextvars
import os
import re
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from urllib.parse import urlparse

from psycopg import Connection, sql
from psycopg.pq import TransactionStatus
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from leetmind_content.config import get_settings
from leetmind_content.logging import get_logger

log = get_logger("content-db")

_SLOW_QUERY_MS = 250

_pool: ConnectionPool | None = None


# ---------------------------------------------------------------------------
# Test database isolation guard (docs/CONTRACTS.md §13 — NORMATIVE).
#
# A data-loss defect was found in this repo: several test suites ran `truncate table jobs,
# model_runs, verification_reports, ...` against `DATABASE_URL`, which defaults to the
# **development** database. Since LeetMind is a tool its author uses daily, that silently
# destroyed real practice history.
#
# The fix is defence in depth: destructive test fixtures must never touch a database whose name
# doesn't unambiguously mark it as a test database. `assert_test_database` is that check — call
# it before any truncate/drop, and let it raise rather than continuing.
# ---------------------------------------------------------------------------

#: Default `TEST_DATABASE_URL` per docs/CONTRACTS.md §13 — same instance as `DATABASE_URL`, but
#: the `leetmind_test` database instead of `leetmind`.
DEFAULT_TEST_DATABASE_URL = "postgres://leetmind:leetmind@localhost:5432/leetmind_test"

_TEST_DB_NAME_PATTERN = re.compile(r"(^|_)test$")


def test_database_url() -> str:
    """Returns `TEST_DATABASE_URL`, or the documented default. Tests should call this instead of
    reading `DATABASE_URL` (which defaults to the development database) directly."""
    return os.environ.get("TEST_DATABASE_URL") or DEFAULT_TEST_DATABASE_URL


def _extract_database_name(url: str) -> str | None:
    """Extracts the database name (path component, leading slash stripped) from a Postgres
    connection string. Returns None if the string doesn't parse as a connection string at all
    (no scheme, no host)."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    if not parsed.scheme or not parsed.netloc:
        return None
    return parsed.path.lstrip("/")


def assert_test_database(url: str) -> None:
    """Raises `RuntimeError` unless `url`'s database name is exactly `test` or ends in `_test`.
    This is the guard that makes misconfiguration impossible: an operator who exports the wrong
    `TEST_DATABASE_URL` gets a loud, failed test run instead of a wiped database. Call this
    before any destructive fixture (truncate/drop) runs — never after."""
    db_name = _extract_database_name(url)

    if db_name is None:
        raise RuntimeError(
            f'assert_test_database: malformed database connection string ("{url}") — could not '
            "parse a database name out of it. Destructive test fixtures refuse to run without a "
            'connection string that clearly names a test database (name ending in "_test", e.g. '
            '"leetmind_test").'
        )

    if not db_name:
        raise RuntimeError(
            f'assert_test_database: connection string ("{url}") has no database name. '
            'Destructive test fixtures refuse to run without a database name ending in "_test" '
            '(or exactly "test"). Set TEST_DATABASE_URL to e.g. '
            '"postgres://leetmind:leetmind@localhost:5432/leetmind_test".'
        )

    if not _TEST_DB_NAME_PATTERN.search(db_name):
        raise RuntimeError(
            f'assert_test_database: refusing to run destructive test fixtures against database '
            f'"{db_name}" — its name does not end in "_test" (or equal "test"). This guard exists '
            "because a prior data-loss incident truncated real practice history when tests ran "
            "against the development database (docs/CONTRACTS.md §13). Point TEST_DATABASE_URL "
            'at a database whose name ends in "_test", e.g. '
            '"postgres://leetmind:leetmind@localhost:5432/leetmind_test".'
        )


# ---------------------------------------------------------------------------
# Schema-per-worker test isolation (docs/CONTRACTS.md §13 — NORMATIVE).
#
# `assert_test_database` (above) stops tests from ever running destructive fixtures against the
# *development* database, but does nothing to stop two concurrent `pytest` processes from
# colliding with EACH OTHER inside the *same* `leetmind_test` database — both truncating the same
# `jobs` table deadlocks, and both `INSERT`ing/`DELETE`ing rows the other doesn't own corrupts
# state (`apps/judge`'s `assertNoStrayJobs()` guard caught exactly this happening for real, per
# §13). The fix composes with the guard rather than replacing it: every connection this pool hands
# out is additionally pinned to a schema — `content/tests/conftest.py` computes that schema name
# from `PYTEST_XDIST_WORKER` and calls `set_test_schema()` before any test runs, so worker gw0's
# `TRUNCATE jobs` and worker gw1's `TRUNCATE jobs` are different relations in different schemas,
# not the same row range in one shared table.
# ---------------------------------------------------------------------------

_test_schema: str | None = None


def set_test_schema(schema: str | None) -> None:
    """Sets the schema every connection `get_pool()` hands out from now on should resolve
    unqualified table names into (via `search_path`). Must be called before `get_pool()` is first
    invoked in this process — the pool is created once and memoized, and `configure_connection`
    (below) is baked into it at that point as its `configure=` callback. `None` (the default)
    leaves connections on the server's ordinary `search_path` (`"$user", public`) — i.e. today's
    behaviour, unchanged. This is test-only machinery, but it lives here (not in `conftest.py`)
    because `get_pool()`'s `configure=` hook is the only place a psycopg_pool connection can be
    reconfigured per-connection (docs/CONTRACTS.md §13: "search_path must be set per connection...
    a configure= callback on the pool is the natural hook")."""
    global _test_schema
    _test_schema = schema


def configure_connection(conn: Connection) -> None:
    """`ConnectionPool(configure=...)` callback: runs on every new physical connection the pool
    creates (not once globally — psycopg_pool calls this per-connection, exactly what `SET
    search_path` needs, since it's session-scoped state on the physical connection). A no-op
    unless `set_test_schema()` has been called."""
    if _test_schema:
        conn.execute(sql.SQL("SET search_path TO {}, public").format(sql.Identifier(_test_schema)))


def get_pool() -> ConnectionPool:
    """Returns the process-wide connection pool, creating it on first call. Pool size is
    `PGPOOL_MAX` (CONTRACTS.md §2)."""
    global _pool
    if _pool is None:
        settings = get_settings()
        _pool = ConnectionPool(
            conninfo=settings.DATABASE_URL,
            min_size=1,
            max_size=settings.PGPOOL_MAX,
            kwargs={"row_factory": dict_row, "autocommit": True},
            configure=configure_connection,
            open=True,
        )
    return _pool


def close_pool() -> None:
    """Closes and forgets the process-wide pool. Mainly for test teardown / clean shutdown."""
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


# ---------------------------------------------------------------------------
# Reentrant connection acquisition.
#
# `pool.connection()` checks out a FRESH connection from the pool on every call. That makes a
# nested `connection()`/`transaction()` acquired *inside* an already-open `transaction()` block
# get a *different* physical connection — one that cannot see the outer transaction's uncommitted
# writes (Postgres MVCC visibility is per-connection/per-session, not per-process). This was a
# real, intermittent bug (see tests/test_db_nesting.py): with a small pool under light load the
# pool tends to hand back the SAME connection each time and the bug hides; under concurrent load
# it hands out a second one and reads silently miss the outer transaction's own writes.
#
# The fix: track the "ambient" connection for the current context (task/thread) in a ContextVar.
# `contextvars.ContextVar` is per-task under asyncio and per-thread under plain threads, which is
# exactly the isolation we want — `queue.run_worker` runs each job on its own thread, and threads
# must never share an ambient connection with each other (see
# test_db_nesting.py::test_threads_get_independent_ambient_connections).
# ---------------------------------------------------------------------------

_ambient_connection: contextvars.ContextVar[Connection | None] = contextvars.ContextVar(
    "_ambient_connection", default=None
)


@contextmanager
def _ambient_or_checkout() -> Iterator[Connection]:
    """Yields the ambient connection for this context if one is already open; otherwise checks
    one out from the pool and makes it ambient (via a `ContextVar` token, reset on exit — nesting
    is not assumed to be well-behaved, e.g. under generator/async edge cases) for the duration of
    the block, so anything nested inside observes the same connection."""
    ambient = _ambient_connection.get()
    if ambient is not None:
        yield ambient
        return

    pool = get_pool()
    with pool.connection() as conn:
        token = _ambient_connection.set(conn)
        try:
            yield conn
        finally:
            _ambient_connection.reset(token)


@contextmanager
def connection() -> Iterator[Connection]:
    """Yields a connection (autocommit, unless an ambient transaction is open) for the duration
    of the block. Reentrant: if this context is already inside an open `connection()` /
    `transaction()` block, yields that SAME connection rather than checking out a second one —
    otherwise the nested acquisition could not see the outer block's uncommitted writes."""
    with _ambient_or_checkout() as conn:
        yield conn


@contextmanager
def transaction() -> Iterator[Connection]:
    """Yields a connection running an explicit transaction: commits on clean exit, rolls back on
    exception. Use this (not `connection()`) whenever a caller needs enqueue + other writes to be
    atomic, per CONTRACTS.md §5 ("enqueue must accept a caller-supplied client so it joins the
    caller's transaction").

    Reentrant and savepoint-nested: if this context is already inside an open `connection()` /
    `transaction()` block, this call reuses that SAME connection (see `_ambient_or_checkout`)
    instead of checking out a second one. If that connection already has an open transaction, this
    call JOINS it — psycopg3's `Connection.transaction()` detects the connection is already
    mid-transaction and nests itself as a `SAVEPOINT` rather than a fresh `BEGIN`, so:

      - only the OUTERMOST `transaction()` call on a given connection actually commits/rolls back
        the real transaction (and toggles `autocommit`) — an inner call's exit only releases (on
        success) or rolls back to (on exception) its own savepoint;
      - an inner block that raises rolls back only the writes made since IT was entered. If the
        caller catches that exception (inside an enclosing `transaction()` block), the outer's own
        earlier writes are untouched and still commit normally on the outer's clean exit.

    This is psycopg3's native nesting (native `Connection.transaction()`), not a hand-rolled
    reimplementation — see tests/test_db_nesting.py for the regression coverage."""
    with _ambient_or_checkout() as conn:
        already_in_transaction = conn.info.transaction_status != TransactionStatus.IDLE
        if already_in_transaction:
            # Join the ambient transaction as a savepoint — do NOT touch autocommit or commit/
            # rollback the real transaction; the outermost owner (below) does that.
            with conn.transaction():
                yield conn
        else:
            # No transaction open yet on this connection: this call becomes the owner of the real
            # transaction, exactly as `transaction()` behaved before reentrancy existed.
            conn.autocommit = False
            try:
                with conn.transaction():
                    yield conn
            finally:
                conn.autocommit = True


def _log_if_slow(sql: str, params: object, duration_ms: float) -> None:
    if duration_ms > _SLOW_QUERY_MS:
        log.warning("slow query", sql=sql, duration_ms=round(duration_ms, 1), params=repr(params))


def query(sql: str, params: Any = None, conn: Connection | None = None) -> list[dict[str, Any]]:
    """Runs `sql` and returns all rows as a list of dicts. Uses the pool unless `conn` is
    supplied (so callers inside a `transaction()` block can pass their connection through)."""
    start = time.monotonic()
    if conn is not None:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, params)
            rows = cur.fetchall() if cur.description else []
    else:
        with get_pool().connection() as pooled:
            with pooled.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, params)
                rows = cur.fetchall() if cur.description else []
    _log_if_slow(sql, params, (time.monotonic() - start) * 1000)
    return rows


def query_one(
    sql: str, params: Any = None, conn: Connection | None = None
) -> dict[str, Any] | None:
    """Like `query`, but returns the first row (or None)."""
    rows = query(sql, params, conn=conn)
    return rows[0] if rows else None
