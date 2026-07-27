// M4 chaos suite — scenario 4: poison job.
//
// packages/queue/src/queue.test.ts already proves `Queue.fail()` itself dead-letters correctly at
// the SQL level (test #7). This test proves the same guarantee holds one layer up, through the
// REAL `runWorker` polling loop (@leetmind/queue) against this app's real, migrated `jobs` table
// in leetmind_test — a handler that always throws must be retried up to `max_attempts` and then
// permanently parked `dead`, never looped on forever, never silently dropped.
import { describe, expect, it, afterEach } from "vitest";
import { getPool } from "@leetmind/db";
import { runWorker, type Logger as QueueLogger } from "@leetmind/queue";
import { silentLogger } from "../helpers.js";
import {
  CHAOS_QUEUE_KIND,
  assertNoStrayJobs,
  deleteJobs,
  deleteWorkerHeartbeats,
  isDatabaseReachable,
  testQueue,
  waitFor,
} from "./chaos-helpers.js";

const dbReachable = await isDatabaseReachable();
const POISON_WORKER_ID = "poison-test";

describe.skipIf(!dbReachable)(
  "chaos 4: poison job (always-throwing handler -> dead after max_attempts, never loops forever)",
  () => {
    const jobIds: string[] = [];

    afterEach(async () => {
      await deleteJobs(jobIds.splice(0));
      // runWorker() upserts a worker_heartbeats row for this worker id as a side effect (both
      // immediately on start and on every heartbeatMs tick) -- clean it up too, per §13 rule 3.
      await deleteWorkerHeartbeats([POISON_WORKER_ID]);
    });

    it("lands in 'dead' after exactly max_attempts, records the last thrown error, and stops being claimable", async () => {
      await assertNoStrayJobs(CHAOS_QUEUE_KIND);

      const queue = testQueue({ workerId: POISON_WORKER_ID });
      const maxAttempts = 3;

      const enqueued = await queue.enqueue(getPool(), {
        kind: CHAOS_QUEUE_KIND,
        payload: { note: "always throws" },
        maxAttempts,
      });
      expect(enqueued).not.toBeNull();
      const jobId = enqueued!.id;
      jobIds.push(jobId);

      let handlerCalls = 0;
      const controller = new AbortController();
      const workerPromise = runWorker({
        queue,
        kinds: [CHAOS_QUEUE_KIND],
        concurrency: 1,
        handler: async () => {
          handlerCalls++;
          throw new Error(`poison job handler call #${handlerCalls}`);
        },
        logger: silentLogger() as unknown as QueueLogger,
        workerId: POISON_WORKER_ID,
        signal: controller.signal,
        pollIntervalMs: 50,
        heartbeatMs: 60_000,
        // Give fail()'s exponential backoff no room to stretch this test out — the interesting
        // thing under test is the ATTEMPT COUNTING and terminal state, not the backoff curve
        // (which packages/queue/src/queue.ts's `backoffMs` unit-level behavior is not this
        // package's concern). We can't pass retryInMs through runWorker (it always calls
        // `queue.fail(id, workerId, message)` with no opts), so instead keep max_attempts small and
        // bound the wait generously; the assertion that matters is the FINAL state, not the timing.
      });

      const dead = await waitFor(
        async () => {
          const job = await queue.getJob(jobId);
          return job?.status === "dead" ? job : undefined;
        },
        { timeoutMs: 45_000, intervalMs: 200, describe: `job ${jobId} reaching status='dead'` },
      );

      controller.abort();
      await workerPromise;

      expect(dead.attempts, "must have stopped at exactly max_attempts, not kept retrying").toBe(
        maxAttempts,
      );
      expect(dead.max_attempts).toBe(maxAttempts);
      expect(dead.last_error).toContain("poison job handler call");
      expect(
        handlerCalls,
        "the handler must have been invoked exactly max_attempts times, never more",
      ).toBe(maxAttempts);

      // Never loops forever, part 2: give the (now-stopped) worker's absence a moment, then confirm
      // nothing else picks this job up — it must not be claimable anymore.
      const stillDead = await queue.claim([CHAOS_QUEUE_KIND], "observer");
      expect(stillDead).toBeNull();

      const finalCheck = await queue.getJob(jobId);
      expect(finalCheck?.status).toBe("dead");
      expect(finalCheck?.attempts).toBe(maxAttempts);
    }, 60_000);
  },
);
