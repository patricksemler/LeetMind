// M4 chaos suite — scenario 3: lease theft.
//
// apps/judge/test/handler.test.ts's existing test #4 already proves the SHAPE of this guarantee
// (a `ctx.heartbeat` that returns false aborts without a verdict), but does so with a hand-built
// `makeCtx({ heartbeat: async () => false })` — a mock, not a real theft. This test reproduces the
// real race: claim the job as "worker-A", force its lease to actually expire, let the REAL reaper
// (`queue.reapExpired()`) requeue it, then let a second real claim ("worker-B") steal it — so when
// worker A's `ctx.heartbeat` is wired to a genuine `queue.heartbeat(jobId, "worker-A")` call, it
// returns false because the `jobs` row really is no longer leased by A, not because a test double
// says so.
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import type { UserConceptStateRow } from "@leetmind/db";
import type { Job } from "@leetmind/queue";
import type { JudgeJobPayload } from "@leetmind/shared";
import { createJudgeHandler } from "../../src/handler.js";
import {
  countExecutionAttempts,
  countLearningEvents,
  deleteJobs,
  enqueueJudgeJob,
  insertTestSubmission,
  isDatabaseReachable,
  isDockerReachable,
  reloadSubmission,
  restoreConceptState,
  seedApprovedProblem,
  silentLogger,
  snapshotConceptState,
  teardownProblem,
  TEST_USER_ID,
  testJudgeDeps,
  testQueue,
  waitFor,
  type SeededProblem,
} from "./chaos-helpers.js";

const dbReachable = await isDatabaseReachable();
const dockerReachable = dbReachable ? await isDockerReachable() : false;
const canRun = dbReachable && dockerReachable;

describe.skipIf(!canRun)("chaos 3: lease theft (real reaper-driven, not a mocked heartbeat)", () => {
  const deps = testJudgeDeps();
  const handler = createJudgeHandler(deps);
  const queue = testQueue({ leaseSeconds: 1 });

  let conceptSnapshot: UserConceptStateRow;
  const problemsToTeardown: SeededProblem[] = [];
  const jobIdsToTeardown: string[] = [];

  beforeAll(async () => {
    conceptSnapshot = await snapshotConceptState();
  });

  afterEach(async () => {
    await restoreConceptState(conceptSnapshot);
    await deleteJobs(jobIdsToTeardown.splice(0));
    let problem: SeededProblem | undefined;
    while ((problem = problemsToTeardown.pop())) {
      await teardownProblem(problem);
    }
  });

  it("a genuinely stolen lease makes heartbeat() return false; handler aborts before writing a verdict", async () => {
    const problem = await seedApprovedProblem();
    problemsToTeardown.push(problem);
    const submission = await insertTestSubmission({
      versionId: problem.versionId,
      source: "def solve(a, b):\n    return a + b\n",
      mode: "submit",
    });

    const jobId = await enqueueJudgeJob(queue, submission);
    jobIdsToTeardown.push(jobId);

    // Worker A claims it for real.
    const claimedByA = await queue.claim(["judge"], "worker-A");
    expect(claimedByA?.id).toBe(jobId);
    expect(claimedByA?.leased_by).toBe("worker-A");

    // Its 1s lease expires for real (no heartbeat sent), and the real reaper requeues it. Poll
    // reapExpired() (safe to call repeatedly -- it's a no-op until the lease has actually expired)
    // rather than a single fixed sleep-then-check: a one-shot "sleep 1.2s, expect exactly one
    // reap" leaves only ~200ms of slack between the 1s lease and the check, which is thin enough
    // to flake under real system load (slow Postgres round-trip, GC pause, CI noisy-neighbor).
    let reapedCount = 0;
    await waitFor(
      async () => {
        reapedCount = await queue.reapExpired();
        return reapedCount > 0 ? true : undefined;
      },
      { timeoutMs: 10_000, intervalMs: 100, describe: `reaper requeuing worker-A's expired lease on job ${jobId}` },
    );
    expect(reapedCount, "expected the real reaper to requeue worker-A's expired lease").toBe(1);

    // Worker B steals it.
    const claimedByB = await queue.claim(["judge"], "worker-B");
    expect(claimedByB?.id).toBe(jobId);
    expect(claimedByB?.leased_by).toBe("worker-B");

    // Now run the REAL handler as if it were still worker A, continuing to work on the job object
    // it originally claimed, with ctx.heartbeat wired to a REAL queue.heartbeat("worker-A") call
    // — which must return false, since the `jobs` row is genuinely leased by worker-B now.
    let heartbeatCalls = 0;
    await handler(claimedByA as Job<JudgeJobPayload>, {
      signal: new AbortController().signal,
      heartbeat: async () => {
        heartbeatCalls++;
        return queue.heartbeat(jobId, "worker-A");
      },
      logger: silentLogger(),
    });

    expect(heartbeatCalls, "expected the handler to actually call ctx.heartbeat() before executing").toBeGreaterThan(0);

    const reloaded = await reloadSubmission(submission.id);
    expect(reloaded.status, "submission must still be non-terminal — worker A must not write a verdict it no longer owns").not.toBe(
      "completed",
    );
    expect(reloaded.verdict).toBeNull();
    expect(await countExecutionAttempts(submission.id)).toBe(0);
    expect(await countLearningEvents(submission.id)).toBe(0);

    // Clean up worker B's still-leased claim so it doesn't linger as a phantom lease for other
    // tests in this file (deleteJobs in afterEach will remove the row regardless, but ack() is
    // the honest way to release it first).
    await queue.ack(jobId, "worker-B");
  }, 30_000);
});
