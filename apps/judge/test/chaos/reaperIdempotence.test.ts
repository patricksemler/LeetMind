// M4 chaos suite — scenario 7: reaper idempotence.
//
// `Queue.reapExpired()`'s doc comment claims concurrent reapers are safe because the requeue query
// uses `FOR UPDATE SKIP LOCKED` in a CTE. This test proves it under real concurrency: many jobs
// with expired leases, many reaper instances calling `reapExpired()` at the same moment — no job
// may be reaped twice (double-requeued, or double-deadened past its actual attempt count), and
// none may be left behind (still `leased` with an expired lease after every reaper has run).
import { describe, expect, it, afterEach } from "vitest";
import { getPool } from "@leetmind/db";
import { Queue } from "@leetmind/queue";
import {
  CHAOS_QUEUE_KIND,
  assertNoStrayJobs,
  deleteJobs,
  isDatabaseReachable,
  testQueue,
} from "./chaos-helpers.js";

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)(
  "chaos 7: reaper idempotence (concurrent reapers, real DB contention)",
  () => {
    const jobIds: string[] = [];

    afterEach(async () => {
      await deleteJobs(jobIds.splice(0));
    });

    it("N jobs with expired leases, 5 concurrent reapers: every job reaped exactly once, none left leased", async () => {
      await assertNoStrayJobs(CHAOS_QUEUE_KIND);

      const queue = testQueue({ workerId: "reaper-test", leaseSeconds: 1 });
      const pool = getPool();

      const JOB_COUNT = 20;
      const ids: string[] = [];
      for (let i = 0; i < JOB_COUNT; i++) {
        const job = await queue.enqueue(pool, {
          kind: CHAOS_QUEUE_KIND,
          payload: { i },
          maxAttempts: 3,
        });
        ids.push(job!.id);
        await queue.claim([CHAOS_QUEUE_KIND], `crashed-worker-${i}`);
      }
      jobIds.push(...ids);

      // Force every lease into the past at once (simulates all these workers having crashed
      // simultaneously — e.g. the machine losing power mid-batch).
      await pool.query(
        `update jobs set lease_expires_at = now() - interval '1 second' where kind = $1`,
        [CHAOS_QUEUE_KIND],
      );

      const REAPER_COUNT = 5;
      const reapers = Array.from(
        { length: REAPER_COUNT },
        () => new Queue(pool, { workerId: `reaper-${Math.random()}` }),
      );
      const counts = await Promise.all(reapers.map((r) => r.reapExpired()));
      const totalReaped = counts.reduce((a, b) => a + b, 0);

      expect(
        totalReaped,
        `5 concurrent reapers together must reap exactly ${JOB_COUNT} jobs once each (got per-reaper counts ${JSON.stringify(counts)})`,
      ).toBe(JOB_COUNT);

      // None left behind in 'leased' — every job must now be 'queued' (attempts=1 < max_attempts=3).
      const { rows: statusRows } = await pool.query<{ status: string; count: string }>(
        `select status, count(*)::text as count from jobs where kind = $1 group by status`,
        [CHAOS_QUEUE_KIND],
      );
      expect(statusRows).toEqual([{ status: "queued", count: String(JOB_COUNT) }]);

      // Re-running reapExpired() now must find nothing left to do -- proves the first round didn't
      // miss anything that's still sitting there expired.
      const secondRoundCount = await queue.reapExpired();
      expect(secondRoundCount).toBe(0);

      // And no job was double-processed: every id is claimable exactly once more (attempts goes
      // from 1 -> 2, never higher, and each id appears exactly once across all claims).
      const reclaimedIds: string[] = [];
      while (true) {
        const job = await queue.claim([CHAOS_QUEUE_KIND], "verifier");
        if (!job) break;
        expect(
          job.attempts,
          `job ${job.id} should have attempts=2 (claimed once, reaped, reclaimed once) — got ${job.attempts}`,
        ).toBe(2);
        reclaimedIds.push(job.id);
      }
      expect(new Set(reclaimedIds)).toEqual(new Set(ids));
      expect(reclaimedIds.length).toBe(JOB_COUNT);
    }, 30_000);
  },
);
