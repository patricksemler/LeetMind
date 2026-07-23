import type { Pool, PoolClient, QueryResultRow } from 'pg';
// @algolift/shared per docs/CONTRACTS.md: createLogger(service), newId(), JobKind, JOB_PRIORITY.
import { createLogger, newId, JOB_PRIORITY, type JobKind } from '@algolift/shared';

import type {
  DeadJobInfo,
  EnqueueInput,
  FailOpts,
  FailResult,
  Job,
  LeaseRecoveryStats,
  Logger,
  QueueKindStats,
  QueueOpts,
  QueueStats,
} from './types.js';

export type Executor = Pool | PoolClient;

const DEFAULT_LEASE_SECONDS = 30;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 30_000;

/** Exponential backoff: min(30s, 1s * 2^attempts), with ±20% jitter. `attempts`
 * is the post-claim-increment attempt count (i.e. the attempt that just failed). */
export function backoffMs(attempts: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempts));
  const jitter = base * 0.2;
  const delta = (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(base + delta));
}

function mapRow(row: QueryResultRow): Job {
  return {
    id: row.id,
    kind: row.kind,
    priority: row.priority,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    run_at: row.run_at,
    lease_expires_at: row.lease_expires_at,
    leased_by: row.leased_by,
    last_error: row.last_error,
    idempotency_key: row.idempotency_key,
    correlation_id: row.correlation_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** `row` must come from a query that also selected `age_ms` (see callers). */
function mapDeadRow(row: QueryResultRow): DeadJobInfo {
  return { ...mapRow(row), age_ms: Number(row.age_ms) };
}

export class Queue {
  private readonly pool: Pool;
  private readonly leaseSeconds: number;
  private readonly workerId?: string;
  private readonly logger: Logger;

  constructor(pool: Pool, opts?: QueueOpts) {
    this.pool = pool;
    this.leaseSeconds = opts?.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.workerId = opts?.workerId;
    this.logger = opts?.logger ?? (createLogger('queue') as unknown as Logger);
  }

  /**
   * Insert a job. MUST be given the caller's client (or the pool) so that,
   * when called mid-transaction, the insert commits atomically with whatever
   * domain write justified it (the "transactional enqueue" invariant).
   * Idempotency-key collision -> `on conflict (idempotency_key) do nothing`,
   * returns null.
   */
  async enqueue<TKind extends string = string, TPayload = unknown>(
    executor: Executor,
    job: EnqueueInput<TKind, TPayload>,
  ): Promise<Job<TPayload> | null> {
    const id = newId();
    const priority =
      job.priority ?? (JOB_PRIORITY as Record<string, number>)[job.kind] ?? 100;
    const maxAttempts = job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    // Default run_at to the *server's* clock (coalesce in SQL), not the
    // caller's JS Date.now(): if the app process's clock and Postgres's
    // clock drift even slightly, a client-stamped run_at can land in the
    // server's future and make a freshly enqueued job unclaimable until
    // clocks catch up. A caller-supplied runAt (explicit delayed scheduling)
    // is passed through as-is.
    const runAt = job.runAt ?? null;
    const idempotencyKey = job.idempotencyKey ?? null;
    const correlationId = job.correlationId ?? null;

    const result = await executor.query(
      `insert into jobs (id, kind, priority, payload, max_attempts, run_at, idempotency_key, correlation_id)
       values ($1,$2,$3,$4,$5,coalesce($6, now()),$7,$8)
       on conflict (idempotency_key) do nothing
       returning *;`,
      [id, job.kind, priority, job.payload, maxAttempts, runAt, idempotencyKey, correlationId],
    );

    if (result.rowCount === 0) {
      return null;
    }
    return mapRow(result.rows[0]) as Job<TPayload>;
  }

  /** Claim SQL is exactly the shape mandated by CONTRACTS.md §5. */
  async claim(kinds: JobKind[] | string[], workerId: string): Promise<Job | null> {
    const result = await this.pool.query(
      `update jobs set status='leased', attempts=attempts+1, leased_by=$2,
         lease_expires_at=now() + ($3 || ' seconds')::interval, updated_at=now()
       where id = (select id from jobs where status='queued' and kind = any($1)
                   and run_at <= now() order by priority asc, created_at asc
                   for update skip locked limit 1)
       returning *;`,
      [kinds, workerId, this.leaseSeconds],
    );
    if (result.rowCount === 0) {
      return null;
    }
    return mapRow(result.rows[0]);
  }

  /** Extends the lease. Returns false if the row is no longer leased by this
   * worker (lease was stolen by the reaper) so the caller can abort work. */
  async heartbeat(jobId: string, workerId: string): Promise<boolean> {
    const result = await this.pool.query(
      `update jobs set lease_expires_at = now() + ($3 || ' seconds')::interval, updated_at = now()
       where id = $1 and status = 'leased' and leased_by = $2
       returning id;`,
      [jobId, workerId, this.leaseSeconds],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** No-op-safe: only transitions rows this worker still holds the lease on. */
  async ack(jobId: string, workerId: string): Promise<void> {
    await this.pool.query(
      `update jobs set status='done', updated_at=now()
       where id=$1 and leased_by=$2 and status='leased';`,
      [jobId, workerId],
    );
  }

  /**
   * Records the failure. If attempts >= max_attempts -> 'dead' (poison-job
   * parking). Otherwise -> 'queued' with run_at pushed out by opts.retryInMs
   * (default: exponential backoff with jitter, see backoffMs()).
   * `attempts` is not incremented here -- claim() already incremented it.
   */
  async fail(
    jobId: string,
    workerId: string,
    error: string,
    opts?: FailOpts,
  ): Promise<FailResult> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query<{ attempts: number; max_attempts: number }>(
        `select attempts, max_attempts from jobs
         where id=$1 and leased_by=$2 and status='leased'
         for update;`,
        [jobId, workerId],
      );
      if (rows.length === 0) {
        await client.query('rollback');
        throw new Error(
          `Queue.fail: job ${jobId} is not currently leased by worker ${workerId}`,
        );
      }
      const { attempts, max_attempts: maxAttempts } = rows[0]!;

      if (attempts >= maxAttempts) {
        await client.query(
          `update jobs set status='dead', last_error=$3, updated_at=now()
           where id=$1 and leased_by=$2;`,
          [jobId, workerId, error],
        );
        await client.query('commit');
        return 'dead';
      }

      const retryInMs = opts?.retryInMs ?? backoffMs(attempts);
      await client.query(
        `update jobs set status='queued', last_error=$3, leased_by=null, lease_expires_at=null,
           run_at = now() + ($4 || ' milliseconds')::interval, updated_at=now()
         where id=$1 and leased_by=$2;`,
        [jobId, workerId, error, retryInMs],
      );
      await client.query('commit');
      return 'retry';
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async cancel(jobId: string): Promise<Job | null> {
    const result = await this.pool.query(
      `update jobs set status='cancelled', updated_at=now()
       where id=$1 and status in ('queued','leased')
       returning *;`,
      [jobId],
    );
    if (result.rowCount === 0) {
      return null;
    }
    return mapRow(result.rows[0]);
  }

  async getJob(id: string): Promise<Job | null> {
    const result = await this.pool.query(`select * from jobs where id=$1;`, [id]);
    if (result.rowCount === 0) {
      return null;
    }
    return mapRow(result.rows[0]);
  }

  /**
   * Requeues (or deadens) rows with status='leased' and an expired lease.
   * Uses FOR UPDATE SKIP LOCKED across a CTE so it is safe to run
   * concurrently from every process (worker + dedicated reaper alike).
   * Returns the number of jobs reaped.
   */
  async reapExpired(): Promise<number> {
    const result = await this.pool.query(
      `with expired as (
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
       select * from deadened;`,
    );

    for (const row of result.rows) {
      this.logger.warn(
        { job_id: row.id, kind: row.kind, leased_by: row.leased_by, outcome: row.outcome },
        'reaped expired lease',
      );
    }

    return result.rowCount ?? 0;
  }

  /**
   * Aggregate stats for /system.
   *
   * Wait-time approximation: we do not store a distinct "claimed_at" column.
   * At claim time `lease_expires_at = claimed_at + leaseSeconds`, so we
   * approximate `claimed_at ~= lease_expires_at - leaseSeconds` (using this
   * Queue instance's configured leaseSeconds). This drifts for jobs whose
   * lease was subsequently extended by heartbeats, or claimed by a worker
   * using a different leaseSeconds value -- acceptable for an operational
   * dashboard percentile, not used for anything correctness-critical.
   */
  async stats(): Promise<QueueStats> {
    const [countsRes, oldestRes, waitRes, deadCountRes, recentDeadRes, leaseRecoveryRes] = await Promise.all([
      this.pool.query<{ kind: string; status: string; count: string }>(
        `select kind, status, count(*)::text as count from jobs group by kind, status;`,
      ),
      this.pool.query<{ kind: string; oldest_ms: string | null }>(
        `select kind, extract(epoch from (now() - min(created_at))) * 1000 as oldest_ms
         from jobs where status='queued' group by kind;`,
      ),
      this.pool.query<{ p50: string | null; p95: string | null }>(
        `select
           percentile_cont(0.5) within group (order by wait_ms) as p50,
           percentile_cont(0.95) within group (order by wait_ms) as p95
         from (
           select extract(epoch from (
             (lease_expires_at - ($1 || ' seconds')::interval) - created_at
           )) * 1000 as wait_ms
           from jobs
           where lease_expires_at is not null
             and (lease_expires_at - ($1 || ' seconds')::interval) >= now() - interval '1 hour'
         ) t;`,
        [this.leaseSeconds],
      ),
      this.pool.query<{ count: string }>(`select count(*)::text as count from jobs where status='dead';`),
      this.pool.query(
        `select *, extract(epoch from (now() - updated_at)) * 1000 as age_ms
         from jobs where status='dead' order by updated_at desc limit 20;`,
      ),
      // See LeaseRecoveryStats's doc comment (types.ts) for the precision caveat on this marker.
      this.pool.query<{ status: string; count: string }>(
        `select status, count(*)::text as count from jobs where last_error = 'lease expired' group by status;`,
      ),
    ]);

    const kindMap = new Map<string, QueueKindStats>();
    for (const row of countsRes.rows) {
      let entry = kindMap.get(row.kind);
      if (!entry) {
        entry = { kind: row.kind, counts: {}, oldest_queued_age_ms: null };
        kindMap.set(row.kind, entry);
      }
      entry.counts[row.status] = Number(row.count);
    }
    for (const row of oldestRes.rows) {
      let entry = kindMap.get(row.kind);
      if (!entry) {
        entry = { kind: row.kind, counts: {}, oldest_queued_age_ms: null };
        kindMap.set(row.kind, entry);
      }
      entry.oldest_queued_age_ms = row.oldest_ms === null ? null : Number(row.oldest_ms);
    }

    const waitRow = waitRes.rows[0];

    const leaseRecovery: LeaseRecoveryStats = {
      reaped_total: 0,
      recovered: 0,
      still_pending: 0,
      dead_after_reap: 0,
    };
    for (const row of leaseRecoveryRes.rows) {
      const count = Number(row.count);
      leaseRecovery.reaped_total += count;
      if (row.status === 'done') leaseRecovery.recovered += count;
      else if (row.status === 'dead') leaseRecovery.dead_after_reap += count;
      else if (row.status === 'queued' || row.status === 'leased') leaseRecovery.still_pending += count;
    }

    return {
      kinds: Array.from(kindMap.values()),
      wait_time_ms: {
        p50: waitRow?.p50 == null ? null : Number(waitRow.p50),
        p95: waitRow?.p95 == null ? null : Number(waitRow.p95),
      },
      dead_count: Number(deadCountRes.rows[0]?.count ?? 0),
      recent_dead: recentDeadRes.rows.map(mapDeadRow),
      lease_recovery: leaseRecovery,
    };
  }

  /**
   * Fuller listing than `stats().recent_dead` (which is capped at 20 for the /system dashboard) --
   * the poison-job "admin console" surface for `scripts/requeue-dead-job.ts` (PLAN.md §11: no
   * admin UI, the terminal is it). Optionally filtered by `kind`.
   */
  async listDeadJobs(opts?: { limit?: number; kind?: string }): Promise<DeadJobInfo[]> {
    const limit = opts?.limit ?? 50;
    const params: unknown[] = [limit];
    let kindFilter = '';
    if (opts?.kind) {
      kindFilter = 'and kind = $2';
      params.push(opts.kind);
    }
    const result = await this.pool.query(
      `select *, extract(epoch from (now() - updated_at)) * 1000 as age_ms
       from jobs where status='dead' ${kindFilter} order by updated_at desc limit $1;`,
      params,
    );
    return result.rows.map(mapDeadRow);
  }

  /**
   * Operator escape hatch for a poison job (PLAN.md §11 "the terminal is the admin console"):
   * resets `attempts` to 0 and clears the lease/error state so a `dead` job becomes claimable
   * again. Only ever transitions rows currently `status='dead'` -- never a `queued`/`leased` row a
   * worker might genuinely be holding, which would be a data race, not a recovery. Returns `null`
   * if `jobId` wasn't found or wasn't dead (nothing was changed).
   */
  async requeueDeadJob(jobId: string): Promise<Job | null> {
    const result = await this.pool.query(
      `update jobs set status='queued', attempts=0, leased_by=null, lease_expires_at=null,
         last_error = case when last_error is null then '[manually requeued]'
                           else last_error || ' [manually requeued]' end,
         run_at=now(), updated_at=now()
       where id=$1 and status='dead'
       returning *;`,
      [jobId],
    );
    if (result.rowCount === 0) {
      return null;
    }
    return mapRow(result.rows[0]);
  }

  /**
   * Not part of the Queue API in CONTRACTS.md §5, but required by the "every
   * worker upserts worker_heartbeats every QUEUE_HEARTBEAT_MS" rule in the
   * same section. Kept here (rather than duplicated ad hoc SQL in worker.ts)
   * since worker_heartbeats is a queue-schema table.
   */
  async upsertWorkerHeartbeat(
    workerId: string,
    kind: string,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    await this.pool.query(
      `insert into worker_heartbeats (worker_id, kind, last_seen_at, meta)
       values ($1, $2, now(), $3)
       on conflict (worker_id) do update set kind=excluded.kind, last_seen_at=now(), meta=excluded.meta;`,
      [workerId, kind, meta],
    );
  }
}
