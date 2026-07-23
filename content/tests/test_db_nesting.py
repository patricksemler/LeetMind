"""Regression tests for the reentrant-connection fix in `algolift_content.db`.

The bug (fixed in `db.py`'s `connection()`/`transaction()`, see the module docstring above
`_ambient_or_checkout`): both context managers called `pool.connection()`, which checks out a
FRESH connection from the pool on every call. A `connection()`/`transaction()` acquired *inside*
an already-open `transaction()` block therefore got a *different* physical connection — one that
cannot see the outer transaction's uncommitted writes (Postgres MVCC visibility is per-session).
This surfaced as an intermittent `RuntimeError: problem_versions row not found` in
`verification/runner.py::_persist`, previously band-aided with a retry loop that has since been
removed — this file is the real regression coverage that replaces it.

Every test here talks to the REAL `TEST_DATABASE_URL` Postgres (docs/CONTRACTS.md §13) using the
real `problems` table (id, internal_name — the smallest real table in the schema) for the pure
connection/transaction-semantics tests, and the full migrated verification-gate schema (via
`make_problem_version` / `fast_settings`, same as `test_verification_gate.py`) for the
`verify_problem_version` integration test. None of this can be meaningfully mocked — the bug is
specifically about which *physical* connection a nested acquisition gets from a real pool.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from conftest import fresh_problem_version_content, postgres_reachable
from psycopg.pq import TransactionStatus
from ulid import ULID

from algolift_content.config import get_settings
from algolift_content.db import connection, get_pool, query_one, transaction

pytestmark = pytest.mark.skipif(
    not postgres_reachable(), reason="Postgres not reachable on TEST_DATABASE_URL"
)


def _insert_problem(conn: Any, problem_id: str, name: str) -> None:
    conn.execute("insert into problems (id, internal_name) values (%s, %s)", (problem_id, name))


def _problem_row(problem_id: str, conn: Any = None) -> dict[str, Any] | None:
    return query_one(
        "select id, internal_name from problems where id = %s", (problem_id,), conn=conn
    )


@pytest.fixture()
def track_problem_ids() -> Iterator[Callable[[], str]]:
    """Factory fixture: each call returns a fresh `problems.id`, and every id ever handed out is
    deleted in the finalizer — regardless of whether the test's own transaction(s) committed or
    rolled back (a plain pool connection, not `transaction()`/`connection()`, so cleanup never
    depends on the very machinery under test)."""
    ids: list[str] = []

    def factory() -> str:
        pid = str(ULID())
        ids.append(pid)
        return pid

    yield factory

    if ids:
        with get_pool().connection() as conn:
            conn.execute("delete from problems where id = any(%s)", (ids,))


# ---------------------------------------------------------------------------
# 1. Nested connection() inside an open transaction() sees the outer's uncommitted row, and is
#    the same connection object.
# ---------------------------------------------------------------------------


def test_nested_connection_sees_outer_transactions_uncommitted_row(
    track_problem_ids: Callable[[], str],
) -> None:
    pid = track_problem_ids()

    with transaction() as outer_conn:
        _insert_problem(outer_conn, pid, "outer-txn-row")

        with connection() as inner_conn:
            assert inner_conn is outer_conn, (
                "nested connection() must reuse the ambient connection, not check out a second "
                "one from the pool"
            )
            row = _problem_row(pid, conn=inner_conn)
            assert row is not None, (
                "nested connection() could not see the outer transaction's own uncommitted "
                "insert — this is the exact bug being regression-tested"
            )
            assert row["internal_name"] == "outer-txn-row"


# ---------------------------------------------------------------------------
# 2. Nested transaction() joins the outer — it does not commit early. Proven by rolling the OUTER
#    back after the inner block exits cleanly, and asserting the row is gone.
# ---------------------------------------------------------------------------


def test_nested_transaction_joins_outer_and_does_not_commit_early(
    track_problem_ids: Callable[[], str],
) -> None:
    pid = track_problem_ids()

    class _ForceOuterRollback(Exception):
        pass

    with pytest.raises(_ForceOuterRollback):
        with transaction() as outer_conn:
            _insert_problem(outer_conn, pid, "should-not-survive")

            with transaction() as inner_conn:
                assert inner_conn is outer_conn
                # Visible inside the (still-open, still-uncommitted) nested block.
                assert _problem_row(pid, conn=inner_conn) is not None
            # Inner block exited cleanly (no exception) here. If the inner `transaction()` had
            # committed the real transaction early (the bug this test guards against), the outer
            # rollback below would be powerless to undo the insert.

            raise _ForceOuterRollback("force the OUTER transaction to roll back")

    # A fresh connection/transaction must see nothing: the whole thing rolled back.
    assert _problem_row(pid) is None


# ---------------------------------------------------------------------------
# 3. An inner block that raises inside a savepoint rolls back only its own writes; the outer's
#    earlier writes still commit.
# ---------------------------------------------------------------------------


def test_inner_savepoint_failure_rolls_back_only_its_own_writes(
    track_problem_ids: Callable[[], str],
) -> None:
    outer_id = track_problem_ids()
    inner_id = track_problem_ids()

    class _InnerFailure(Exception):
        pass

    with transaction() as outer_conn:
        _insert_problem(outer_conn, outer_id, "outer-survives")

        with pytest.raises(_InnerFailure):
            with transaction() as inner_conn:
                assert inner_conn is outer_conn
                _insert_problem(inner_conn, inner_id, "inner-rolled-back")
                raise _InnerFailure("boom")

        # The outer catches the inner's exception (via pytest.raises) and keeps going — its own
        # earlier write must still be visible/intact on the shared connection.
        row = _problem_row(outer_id, conn=outer_conn)
        assert row is not None
        assert row["internal_name"] == "outer-survives"

    # After the outer commits cleanly: outer's row persisted, inner's row never did.
    assert _problem_row(outer_id) is not None
    assert _problem_row(inner_id) is None


# ---------------------------------------------------------------------------
# 4. Two threads each get their own ambient connection and cannot see each other's uncommitted
#    writes — contextvars must be per-thread, not shared process-wide state.
# ---------------------------------------------------------------------------


def test_threads_get_independent_ambient_connections(
    track_problem_ids: Callable[[], str],
) -> None:
    id_a = track_problem_ids()
    id_b = track_problem_ids()

    barrier = threading.Barrier(2)
    results: dict[str, dict[str, Any] | None] = {}
    connections: dict[str, int] = {}
    errors: list[BaseException] = []

    def worker(name: str, own_id: str, other_id: str, own_label: str) -> None:
        try:
            with transaction() as conn:
                _insert_problem(conn, own_id, own_label)
                connections[name] = id(conn)
                # Get both threads mid-transaction (own write made, not yet committed) before
                # either one checks the other's row.
                barrier.wait(timeout=5)
                results[name] = _problem_row(other_id, conn=conn)
        except BaseException as exc:  # pragma: no cover - surfaced via `errors` below
            errors.append(exc)

    t1 = threading.Thread(target=worker, args=("t1", id_a, id_b, "thread-a-row"))
    t2 = threading.Thread(target=worker, args=("t2", id_b, id_a, "thread-b-row"))
    t1.start()
    t2.start()
    t1.join(timeout=15)
    t2.join(timeout=15)

    assert not errors, f"worker thread(s) raised: {errors!r}"
    assert connections["t1"] != connections["t2"], (
        "both threads' ambient connections resolved to the same physical connection object — "
        "the ContextVar is leaking across threads"
    )
    # Neither thread's ambient connection could see the OTHER thread's uncommitted row.
    assert results["t1"] is None
    assert results["t2"] is None

    # Both transactions committed cleanly -> both rows are visible now, from a fresh connection.
    assert _problem_row(id_a) is not None
    assert _problem_row(id_b) is not None


# ---------------------------------------------------------------------------
# 5. The outermost transaction() still restores autocommit=True and returns a clean connection to
#    the pool.
# ---------------------------------------------------------------------------


def test_outermost_transaction_restores_autocommit_and_returns_clean_connections(
    track_problem_ids: Callable[[], str],
) -> None:
    pid = track_problem_ids()

    with transaction() as conn:
        _insert_problem(conn, pid, "clean-exit")
        assert conn.autocommit is False

    assert conn.autocommit is True
    assert conn.info.transaction_status == TransactionStatus.IDLE

    settings = get_settings()
    pool = get_pool()
    for _ in range(settings.PGPOOL_MAX + 2):
        with pool.connection() as c:
            assert c.info.transaction_status == TransactionStatus.IDLE, (
                "a connection came back from the pool mid-transaction — transaction() failed to "
                "clean up after itself"
            )
            assert c.autocommit is True


# ---------------------------------------------------------------------------
# Bonus: verify_problem_version persists correctly when invoked with an already-open ambient
# transaction (i.e. a caller wraps the whole verification call in its own `transaction()` block).
# Requires Docker (the real sandbox) in addition to Postgres, same as test_verification_gate.py.
# ---------------------------------------------------------------------------


def test_verify_problem_version_persists_inside_an_already_open_ambient_transaction(
    sample_problem_dict: dict[str, Any], make_problem_version: Any, fast_settings: Any
) -> None:
    from algolift_content.sandbox import sandbox_probe
    from algolift_content.verification import verify_problem_version

    sandbox_ok, sandbox_reason = sandbox_probe()
    if not sandbox_ok:
        pytest.skip(f"sandbox unavailable: {sandbox_reason}")

    content = fresh_problem_version_content(sample_problem_dict)
    version_id = make_problem_version(content)

    # The whole verification run (including `_persist`'s own nested `transaction()` calls) happens
    # inside this caller-owned ambient transaction. Before the fix, `_persist`'s `for update`
    # lookup would run on a DIFFERENT connection than the one that (in a real caller) might have
    # just inserted/updated the row, and could intermittently miss it.
    with transaction() as outer_conn:
        report = verify_problem_version(
            version_id,
            content=content,
            correlation_id="test-ambient-txn",
            settings=fast_settings,
        )
        assert report.passed is True

        # Still inside the ambient transaction: the write is visible on the SAME connection.
        row = query_one(
            "select state from problem_versions where id = %s", (version_id,), conn=outer_conn
        )
        assert row is not None
        assert row["state"] == "approved"

    # And after the outer commits, it's durably visible from a fresh connection too.
    row = query_one("select state from problem_versions where id = %s", (version_id,))
    assert row is not None
    assert row["state"] == "approved"
