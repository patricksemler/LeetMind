// Types for @algolift/queue. Field names mirror the `jobs` / `worker_heartbeats`
// table columns from docs/CONTRACTS.md §3 verbatim (snake_case), since these are
// effectively row projections, not domain objects with a separate naming scheme.

/** Structural logger type compatible with the pino instance @algolift/shared's
 * createLogger(service) returns (obj-first call signature). Kept local (rather
 * than importing a type from @algolift/shared) so this package only depends on
 * the documented value exports. */
export interface Logger {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  child?: (bindings: Record<string, unknown>) => Logger;
}

export type JobStatus = 'queued' | 'leased' | 'done' | 'failed' | 'dead' | 'cancelled';

export interface Job<TPayload = unknown> {
  id: string;
  kind: string;
  priority: number;
  payload: TPayload;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  lease_expires_at: Date | null;
  leased_by: string | null;
  last_error: string | null;
  idempotency_key: string | null;
  correlation_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface EnqueueInput<TKind extends string = string, TPayload = unknown> {
  kind: TKind;
  payload: TPayload;
  priority?: number;
  maxAttempts?: number;
  runAt?: Date;
  idempotencyKey?: string;
  correlationId?: string;
}

export interface FailOpts {
  retryInMs?: number;
}

export type FailResult = 'retry' | 'dead';

export interface QueueKindStats {
  kind: string;
  counts: Record<string, number>;
  oldest_queued_age_ms: number | null;
}

/** A `dead` job plus how long it's been sitting there — the "enough context to debug" shape for
 * poison-job parking (CONTRACTS.md §5 / M4). `age_ms` is time since the row's last `updated_at`
 * (i.e. since it went dead), not since `created_at`. */
export interface DeadJobInfo extends Job {
  age_ms: number;
}

/**
 * Snapshot of how many jobs required more than a single attempt, bucketed by current outcome.
 * Built from the `jobs` table alone (PLAN.md §14: plain SQL over existing tables, no new
 * schema) via two signals, both approximate and documented as such:
 *
 *  - `reaped_total` counts rows whose `last_error` is exactly `'lease expired'` -- the literal
 *    string `reapExpired()` writes via `coalesce(jobs.last_error, 'lease expired')`. Because that
 *    `coalesce` only fires when `last_error` was NULL, this is precise for the common case (a
 *    worker crashes, the reaper requeues it once, nothing else about the job ever fails again --
 *    `ack()` never touches `last_error`, so the marker survives to completion) but UNDERCOUNTS
 *    jobs that were reaped and *then* failed again for an unrelated reason (that later `fail()`
 *    overwrites `last_error`, erasing the marker). There is no separate reap-events log; this is
 *    the best available signal without a migration, which is out of this package's scope.
 *  - The status buckets below (`recovered` / `still_pending` / `dead_after_reap`) are computed
 *    only over that `reaped_total` set, so they inherit the same undercount.
 */
export interface LeaseRecoveryStats {
  /** Jobs ever tagged with the lease-expired marker (see caveat above). */
  reaped_total: number;
  /** Of those, ones that reached a terminal `done` status -- lease recovery worked. */
  recovered: number;
  /** Of those, ones still `queued` or `leased` -- recovery in progress / awaiting a worker. */
  still_pending: number;
  /** Of those, ones that exhausted `max_attempts` and landed `dead` -- recovery gave up. */
  dead_after_reap: number;
}

export interface QueueStats {
  kinds: QueueKindStats[];
  /** p50/p95 wait time (ms) for jobs whose approximate claim time falls within
   * the last hour. See Queue.stats() doc comment for the approximation used. */
  wait_time_ms: { p50: number | null; p95: number | null };
  dead_count: number;
  recent_dead: DeadJobInfo[];
  lease_recovery: LeaseRecoveryStats;
}

export interface QueueOpts {
  leaseSeconds?: number;
  workerId?: string;
  logger?: Logger;
}
