"""Tests for leetmind_content.queue — a faithful Python mirror of @leetmind/queue
(CONTRACTS.md §5). Mirrors the same behaviours the TS queue's own test suite would check:
priority order, skip-locked concurrency, transactional enqueue, idempotency, lease expiry +
reap, and poison -> dead. Auto-skips the whole module when Postgres isn't reachable.

Creates its own `jobs` / `worker_heartbeats` tables from a local fixture SQL string (mirroring
the DDL in packages/db/migrations/001_init.sql) rather than depending on packages/db, per this
module's task brief.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from conftest import postgres_reachable
from psycopg_pool import ConnectionPool

from leetmind_content.config import get_settings
from leetmind_content.db import assert_test_database, configure_connection
from leetmind_content.queue import Executor, Job, Queue, backoff_ms

pytestmark = pytest.mark.skipif(
    not postgres_reachable(), reason="Postgres not reachable on TEST_DATABASE_URL"
)

_SCHEMA_SQL = """
drop table if exists jobs cascade;
drop table if exists worker_heartbeats cascade;

create table jobs (
  id               text primary key,
  kind             text not null check (kind in ('judge','verify','generate')),
  priority         int not null default 100,
  payload          jsonb not null,
  status           text not null default 'queued'
                     check (status in ('queued','leased','done','failed','dead','cancelled')),
  attempts         int not null default 0,
  max_attempts     int not null default 3,
  run_at           timestamptz not null default now(),
  lease_expires_at timestamptz,
  leased_by        text,
  last_error       text,
  idempotency_key  text unique,
  correlation_id   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index jobs_claim_idx on jobs (status, kind, priority, run_at);
create index jobs_lease_idx on jobs (status, lease_expires_at);

create table worker_heartbeats (
  worker_id    text primary key,
  kind         text not null,
  last_seen_at timestamptz not null default now(),
  meta         jsonb not null default '{}'
);
"""


@pytest.fixture(scope="module")
def pool() -> Iterator[ConnectionPool]:
    settings = get_settings()
    # docs/CONTRACTS.md §13: this fixture runs `drop table ... cascade` — the most destructive
    # statement in this suite — so assert (again, defense in depth) right before it executes.
    # conftest.py already redirected+guarded DATABASE_URL at import time, but this is the actual
    # DDL, so it re-checks its own target immediately beforehand.
    assert_test_database(settings.DATABASE_URL)
    # This suite builds its own ConnectionPool (rather than leetmind_content.db.get_pool()) per
    # its own module docstring, so it must also opt into docs/CONTRACTS.md §13's schema-per-worker
    # isolation itself — reusing db.py's `configure_connection` (the same `configure=` callback
    # get_pool() uses) rather than duplicating the SET search_path logic. Without this, two
    # concurrent pytest-xdist workers' `drop table jobs cascade` (this fixture, below) would race
    # the same `public.jobs` relation — exactly the deadlock this section exists to eliminate.
    p = ConnectionPool(
        settings.DATABASE_URL,
        min_size=1,
        max_size=10,
        kwargs={"autocommit": True},
        configure=configure_connection,
        open=True,
    )
    with p.connection() as conn:
        conn.execute(_SCHEMA_SQL)
    yield p
    p.close()


@pytest.fixture(autouse=True)
def _clean_tables(pool: ConnectionPool) -> Iterator[None]:
    assert_test_database(get_settings().DATABASE_URL)
    with pool.connection() as conn:
        conn.execute("truncate table jobs, worker_heartbeats;")
    yield


def _fetchone(pool: ConnectionPool, sql: str, params: tuple = ()) -> tuple | None:
    with pool.connection() as conn:
        return conn.execute(sql, params).fetchone()


def _enqueue(queue: Queue, executor: Executor, kind: str, payload: dict[str, Any], **kwargs: Any) -> Job | None:
    """Thin wrapper around `Queue.enqueue` that defaults `run_at` to slightly in the past.

    `enqueue`'s default `run_at` (like `queue.ts`'s `job.runAt ?? new Date()`) is read from the
    *client's* clock, while `claim`'s `run_at <= now()` check runs against the *server's* clock.
    With a couple of milliseconds of client/server clock skew (routine with a Dockerized
    Postgres), a job enqueued-then-immediately-claimed can occasionally not be due yet by a
    fraction of a millisecond. That's correct, desired behaviour in production (workers poll
    every `QUEUE_POLL_INTERVAL_MS`, default 500ms) — it's only tight back-to-back
    enqueue-then-claim test code that can observe it. Tests that don't care about `run_at`
    semantics specifically should go through this helper instead of `queue.enqueue` directly;
    an explicit `run_at=...` kwarg (e.g. the "scheduled in the future" test below) still wins.
    """
    kwargs.setdefault("run_at", datetime.now(UTC) - timedelta(milliseconds=50))
    return queue.enqueue(executor, kind, payload, **kwargs)


# ---------------------------------------------------------------------------
# Claim ordering
# ---------------------------------------------------------------------------


def test_claim_orders_by_priority_then_created_at(pool: ConnectionPool) -> None:
    queue = Queue(pool, lease_seconds=30)
    low_priority = _enqueue(queue, pool, "verify", {"n": 1}, priority=50)
    time.sleep(0.01)
    high_priority_first = _enqueue(queue, pool, "verify", {"n": 2}, priority=10)
    time.sleep(0.01)
    high_priority_second = _enqueue(queue, pool, "verify", {"n": 3}, priority=10)
    assert low_priority and high_priority_first and high_priority_second

    first = queue.claim(["verify"], "w1")
    second = queue.claim(["verify"], "w1")
    third = queue.claim(["verify"], "w1")

    assert first is not None and first.id == high_priority_first.id
    assert second is not None and second.id == high_priority_second.id
    assert third is not None and third.id == low_priority.id


def test_claim_respects_run_at_and_kind_filter(pool: ConnectionPool) -> None:
    queue = Queue(pool, lease_seconds=30)
    future = _enqueue(queue, pool, "verify", {"n": "future"}, run_at=datetime.now(UTC) + timedelta(hours=1))
    ready = _enqueue(queue, pool, "verify", {"n": "ready"})
    other_kind = _enqueue(queue, pool, "generate", {"n": "other"})
    assert future and ready and other_kind

    claimed = queue.claim(["verify"], "w1")
    assert claimed is not None and claimed.id == ready.id

    # nothing else claimable under kind=verify (future job not due, no more verify jobs)
    assert queue.claim(["verify"], "w1") is None

    claimed_other = queue.claim(["generate"], "w1")
    assert claimed_other is not None and claimed_other.id == other_kind.id


# ---------------------------------------------------------------------------
# Concurrency: `for update skip locked` must be race-free
# ---------------------------------------------------------------------------


def test_claim_is_race_free_under_concurrency(pool: ConnectionPool) -> None:
    queue = Queue(pool, lease_seconds=30)
    job_ids = set()
    for i in range(10):
        job = _enqueue(queue, pool, "verify", {"n": i})
        assert job is not None
        job_ids.add(job.id)

    claimed: list[str] = []
    lock = threading.Lock()
    errors: list[BaseException] = []

    def worker(idx: int) -> None:
        try:
            job = queue.claim(["verify"], f"worker-{idx}")
            if job is not None:
                with lock:
                    claimed.append(job.id)
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    assert len(claimed) == 10, "exactly 10 jobs should be claimed across 20 racing threads"
    assert len(set(claimed)) == 10, "no job should be claimed twice"
    assert set(claimed) == job_ids


# ---------------------------------------------------------------------------
# Transactional enqueue
# ---------------------------------------------------------------------------


def test_enqueue_joins_callers_transaction_and_rolls_back(pool: ConnectionPool) -> None:
    queue = Queue(pool, lease_seconds=30)
    with pool.connection() as conn:
        conn.autocommit = False
        try:
            job = _enqueue(queue, conn, "verify", {"x": 1}, idempotency_key="rollback-test")
            assert job is not None
            conn.rollback()
        finally:
            conn.autocommit = True

    row = _fetchone(pool, "select id from jobs where idempotency_key = %s", ("rollback-test",))
    assert row is None, "job insert should have rolled back with the caller's transaction"


def test_enqueue_joins_callers_transaction_and_commits(pool: ConnectionPool) -> None:
    queue = Queue(pool, lease_seconds=30)
    with pool.connection() as conn:
        conn.autocommit = False
        try:
            job = _enqueue(queue, conn, "verify", {"x": 1}, idempotency_key="commit-test")
            assert job is not None
            conn.commit()
        finally:
            conn.autocommit = True

    row = _fetchone(pool, "select id from jobs where idempotency_key = %s", ("commit-test",))
    assert row is not None


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------


def test_enqueue_idempotency_key_collision_returns_none(pool: ConnectionPool) -> None:
    queue = Queue(pool, lease_seconds=30)
    first = _enqueue(queue, pool, "verify", {"x": 1}, idempotency_key="dup-key")
    second = _enqueue(queue, pool, "verify", {"x": 2}, idempotency_key="dup-key")
    assert first is not None
    assert second is None

    row = _fetchone(pool, "select count(*) from jobs where idempotency_key = %s", ("dup-key",))
    assert row is not None and row[0] == 1


# ---------------------------------------------------------------------------
# Lease expiry + reap
# ---------------------------------------------------------------------------


def test_reap_expired_requeues_under_max_attempts_and_deadens_at_max(pool: ConnectionPool) -> None:
    queue = Queue(pool, lease_seconds=1)  # short lease so it expires quickly

    requeue_job = _enqueue(queue, pool, "verify", {"case": "requeue"}, max_attempts=3)
    dead_job = _enqueue(queue, pool, "verify", {"case": "dead"}, max_attempts=1)
    assert requeue_job and dead_job

    claimed_ids = {queue.claim(["verify"], "w1").id, queue.claim(["verify"], "w1").id}  # type: ignore[union-attr]
    assert claimed_ids == {requeue_job.id, dead_job.id}

    time.sleep(1.5)  # let both leases expire

    reaped = queue.reap_expired()
    assert reaped == 2

    row1 = _fetchone(pool, "select status, attempts, leased_by from jobs where id=%s", (requeue_job.id,))
    row2 = _fetchone(pool, "select status, attempts, leased_by from jobs where id=%s", (dead_job.id,))
    assert row1 == ("queued", 1, None)
    assert row2 is not None and row2[0] == "dead" and row2[2] is None


def test_heartbeat_returns_false_once_lease_reaped(pool: ConnectionPool) -> None:
    queue = Queue(pool, lease_seconds=1)
    job = _enqueue(queue, pool, "verify", {"x": 1})
    assert job is not None
    claimed = queue.claim(["verify"], "w1")
    assert claimed is not None

    assert queue.heartbeat(claimed.id, "w1") is True

    time.sleep(1.5)
    queue.reap_expired()

    assert queue.heartbeat(claimed.id, "w1") is False


def test_reap_is_safe_under_concurrent_reapers(pool: ConnectionPool) -> None:
    """Multiple reapers running at once (worker's own + a dedicated reaper thread, per
    CONTRACTS.md §5) must never double-process the same expired lease."""
    queue = Queue(pool, lease_seconds=1)
    for i in range(6):
        job = _enqueue(queue, pool, "verify", {"n": i})
        assert job is not None
        claimed = queue.claim(["verify"], "w1")
        assert claimed is not None

    time.sleep(1.5)

    counts: list[int] = []
    lock = threading.Lock()

    def reap() -> None:
        n = queue.reap_expired()
        with lock:
            counts.append(n)

    threads = [threading.Thread(target=reap) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert sum(counts) == 6


# ---------------------------------------------------------------------------
# ack / fail — including poison -> dead
# ---------------------------------------------------------------------------


def test_ack_marks_done(pool: ConnectionPool) -> None:
    queue = Queue(pool, lease_seconds=30)
    job = _enqueue(queue, pool, "verify", {"x": 1})
    assert job is not None
    claimed = queue.claim(["verify"], "w1")
    assert claimed is not None

    queue.ack(claimed.id, "w1")

    row = _fetchone(pool, "select status from jobs where id=%s", (job.id,))
    assert row == ("done",)


def test_fail_retries_then_deadens_poison_job(pool: ConnectionPool) -> None:
    queue = Queue(pool, lease_seconds=30)
    job = _enqueue(queue, pool, "verify", {"x": 1}, max_attempts=2)
    assert job is not None

    claimed = queue.claim(["verify"], "w1")
    assert claimed is not None and claimed.attempts == 1

    result = queue.fail(claimed.id, "w1", "boom", retry_in_ms=0)
    assert result == "retry"

    row = _fetchone(pool, "select status, attempts, leased_by from jobs where id=%s", (job.id,))
    assert row == ("queued", 1, None)

    claimed2 = queue.claim(["verify"], "w2")
    assert claimed2 is not None and claimed2.id == job.id and claimed2.attempts == 2

    result2 = queue.fail(claimed2.id, "w2", "boom again")
    assert result2 == "dead"

    row2 = _fetchone(pool, "select status, last_error from jobs where id=%s", (job.id,))
    assert row2 is not None and row2[0] == "dead" and row2[1] == "boom again"


def test_fail_uses_backoff_when_no_retry_in_ms_given(pool: ConnectionPool) -> None:
    queue = Queue(pool, lease_seconds=30)
    job = _enqueue(queue, pool, "verify", {"x": 1}, max_attempts=5)
    assert job is not None
    claimed = queue.claim(["verify"], "w1")
    assert claimed is not None

    before = datetime.now(UTC)
    result = queue.fail(claimed.id, "w1", "transient error")
    assert result == "retry"

    row = _fetchone(pool, "select run_at from jobs where id=%s", (job.id,))
    assert row is not None
    run_at = row[0]
    delay_s = (run_at - before).total_seconds()
    # backoff_ms(1) is ~2s (1000 * 2**1) +-20% jitter; generous bounds to avoid flakiness.
    assert 0.5 < delay_s < 5


# ---------------------------------------------------------------------------
# worker_heartbeats
# ---------------------------------------------------------------------------


def test_upsert_worker_heartbeat(pool: ConnectionPool) -> None:
    queue = Queue(pool, lease_seconds=30)
    queue.upsert_worker_heartbeat("w1", "verify,generate", {"concurrency": 1})
    queue.upsert_worker_heartbeat("w1", "verify,generate", {"concurrency": 2})  # upsert, not duplicate

    row = _fetchone(pool, "select kind from jobs limit 0")  # no-op sanity that pool still usable
    assert row is None

    hb = _fetchone(pool, "select worker_id, kind from worker_heartbeats where worker_id=%s", ("w1",))
    assert hb == ("w1", "verify,generate")


# ---------------------------------------------------------------------------
# backoff_ms formula
# ---------------------------------------------------------------------------


def test_backoff_ms_grows_with_attempts_and_caps() -> None:
    small = backoff_ms(0)
    assert 0 <= small <= 1200  # base 1000ms, +-20% jitter

    large = backoff_ms(20)  # far beyond the cap
    assert large <= 36_000  # capped at 30_000ms, +-20% jitter
