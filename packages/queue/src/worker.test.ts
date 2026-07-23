import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Queue } from './queue.js';
import { runWorker } from './worker.js';
import { setupSchema, truncateAll, tryConnect } from './test-fixture.js';
import type { Logger } from './types.js';

function makeLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  logger.child = () => logger;
  return logger;
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

const pool = await tryConnect();

describe.skipIf(pool === null)('runWorker (integration, real Postgres)', () => {
  const p = pool as Pool;

  beforeAll(async () => {
    await setupSchema(p);
  });

  beforeEach(async () => {
    await truncateAll(p);
  });

  afterAll(async () => {
    await p.end();
  });

  it(
    '8. end-to-end: N jobs, concurrency 4, all acked, none double-processed',
    async () => {
      const queue = new Queue(p, { leaseSeconds: 30 });
      const N = 12;
      const ids: string[] = [];
      for (let i = 0; i < N; i++) {
        const job = await queue.enqueue(p, { kind: 'generate', payload: { i } });
        ids.push(job!.id);
      }

      const processed: string[] = [];
      const controller = new AbortController();

      const workerPromise = runWorker({
        queue,
        kinds: ['generate'],
        concurrency: 4,
        handler: async (job) => {
          processed.push(job.id);
          await new Promise((r) => setTimeout(r, 5));
        },
        logger: makeLogger(),
        workerId: 'worker-e2e',
        signal: controller.signal,
        pollIntervalMs: 25,
        heartbeatMs: 5000,
      });

      await waitFor(async () => {
        const { rows } = await p.query<{ c: number }>(
          `select count(*)::int as c from jobs where status='done' and id = any($1)`,
          [ids],
        );
        return rows[0]!.c === N;
      }, 5000);

      controller.abort();
      await workerPromise;

      expect(processed.length).toBe(N);
      expect(new Set(processed).size).toBe(N);

      for (const id of ids) {
        const job = await queue.getJob(id);
        expect(job!.status).toBe('done');
      }
    },
    10_000,
  );

  it(
    '9. worker-kill recovery: hung handler + expired lease -> reaper requeues -> second worker completes exactly once',
    async () => {
      const queue = new Queue(p, { leaseSeconds: 30 });
      const enqueued = await queue.enqueue(p, { kind: 'generate', payload: { hang: true } });
      const jobId = enqueued!.id;

      const controllerA = new AbortController();
      let handlerAStarted = false;
      const workerAPromise = runWorker({
        queue,
        kinds: ['generate'],
        concurrency: 1,
        handler: async () => {
          handlerAStarted = true;
          // Simulate a truly hung / crashed worker: never resolves, and
          // ignores the abort signal -- a real dead process wouldn't
          // gracefully cooperate either. Recovery must not depend on it.
          await new Promise<void>(() => {});
        },
        logger: makeLogger(),
        workerId: 'worker-A',
        // Deliberately long: must not fire during this test, so the lease
        // isn't kept alive behind our back before we force-expire it.
        heartbeatMs: 60_000,
        signal: controllerA.signal,
        pollIntervalMs: 25,
      });
      // Deliberately not awaited -- worker A "hangs forever"; a real crashed
      // process never runs its own graceful-shutdown path either.
      void workerAPromise;

      await waitFor(async () => handlerAStarted, 2000);
      const leased = await queue.getJob(jobId);
      expect(leased!.status).toBe('leased');
      expect(leased!.leased_by).toBe('worker-A');
      expect(leased!.attempts).toBe(1);

      // Kill worker A: abort it (models SIGKILL) and force its lease into the
      // past (models the lease timing out because no more heartbeats arrive).
      controllerA.abort();
      await p.query(`update jobs set lease_expires_at = now() - interval '1 second' where id=$1`, [
        jobId,
      ]);

      const reaped = await queue.reapExpired();
      expect(reaped).toBe(1);

      const requeued = await queue.getJob(jobId);
      expect(requeued!.status).toBe('queued');
      expect(requeued!.leased_by).toBeNull();

      // A second worker picks it up and completes it.
      const completions: string[] = [];
      const controllerB = new AbortController();
      const workerBPromise = runWorker({
        queue,
        kinds: ['generate'],
        concurrency: 1,
        handler: async (job) => {
          completions.push(job.id);
        },
        logger: makeLogger(),
        workerId: 'worker-B',
        signal: controllerB.signal,
        pollIntervalMs: 25,
        heartbeatMs: 5000,
      });

      await waitFor(async () => {
        const j = await queue.getJob(jobId);
        return j?.status === 'done';
      }, 5000);

      controllerB.abort();
      await workerBPromise;

      expect(completions).toEqual([jobId]);
      const final = await queue.getJob(jobId);
      expect(final!.status).toBe('done');
      // Claimed once by A (attempts=1), reaped (no incr), reclaimed by B (attempts=2).
      expect(final!.attempts).toBe(2);
    },
    15_000,
  );
});
