// M4 chaos suite — scenario 1: duplicate delivery, driven CONCURRENTLY (not sequentially).
//
// apps/judge/test/handler.test.ts's existing "duplicate delivery" test (#3) already proves the
// idempotency guard is correct for SEQUENTIAL redelivery (call handler(), await it, call it
// again) — but sequential delivery trivially short-circuits on the second call via the
// `submission.status === 'completed'` guard at the top of handleJudgeJob, which never gets a
// chance to race anything. The real guarantee PLAN.md §12 risk 4 cares about is what happens when
// N deliveries are genuinely IN FLIGHT AT ONCE (e.g. a lease-expiry reap raced a still-completing
// worker, so the reaper's requeue lets a second claimant start before the first one has finished)
// — that's exactly what forces concurrent, overlapping executions of `insertLearningEvent`'s
// `on conflict (idempotency_key) do nothing` to race for real against Postgres, not just be
// exercised as a no-op fast path. This test drives that directly: N concurrent calls to the SAME
// handler, same job, same DB pool.
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import type { UserConceptStateRow } from "@algolift/db";
import { createJudgeHandler } from "../../src/handler.js";
import {
  countLearningEvents,
  insertTestSubmission,
  isDatabaseReachable,
  isDockerReachable,
  makeCtx,
  makeJudgeJob,
  reloadSubmission,
  restoreConceptState,
  seedApprovedProblem,
  snapshotConceptState,
  teardownProblem,
  TEST_USER_ID,
  testJudgeDeps,
  type SeededProblem,
} from "../helpers.js";

const dbReachable = await isDatabaseReachable();
const dockerReachable = dbReachable ? await isDockerReachable() : false;
const canRun = dbReachable && dockerReachable;

describe.skipIf(!canRun)("chaos 1: duplicate delivery, N concurrent handler invocations of the same job", () => {
  const deps = testJudgeDeps();
  const handler = createJudgeHandler(deps);

  let conceptSnapshot: UserConceptStateRow;
  const problemsToTeardown: SeededProblem[] = [];

  beforeAll(async () => {
    conceptSnapshot = await snapshotConceptState();
  });

  afterEach(async () => {
    await restoreConceptState(conceptSnapshot);
    let problem: SeededProblem | undefined;
    while ((problem = problemsToTeardown.pop())) {
      await teardownProblem(problem);
    }
  });

  it("exactly one terminal verdict, exactly one learning_events row, rating moves exactly once despite N=8 concurrent deliveries", async () => {
    const problem = await seedApprovedProblem();
    problemsToTeardown.push(problem);
    const submission = await insertTestSubmission({
      versionId: problem.versionId,
      source: "def solve(a, b):\n    return a + b\n",
      mode: "submit",
    });

    const job = makeJudgeJob({
      submission_id: submission.id,
      mode: "submit",
      language: "python",
      problem_version_id: problem.versionId,
      user_id: TEST_USER_ID,
    });

    const before = await snapshotConceptState();

    const N = 8;
    // The critical difference from the sequential test: Promise.all, not N awaited calls. Every
    // one of these starts before any other has written a verdict.
    const results = await Promise.allSettled(Array.from({ length: N }, () => handler(job, makeCtx())));
    const rejected = results.filter((r) => r.status === "rejected");
    expect(
      rejected.length,
      `expected all ${N} concurrent handler() calls to resolve without throwing; ${rejected.length} rejected: ` +
        rejected.map((r) => (r as PromiseRejectedResult).reason).join(" | "),
    ).toBe(0);

    const reloaded = await reloadSubmission(submission.id);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.verdict).toBe("accepted");

    const learningEventsAfterBatch = await countLearningEvents(submission.id);
    expect(
      learningEventsAfterBatch,
      `expected exactly 1 learning_events row for submission ${submission.id} after ${N} concurrent ` +
        `deliveries, got ${learningEventsAfterBatch}`,
    ).toBe(1);

    const afterBatch = await snapshotConceptState();
    expect(afterBatch.rating).toBeGreaterThan(before.rating);

    // "runs 2..N don't move it further": deliver the same job a few MORE times, now strictly
    // after the concurrent batch has settled, and confirm mastery is still frozen at one
    // application. This is the sequential tail the concurrent batch itself can't cleanly express
    // (concurrent calls have no well-ordered "run 2" to point at), so it's asserted separately.
    for (let i = 0; i < 3; i++) {
      await handler(job, makeCtx());
    }

    const afterExtraDeliveries = await snapshotConceptState();
    expect(afterExtraDeliveries.rating).toBe(afterBatch.rating);
    expect(afterExtraDeliveries.uncertainty).toBe(afterBatch.uncertainty);
    expect(await countLearningEvents(submission.id)).toBe(1);

    const finalSubmission = await reloadSubmission(submission.id);
    expect(finalSubmission.verdict).toBe("accepted");
    expect(finalSubmission.status).toBe("completed");
  }, 60_000);
});
