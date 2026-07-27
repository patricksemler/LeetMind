// M4 chaos suite — scenario 5: concurrent claim storm.
//
// packages/queue/src/queue.test.ts already proves `FOR UPDATE SKIP LOCKED` under contention
// against ITS OWN throwaway container/schema (test #2). This test proves the same property against
// THIS app's real, migrated `jobs` table in leetmind_test, with more workers and more jobs, and
// racing real `ack()` completions in as well as `claim()`s — many concurrent claim-loops, many
// queued jobs: total processed must equal total enqueued, and no id may be processed twice.
import { describe, expect, it, afterEach } from "vitest";
import { getPool } from "@leetmind/db";
import type { Queue } from "@leetmind/queue";
import {
  CHAOS_QUEUE_KIND,
  assertNoStrayJobs,
  deleteJobs,
  isDatabaseReachable,
  testQueue,
} from "./chaos-helpers.js";

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)(
  "chaos 5: concurrent claim storm (many workers, many jobs, real DB contention)",
  () => {
    const jobIds: string[] = [];

    afterEach(async () => {
      await deleteJobs(jobIds.splice(0));
    });

    async function claimLoop(queue: Queue, workerId: string, processed: string[]): Promise<void> {
      while (true) {
        const job = await queue.claim([CHAOS_QUEUE_KIND], workerId);
        if (!job) return;
        // A little jittered "work" so claim loops genuinely interleave rather than one worker
        // draining the whole queue before another gets a chance to start.
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        processed.push(job.id);
        await queue.ack(job.id, workerId);
      }
    }

    it("50 jobs, 10 concurrent claimers: every job processed exactly once, none lost, none duplicated", async () => {
      await assertNoStrayJobs(CHAOS_QUEUE_KIND);

      const queue = testQueue({ workerId: "storm-test" });
      const pool = getPool();

      const JOB_COUNT = 50;
      const CLAIMER_COUNT = 10;

      const enqueuedIds: string[] = [];
      for (let i = 0; i < JOB_COUNT; i++) {
        const job = await queue.enqueue(pool, { kind: CHAOS_QUEUE_KIND, payload: { i } });
        enqueuedIds.push(job!.id);
      }
      jobIds.push(...enqueuedIds);

      const processed: string[][] = Array.from({ length: CLAIMER_COUNT }, () => []);
      await Promise.all(
        Array.from({ length: CLAIMER_COUNT }, (_, i) =>
          claimLoop(queue, `storm-worker-${i}`, processed[i]!),
        ),
      );

      const allProcessed = processed.flat();
      const uniqueProcessed = new Set(allProcessed);

      expect(
        allProcessed.length,
        `total processed (${allProcessed.length}) must equal total enqueued (${JOB_COUNT}). ` +
          `Duplicate ids seen: ${[...allProcessed].filter((id, i) => allProcessed.indexOf(id) !== i).join(", ") || "(none)"}`,
      ).toBe(JOB_COUNT);
      expect(uniqueProcessed.size, "no job id may be processed twice").toBe(JOB_COUNT);
      expect(uniqueProcessed).toEqual(new Set(enqueuedIds));

      // Every enqueued job must have reached 'done' — nothing left behind mid-flight.
      const { rows } = await pool.query<{ status: string; count: string }>(
        `select status, count(*)::text as count from jobs where kind = $1 group by status`,
        [CHAOS_QUEUE_KIND],
      );
      expect(rows).toEqual([{ status: "done", count: String(JOB_COUNT) }]);
    }, 30_000);
  },
);
