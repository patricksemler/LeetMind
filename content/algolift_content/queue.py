"""Python mirror of `@algolift/queue` (docs/CONTRACTS.md §5).

Same `jobs` table, the same claim SQL (`for update skip locked`, `order by priority asc,
created_at asc`, `run_at <= now()`, attempts increment), the same lease/heartbeat/ack/fail/reap
semantics, and the same exponential-backoff-with-jitter formula as
`packages/queue/src/queue.ts` / `worker.ts` / `reaper.ts`. This is a faithful port, not a
reinterpretation — when in doubt, match the TS source (read alongside this file) exactly.

`run_worker` uses **threads**, not asyncio: the work driven by this queue (verify/generate job
handlers) is subprocess-bound — it shells out to the sandbox CLI bridge and to `claude -p`
(CONTRACTS.md §6.1, §7) — so threads, which let those blocking subprocess calls run truly
concurrently, are the correct primitive here.
"""

from __future__ import annotations

import random
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, NamedTuple

from psycopg import Connection
from psycopg.rows import dict_row
from psycopg.types.json import Json
from psycopg_pool import ConnectionPool
from ulid import ULID

from algolift_content.logging import get_logger, with_context
from algolift_content.models import JOB_PRIORITY

log = get_logger("queue")

DEFAULT_LEASE_SECONDS = 30
DEFAULT_MAX_ATTEMPTS = 3
MAX_BACKOFF_MS = 30_000

DEFAULT_POLL_INTERVAL_MS = 500
DEFAULT_HEARTBEAT_MS = 10_000
SHUTDOWN_GRACE_SECONDS = 30.0
DEFAULT_REAPER_INTERVAL_MS = 5_000

FailResult = Literal["retry", "dead"]

#: A caller-supplied executor: either the pool itself (enqueue commits immediately) or an
#: already-open connection (enqueue joins whatever transaction that connection is in — the
#: "transactional enqueue" invariant from CONTRACTS.md §5).
Executor = Connection | ConnectionPool


def backoff_ms(attempts: int) -> int:
    """Exponential backoff: `min(30s, 1s * 2^attempts)`, with ±20% jitter. Mirrors `backoffMs`
    in `packages/queue/src/queue.ts` exactly. `attempts` is the post-claim-increment attempt
    count (i.e. the attempt that just failed)."""
    base = min(MAX_BACKOFF_MS, 1000 * 2 ** max(0, attempts))
    jitter = base * 0.2
    delta = (random.random() * 2 - 1) * jitter
    return max(0, round(base + delta))


@dataclass
class Job:
    """Row projection of the `jobs` table — field names match the column names exactly
    (CONTRACTS.md §3), same convention as `Job` in `packages/queue/src/types.ts`."""

    id: str
    kind: str
    priority: int
    payload: dict[str, Any]
    status: str
    attempts: int
    max_attempts: int
    run_at: datetime
    lease_expires_at: datetime | None
    leased_by: str | None
    last_error: str | None
    idempotency_key: str | None
    correlation_id: str | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> Job:
        return cls(
            id=row["id"],
            kind=row["kind"],
            priority=row["priority"],
            payload=row["payload"],
            status=row["status"],
            attempts=row["attempts"],
            max_attempts=row["max_attempts"],
            run_at=row["run_at"],
            lease_expires_at=row["lease_expires_at"],
            leased_by=row["leased_by"],
            last_error=row["last_error"],
            idempotency_key=row["idempotency_key"],
            correlation_id=row["correlation_id"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class Queue:
    """Postgres job queue. Construct one per process (or per worker) sharing a `ConnectionPool`."""

    def __init__(
        self,
        pool: ConnectionPool,
        *,
        lease_seconds: int | None = None,
        worker_id: str | None = None,
    ) -> None:
        self.pool = pool
        self.lease_seconds = lease_seconds if lease_seconds is not None else DEFAULT_LEASE_SECONDS
        self.worker_id = worker_id

    # -- internal helpers -----------------------------------------------------

    def _exec(
        self,
        sql: str,
        params: tuple[Any, ...] | None,
        *,
        fetch: Literal["one", "all", "none"] = "all",
    ) -> Any:
        with self.pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, params)
                if fetch == "one":
                    return cur.fetchone()
                if fetch == "all":
                    return cur.fetchall()
                return None

    # -- public API (CONTRACTS.md §5) ------------------------------------------

    def enqueue(
        self,
        executor: Executor,
        kind: str,
        payload: dict[str, Any],
        *,
        priority: int | None = None,
        max_attempts: int | None = None,
        run_at: datetime | None = None,
        idempotency_key: str | None = None,
        correlation_id: str | None = None,
    ) -> Job | None:
        """Inserts a job. `executor` MUST be the caller's connection (or the pool) so that, when
        called mid-transaction, the insert commits atomically with whatever domain write
        justified it. Idempotency-key collision -> `on conflict (idempotency_key) do nothing`,
        returns `None`."""
        job_id = str(ULID())
        resolved_priority = (
            priority if priority is not None else JOB_PRIORITY.get(kind, 100)  # type: ignore[arg-type]
        )
        resolved_max_attempts = max_attempts if max_attempts is not None else DEFAULT_MAX_ATTEMPTS
        resolved_run_at = run_at if run_at is not None else datetime.now(UTC)

        sql = """
            insert into jobs
              (id, kind, priority, payload, max_attempts, run_at, idempotency_key, correlation_id)
            values (%s, %s, %s, %s, %s, %s, %s, %s)
            on conflict (idempotency_key) do nothing
            returning *;
        """
        params = (
            job_id,
            kind,
            resolved_priority,
            Json(payload),
            resolved_max_attempts,
            resolved_run_at,
            idempotency_key,
            correlation_id,
        )

        if isinstance(executor, ConnectionPool):
            with executor.connection() as conn:
                row = self._insert(conn, sql, params)
        else:
            row = self._insert(executor, sql, params)
        return Job.from_row(row) if row else None

    @staticmethod
    def _insert(conn: Connection, sql: str, params: tuple[Any, ...]) -> dict[str, Any] | None:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, params)
            return cur.fetchone()

    def claim(self, kinds: Iterable[str], worker_id: str) -> Job | None:
        """Claim SQL is exactly the shape mandated by CONTRACTS.md §5."""
        sql = """
            update jobs set status='leased', attempts=attempts+1, leased_by=%s,
              lease_expires_at=now() + (%s || ' seconds')::interval, updated_at=now()
            where id = (select id from jobs where status='queued' and kind = any(%s)
                        and run_at <= now() order by priority asc, created_at asc
                        for update skip locked limit 1)
            returning *;
        """
        params = (worker_id, str(self.lease_seconds), list(kinds))
        row = self._exec(sql, params, fetch="one")
        return Job.from_row(row) if row else None

    def heartbeat(self, job_id: str, worker_id: str) -> bool:
        """Extends the lease. Returns False if the row is no longer leased by this worker (lease
        was stolen by the reaper), so the caller can abort work."""
        sql = """
            update jobs
            set lease_expires_at = now() + (%s || ' seconds')::interval, updated_at = now()
            where id = %s and status = 'leased' and leased_by = %s
            returning id;
        """
        params = (str(self.lease_seconds), job_id, worker_id)
        row = self._exec(sql, params, fetch="one")
        return row is not None

    def ack(self, job_id: str, worker_id: str) -> None:
        """No-op-safe: only transitions rows this worker still holds the lease on."""
        sql = """
            update jobs set status='done', updated_at=now()
            where id=%s and leased_by=%s and status='leased';
        """
        self._exec(sql, (job_id, worker_id), fetch="none")

    def fail(
        self, job_id: str, worker_id: str, error: str, *, retry_in_ms: int | None = None
    ) -> FailResult:
        """Records the failure. If `attempts >= max_attempts` -> `'dead'` (poison-job parking).
        Otherwise -> `'queued'` with `run_at` pushed out by `retry_in_ms` (default: exponential
        backoff with jitter, see `backoff_ms()`). `attempts` is not incremented here — `claim()`
        already incremented it."""
        with self.pool.connection() as conn:
            conn.autocommit = False
            try:
                with conn.cursor(row_factory=dict_row) as cur:
                    cur.execute(
                        """
                        select attempts, max_attempts from jobs
                        where id=%s and leased_by=%s and status='leased'
                        for update;
                        """,
                        (job_id, worker_id),
                    )
                    row = cur.fetchone()
                    if row is None:
                        conn.rollback()
                        raise RuntimeError(
                            f"Queue.fail: job {job_id} is not currently leased by worker {worker_id}"
                        )
                    attempts = row["attempts"]
                    max_attempts = row["max_attempts"]

                    if attempts >= max_attempts:
                        cur.execute(
                            """
                            update jobs set status='dead', last_error=%s, updated_at=now()
                            where id=%s and leased_by=%s;
                            """,
                            (error, job_id, worker_id),
                        )
                        conn.commit()
                        return "dead"

                    resolved_retry_ms = (
                        retry_in_ms if retry_in_ms is not None else backoff_ms(attempts)
                    )
                    cur.execute(
                        """
                        update jobs
                        set status='queued', last_error=%s, leased_by=null, lease_expires_at=null,
                          run_at = now() + (%s || ' milliseconds')::interval, updated_at=now()
                        where id=%s and leased_by=%s;
                        """,
                        (error, str(resolved_retry_ms), job_id, worker_id),
                    )
                    conn.commit()
                    return "retry"
            except BaseException:
                conn.rollback()
                raise
            finally:
                conn.autocommit = True

    def cancel(self, job_id: str) -> Job | None:
        sql = """
            update jobs set status='cancelled', updated_at=now()
            where id=%s and status in ('queued','leased')
            returning *;
        """
        row = self._exec(sql, (job_id,), fetch="one")
        return Job.from_row(row) if row else None

    def get_job(self, job_id: str) -> Job | None:
        row = self._exec("select * from jobs where id=%s;", (job_id,), fetch="one")
        return Job.from_row(row) if row else None

    def reap_expired(self) -> int:
        """Requeues (or deadens) rows with `status='leased'` and an expired lease. Uses `for
        update skip locked` across a CTE so it is safe to run concurrently from every process
        (worker + dedicated reaper alike). Returns the number of jobs reaped."""
        sql = """
            with expired as (
              select id, kind, attempts, max_attempts, leased_by
              from jobs
              where status = 'leased' and lease_expires_at < now()
              for update skip locked
            ),
            requeued as (
              update jobs set status='queued', leased_by=null, lease_expires_at=null,
                last_error=coalesce(jobs.last_error, 'lease expired'), updated_at=now()
              from expired
              where jobs.id = expired.id and expired.attempts < expired.max_attempts
              returning jobs.id, expired.kind, expired.leased_by, 'requeued'::text as outcome
            ),
            deadened as (
              update jobs set status='dead', leased_by=null, lease_expires_at=null,
                last_error=coalesce(jobs.last_error, 'lease expired'), updated_at=now()
              from expired
              where jobs.id = expired.id and expired.attempts >= expired.max_attempts
              returning jobs.id, expired.kind, expired.leased_by, 'dead'::text as outcome
            )
            select * from requeued
            union all
            select * from deadened;
        """
        rows = self._exec(sql, None, fetch="all")
        for row in rows:
            log.warning(
                "reaped expired lease",
                job_id=row["id"],
                kind=row["kind"],
                leased_by=row["leased_by"],
                outcome=row["outcome"],
            )
        return len(rows)

    def stats(self) -> dict[str, Any]:
        """Aggregate stats for `/api/system/stats`. See `packages/queue/src/queue.ts#stats` for
        the wait-time approximation this mirrors (`claimed_at ~= lease_expires_at -
        leaseSeconds`)."""
        with self.pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute("select kind, status, count(*)::text as count from jobs group by kind, status;")
                counts_rows = cur.fetchall()

                cur.execute(
                    """
                    select kind, extract(epoch from (now() - min(created_at))) * 1000 as oldest_ms
                    from jobs where status='queued' group by kind;
                    """
                )
                oldest_rows = cur.fetchall()

                cur.execute(
                    """
                    select
                      percentile_cont(0.5) within group (order by wait_ms) as p50,
                      percentile_cont(0.95) within group (order by wait_ms) as p95
                    from (
                      select extract(epoch from (
                        (lease_expires_at - (%s || ' seconds')::interval) - created_at
                      )) * 1000 as wait_ms
                      from jobs
                      where lease_expires_at is not null
                        and (lease_expires_at - (%s || ' seconds')::interval) >= now() - interval '1 hour'
                    ) t;
                    """,
                    (str(self.lease_seconds), str(self.lease_seconds)),
                )
                wait_row = cur.fetchone()

                cur.execute("select count(*)::text as count from jobs where status='dead';")
                dead_count_row = cur.fetchone()

                cur.execute("select * from jobs where status='dead' order by updated_at desc limit 20;")
                recent_dead_rows = cur.fetchall()

        kind_map: dict[str, dict[str, Any]] = {}
        for row in counts_rows:
            entry = kind_map.setdefault(
                row["kind"], {"kind": row["kind"], "counts": {}, "oldest_queued_age_ms": None}
            )
            entry["counts"][row["status"]] = int(row["count"])
        for row in oldest_rows:
            entry = kind_map.setdefault(
                row["kind"], {"kind": row["kind"], "counts": {}, "oldest_queued_age_ms": None}
            )
            entry["oldest_queued_age_ms"] = None if row["oldest_ms"] is None else float(row["oldest_ms"])

        return {
            "kinds": list(kind_map.values()),
            "wait_time_ms": {
                "p50": None if not wait_row or wait_row.get("p50") is None else float(wait_row["p50"]),
                "p95": None if not wait_row or wait_row.get("p95") is None else float(wait_row["p95"]),
            },
            "dead_count": int(dead_count_row["count"]) if dead_count_row else 0,
            "recent_dead": [Job.from_row(r) for r in recent_dead_rows],
        }

    def upsert_worker_heartbeat(self, worker_id: str, kind: str, meta: dict[str, Any] | None = None) -> None:
        """Not part of the Queue API in CONTRACTS.md §5, but required by the "every worker
        upserts worker_heartbeats every QUEUE_HEARTBEAT_MS" rule in the same section. Mirrors
        `Queue#upsertWorkerHeartbeat` in `packages/queue/src/queue.ts`."""
        sql = """
            insert into worker_heartbeats (worker_id, kind, last_seen_at, meta)
            values (%s, %s, now(), %s)
            on conflict (worker_id) do update set kind=excluded.kind, last_seen_at=now(), meta=excluded.meta;
        """
        self._exec(sql, (worker_id, kind, Json(meta or {})), fetch="none")


# ---------------------------------------------------------------------------
# run_worker — thread-based polling loop (see module docstring for why threads)
# ---------------------------------------------------------------------------


@dataclass
class WorkerContext:
    """Passed to every job handler. `stop_event` is set when the lease is lost (stolen by the
    reaper) — long-running handlers should check it periodically and abort. `heartbeat()` lets a
    handler manually extend its lease (in addition to the automatic per-interval one); it
    returns False if the lease was already lost."""

    stop_event: threading.Event
    heartbeat: Callable[[], bool]
    logger: Any


JobHandler = Callable[[Job, WorkerContext], None]


def run_worker(
    queue: Queue,
    kinds: list[str],
    concurrency: int,
    handler: JobHandler,
    *,
    worker_id: str,
    stop_event: threading.Event | None = None,
    poll_interval_ms: int = DEFAULT_POLL_INTERVAL_MS,
    heartbeat_ms: int = DEFAULT_HEARTBEAT_MS,
) -> None:
    """Thread-based polling worker loop mirroring `runWorker` in
    `packages/queue/src/worker.ts`. Keeps up to `concurrency` jobs in flight, claiming a new one
    whenever a slot frees, sleeping `poll_interval_ms` when `claim()` returns None. Each
    in-flight job gets its own heartbeat thread (every `heartbeat_ms`) extending its lease; if
    the lease was lost, the job's `WorkerContext.stop_event` is set and the job is neither acked
    nor failed on completion. Also upserts `worker_heartbeats` every `heartbeat_ms`. Blocks
    until `stop_event` is set and all in-flight jobs settle (bounded by
    `SHUTDOWN_GRACE_SECONDS`)."""
    stop_event = stop_event if stop_event is not None else threading.Event()
    in_flight: dict[str, threading.Thread] = {}
    in_flight_lock = threading.Lock()

    def worker_heartbeat_loop() -> None:
        while not stop_event.wait(heartbeat_ms / 1000):
            try:
                with in_flight_lock:
                    n = len(in_flight)
                queue.upsert_worker_heartbeat(worker_id, ",".join(kinds), {"concurrency": concurrency, "in_flight": n})
            except Exception:
                log.exception("worker_heartbeats upsert failed", worker_id=worker_id)

    try:
        queue.upsert_worker_heartbeat(worker_id, ",".join(kinds), {"concurrency": concurrency, "in_flight": 0})
    except Exception:
        log.exception("worker_heartbeats upsert failed", worker_id=worker_id)

    wh_thread = threading.Thread(target=worker_heartbeat_loop, name="worker-heartbeat", daemon=True)
    wh_thread.start()

    def run_job(job: Job) -> None:
        job_stop = threading.Event()
        lease_lost = threading.Event()

        def hb_loop() -> None:
            while not job_stop.wait(heartbeat_ms / 1000):
                try:
                    ok = queue.heartbeat(job.id, worker_id)
                except Exception:
                    log.exception("heartbeat failed", job_id=job.id)
                    continue
                if not ok and not lease_lost.is_set():
                    lease_lost.set()
                    log.warning("lease lost, aborting job", job_id=job.id)
                    job_stop.set()

        hb_thread = threading.Thread(target=hb_loop, name=f"hb-{job.id}", daemon=True)
        hb_thread.start()

        def manual_heartbeat() -> bool:
            ok = queue.heartbeat(job.id, worker_id)
            if not ok and not lease_lost.is_set():
                lease_lost.set()
                job_stop.set()
            return ok

        job_logger = log.bind(job_id=job.id, kind=job.kind, worker_id=worker_id)
        ctx = WorkerContext(stop_event=job_stop, heartbeat=manual_heartbeat, logger=job_logger)

        try:
            with with_context(job_id=job.id, worker_id=worker_id, correlation_id=job.correlation_id or None):
                handler(job, ctx)
            if lease_lost.is_set():
                job_logger.warning("handler completed after lease loss; not acking", job_id=job.id)
            else:
                queue.ack(job.id, worker_id)
        except Exception as exc:
            if lease_lost.is_set():
                job_logger.warning("handler raised after lease loss; not failing", job_id=job.id, error=str(exc))
            else:
                try:
                    result = queue.fail(job.id, worker_id, str(exc))
                    job_logger.error("job failed", job_id=job.id, error=str(exc), result=result)
                except Exception:
                    job_logger.exception("queue.fail() itself raised", job_id=job.id)
        finally:
            job_stop.set()
            with in_flight_lock:
                in_flight.pop(job.id, None)

    while not stop_event.is_set():
        with in_flight_lock:
            have_room = len(in_flight) < concurrency
        job = queue.claim(kinds, worker_id) if have_room else None
        if job is not None:
            thread = threading.Thread(target=run_job, args=(job,), name=f"job-{job.id}", daemon=True)
            with in_flight_lock:
                in_flight[job.id] = thread
            thread.start()
            continue
        stop_event.wait(poll_interval_ms / 1000)

    # Graceful shutdown: wait for in-flight jobs, bounded.
    deadline = time.monotonic() + SHUTDOWN_GRACE_SECONDS
    with in_flight_lock:
        threads = list(in_flight.values())
    for thread in threads:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        thread.join(timeout=remaining)


class ReaperHandle(NamedTuple):
    thread: threading.Thread
    stop_event: threading.Event


def start_reaper(
    queue: Queue, *, interval_ms: int = DEFAULT_REAPER_INTERVAL_MS, stop_event: threading.Event | None = None
) -> ReaperHandle:
    """Background thread calling `queue.reap_expired()` every `interval_ms`. Safe to run in
    every process concurrently — `reap_expired()` uses `for update skip locked` so concurrent
    reapers never double-process the same expired lease. Mirrors `startReaper` in
    `packages/queue/src/reaper.ts`."""
    stop_event = stop_event if stop_event is not None else threading.Event()
    running = threading.Lock()

    def tick() -> None:
        if not running.acquire(blocking=False):
            return  # don't overlap ticks if reap_expired is slow
        try:
            count = queue.reap_expired()
            if count:
                log.info("reaper: requeued/deadened expired leases", count=count)
        except Exception:
            log.exception("reaper: reap_expired() threw")
        finally:
            running.release()

    def loop() -> None:
        while not stop_event.wait(interval_ms / 1000):
            tick()

    thread = threading.Thread(target=loop, name="reaper", daemon=True)
    thread.start()
    return ReaperHandle(thread=thread, stop_event=stop_event)
