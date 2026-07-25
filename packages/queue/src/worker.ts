// @leetmind/shared per docs/CONTRACTS.md: runWithContext(ctx, fn) using AsyncLocalStorage.
import { runWithContext } from '@leetmind/shared';

import type { Queue } from './queue.js';
import type { Job, Logger } from './types.js';

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_HEARTBEAT_MS = 10_000;
const SHUTDOWN_GRACE_MS = 30_000;

export interface WorkerContext {
  signal: AbortSignal;
  /** Manually trigger a lease-extension heartbeat (in addition to the
   * automatic per-interval one). Resolves to false if the lease was lost. */
  heartbeat: () => Promise<boolean>;
  logger: Logger;
}

export type JobHandler<TPayload = unknown> = (
  job: Job<TPayload>,
  ctx: WorkerContext,
) => Promise<void>;

export interface RunWorkerOpts<TPayload = unknown> {
  queue: Queue;
  kinds: string[];
  concurrency: number;
  handler: JobHandler<TPayload>;
  logger: Logger;
  workerId: string;
  signal: AbortSignal;
  pollIntervalMs?: number;
  heartbeatMs?: number;
}

interface InFlight {
  job: Job;
  promise: Promise<void>;
  abortController: AbortController;
  leaseLost: boolean;
  heartbeatTimer: ReturnType<typeof setInterval>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never let a poll/shutdown-grace timer keep the process alive on its own.
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs a polling worker loop: keeps up to `concurrency` jobs in flight,
 * claiming a new one whenever a slot frees up, sleeping `pollIntervalMs`
 * when claim() returns null. Each in-flight job gets its own heartbeat timer
 * (every `heartbeatMs`) that extends the lease; if the lease was lost (stolen
 * by the reaper), the job's AbortSignal is tripped and the job is neither
 * acked nor failed on completion. Also upserts worker_heartbeats every
 * heartbeatMs. Resolves once `signal` aborts and all in-flight jobs settle
 * (bounded by SHUTDOWN_GRACE_MS).
 */
export async function runWorker<TPayload = unknown>(opts: RunWorkerOpts<TPayload>): Promise<void> {
  const {
    queue,
    kinds,
    concurrency,
    handler,
    logger,
    workerId,
    signal,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
  } = opts;

  const inFlight = new Map<string, InFlight>();

  const workerHeartbeatTimer = setInterval(() => {
    queue.upsertWorkerHeartbeat(workerId, kinds.join(','), {
      concurrency,
      in_flight: inFlight.size,
      pid: typeof process !== 'undefined' ? process.pid : undefined,
    }).catch((err) => {
      logger.error({ err, worker_id: workerId }, 'worker_heartbeats upsert failed');
    });
  }, heartbeatMs);
  workerHeartbeatTimer.unref?.();
  // Fire-and-forget one immediately so a freshly-started worker is visible
  // without waiting a full interval.
  queue
    .upsertWorkerHeartbeat(workerId, kinds.join(','), { concurrency, in_flight: 0 })
    .catch((err) => logger.error({ err, worker_id: workerId }, 'worker_heartbeats upsert failed'));

  function startJob(job: Job): void {
    const abortController = new AbortController();
    const jobLogger: Logger = logger.child
      ? logger.child({ job_id: job.id, kind: job.kind, worker_id: workerId })
      : logger;

    const entry: InFlight = {
      job,
      abortController,
      leaseLost: false,
      // placeholder, replaced below once `promise` exists
      promise: Promise.resolve(),
      heartbeatTimer: setInterval(() => {
        queue
          .heartbeat(job.id, workerId)
          .then((ok) => {
            if (!ok && !entry.leaseLost) {
              entry.leaseLost = true;
              jobLogger.warn({ job_id: job.id }, 'lease lost, aborting job');
              abortController.abort();
              // No point continuing to poll a lease we no longer hold.
              clearInterval(entry.heartbeatTimer);
            }
          })
          .catch((err) => {
            jobLogger.error({ err, job_id: job.id }, 'heartbeat failed');
          });
      }, heartbeatMs),
    };
    entry.heartbeatTimer.unref?.();

    const ctx: WorkerContext = {
      signal: abortController.signal,
      heartbeat: async () => {
        const ok = await queue.heartbeat(job.id, workerId);
        if (!ok && !entry.leaseLost) {
          entry.leaseLost = true;
          abortController.abort();
          clearInterval(entry.heartbeatTimer);
        }
        return ok;
      },
      logger: jobLogger,
    };

    const run = async (): Promise<void> => {
      try {
        await runWithContext(
          { correlationId: job.correlation_id ?? undefined, jobId: job.id, workerId },
          // queue.claim() cannot know the payload shape; the caller asserts it
          // via the TPayload type parameter of runWorker/JobHandler.
          () => handler(job as Job<TPayload>, ctx),
        );
        if (entry.leaseLost) {
          jobLogger.warn({ job_id: job.id }, 'handler completed after lease loss; not acking');
          return;
        }
        await queue.ack(job.id, workerId);
      } catch (err) {
        if (entry.leaseLost) {
          jobLogger.warn(
            { job_id: job.id, err },
            'handler threw after lease loss; not failing (already reclaimed)',
          );
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        try {
          const result = await queue.fail(job.id, workerId, message);
          jobLogger.error({ job_id: job.id, err: message, result }, 'job failed');
        } catch (failErr) {
          jobLogger.error({ job_id: job.id, err: failErr }, 'queue.fail() itself threw');
        }
      } finally {
        clearInterval(entry.heartbeatTimer);
        inFlight.delete(job.id);
      }
    };

    entry.promise = run();
    inFlight.set(job.id, entry);
  }

  try {
    while (!signal.aborted) {
      if (inFlight.size < concurrency) {
        const job = await queue.claim(kinds, workerId);
        if (job) {
          startJob(job);
          continue;
        }
      }
      await sleep(pollIntervalMs, signal);
    }
  } finally {
    clearInterval(workerHeartbeatTimer);
  }

  // Graceful shutdown: wait for in-flight jobs, bounded.
  const pending = Array.from(inFlight.values()).map((e) => e.promise);
  if (pending.length > 0) {
    await Promise.race([
      Promise.allSettled(pending),
      sleep(SHUTDOWN_GRACE_MS, new AbortController().signal),
    ]);
  }
}

/** Wires SIGINT/SIGTERM to abort the given controller (used to drive graceful
 * shutdown of runWorker / startReaper). Safe to call once per process. */
export function installShutdownHandlers(controller: AbortController): void {
  const shutdown = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
