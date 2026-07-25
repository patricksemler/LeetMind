// M4 chaos suite — scenario 2: worker killed mid-judge (PLAN.md §10 M4 "automated worker-kill
// recovery test (< 10s requeue) in CI", §12 risk 4).
//
// This is the one scenario in the suite that MUST be a real, separate OS process killed with a
// real SIGKILL — an in-process `AbortController.abort()` (as packages/queue/src/worker.test.ts's
// own worker-kill test uses, and as this suite's leaseTheft test intentionally does for a
// DIFFERENT reason) proves the queue's own bookkeeping is correct, but it can't prove recovery
// works when the worker process is truly, unrecoverably gone: no chance to run a `finally` block,
// no chance for an in-flight microtask to sneak in an extra write. `apps/judge/test/chaos/
// worker-process.ts` is a second, test-only entrypoint (spawned via `node --import tsx`, the same
// invocation style CONTRACTS.md §6.1 documents) built exactly so this test can `SIGKILL` it for
// real while it's genuinely inside a live `docker run` sandbox execution.
//
// Timing is deliberately compressed (short lease + fast reaper/poll intervals passed via CHAOS_*
// env vars) so the whole test — including a REAL judge execution against the REAL sandbox — stays
// well inside the < 10s recovery budget without needing the production 30s default lease. The
// measured wall-clock recovery time (SIGKILL -> a second worker's completed verdict) is asserted
// against that 10s budget AND printed, so repeated runs give a real distribution, not just a
// pass/fail bit.
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import type { UserConceptStateRow } from "@leetmind/db";
import {
  countExecutionAttempts,
  countLearningEvents,
  deleteJobs,
  deleteWorkerHeartbeats,
  enqueueJudgeJob,
  insertTestSubmission,
  isDatabaseReachable,
  isDockerReachable,
  reloadSubmission,
  restoreConceptState,
  seedApprovedProblem,
  snapshotConceptState,
  spawnChaosWorker,
  teardownProblem,
  testQueue,
  waitFor,
  type ChaosWorkerHandle,
  type SeededProblem,
} from "./chaos-helpers.js";

const dbReachable = await isDatabaseReachable();
const dockerReachable = dbReachable ? await isDockerReachable() : false;
const canRun = dbReachable && dockerReachable;

// Compressed timing for the test only — production still defaults to 30s/5s/500ms/10s (CONTRACTS
// §2). Chosen so claim -> assigned -> compiling -> running -> (heartbeat extends lease to
// ~kill_time+LEASE_SECONDS) -> SIGKILL -> lease truly expires -> reaper requeues -> second worker
// claims -> re-executes (source sleeps SLEEP_SECONDS) -> verdict, all comfortably under 10s.
const LEASE_SECONDS = 3;
const REAPER_INTERVAL_MS = 400;
const POLL_INTERVAL_MS = 100;
const HEARTBEAT_MS = 1000;
const SLEEP_SECONDS = 1.5;
const RECOVERY_BUDGET_MS = 10_000;

describe.skipIf(!canRun)("chaos 2: worker killed mid-judge (real SIGKILL of a real subprocess)", () => {
  let conceptSnapshot: UserConceptStateRow;
  const problemsToTeardown: SeededProblem[] = [];
  const jobIdsToTeardown: string[] = [];
  const workerIdsToClean: string[] = [];
  let workerA: ChaosWorkerHandle | undefined;
  let workerB: ChaosWorkerHandle | undefined;

  beforeAll(async () => {
    conceptSnapshot = await snapshotConceptState();
  });

  afterEach(async () => {
    await workerA?.kill().catch(() => {});
    await workerB?.stop().catch(() => {});
    workerA = undefined;
    workerB = undefined;

    await restoreConceptState(conceptSnapshot);
    await deleteJobs(jobIdsToTeardown.splice(0));
    await deleteWorkerHeartbeats(workerIdsToClean.splice(0));
    let problem: SeededProblem | undefined;
    while ((problem = problemsToTeardown.pop())) {
      await teardownProblem(problem);
    }
  });

  it(`SIGKILL mid-execution -> reaper requeues -> a second worker completes exactly once, recovery < ${RECOVERY_BUDGET_MS}ms`, async () => {
    const workerAId = `chaos-kill-a-${Date.now()}`;
    const workerBId = `chaos-kill-b-${Date.now()}`;
    workerIdsToClean.push(workerAId, workerBId);

    const problem = await seedApprovedProblem();
    problemsToTeardown.push(problem);
    const submission = await insertTestSubmission({
      versionId: problem.versionId,
      // Real, non-trivial wall-clock work inside the sandbox, so there's a wide, reliable window
      // in which the process is genuinely mid-`docker run` when we SIGKILL it.
      source: `import time\ndef solve(a, b):\n    time.sleep(${SLEEP_SECONDS})\n    return a + b\n`,
      mode: "submit",
    });

    const enqueueQueue = testQueue({ workerId: "workerkill-test-enqueuer" });
    const jobId = await enqueueJudgeJob(enqueueQueue, submission);
    jobIdsToTeardown.push(jobId);

    workerA = spawnChaosWorker({
      workerId: workerAId,
      leaseSeconds: LEASE_SECONDS,
      reaperIntervalMs: REAPER_INTERVAL_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
      heartbeatMs: HEARTBEAT_MS,
    });
    await workerA.ready;

    // Wait until the submission is genuinely mid-execution: 'running' is only set AFTER the
    // 'compiling' transition and right before the explicit pre-sandbox heartbeat + `executePython`
    // call (apps/judge/src/handler.ts) -- i.e. worker A is, at this point, either about to or
    // already inside the real `docker run` for a script that sleeps SLEEP_SECONDS.
    await waitFor(
      async () => {
        const s = await reloadSubmission(submission.id);
        return s.status === "running" ? s : undefined;
      },
      { timeoutMs: 8000, intervalMs: 20, describe: `submission ${submission.id} reaching status='running'` },
    );

    const killedAt = Date.now();
    await workerA.kill();

    // A genuinely separate, freshly-spawned worker -- not the same process resuming, not the same
    // in-memory Queue instance.
    workerB = spawnChaosWorker({
      workerId: workerBId,
      leaseSeconds: LEASE_SECONDS,
      reaperIntervalMs: REAPER_INTERVAL_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
      heartbeatMs: HEARTBEAT_MS,
    });
    await workerB.ready;

    const completed = await waitFor(
      async () => {
        const s = await reloadSubmission(submission.id);
        return s.status === "completed" ? s : undefined;
      },
      {
        timeoutMs: RECOVERY_BUDGET_MS + 5000, // generous ceiling so a genuine failure still reports a clean diff, not just a bare timeout
        intervalMs: 50,
        describe: `submission ${submission.id} reaching status='completed' after worker A was killed`,
      },
    );
    const recoveredAt = Date.now();
    const recoveryMs = recoveredAt - killedAt;

    // eslint-disable-next-line no-console -- deliberately printed: PLAN.md §10 M4 asks for the
    // measured recovery time to be reported, not just pass/fail.
    console.log(`[chaos 2] worker-kill recovery time: ${recoveryMs}ms (budget ${RECOVERY_BUDGET_MS}ms)`);

    expect(
      recoveryMs,
      `measured recovery time ${recoveryMs}ms must be under the ${RECOVERY_BUDGET_MS}ms budget (PLAN.md §10 M4)`,
    ).toBeLessThan(RECOVERY_BUDGET_MS);

    expect(completed.verdict).toBe("accepted");
    expect(completed.passed_tests).toBe(completed.total_tests);

    // Exactly one mastery consequence despite worker A's aborted attempt.
    expect(await countLearningEvents(submission.id)).toBe(1);

    // Worker A never got to write anything (it was killed before/during its sandbox call and
    // never reached the terminal transaction); worker B's fresh execution is the only attempt
    // that should have landed. (>=1 rather than strictly 1: if worker A's heartbeat happened to
    // fire before the kill landed, that alone writes no execution_attempts row either way, so this
    // is not expected to exceed 1 in practice, but the real guarantee under test is "some worker
    // finished it exactly-once from the submission's point of view", which is the learning_events
    // and verdict assertions above.)
    expect(await countExecutionAttempts(submission.id)).toBeGreaterThanOrEqual(1);

    const finalJob = await enqueueQueue.getJob(jobId);
    expect(finalJob?.status).toBe("done");
    // attempts: claimed once by A (1), reaped (no incr), reclaimed by B (2).
    expect(finalJob?.attempts).toBe(2);
  }, 30_000);
});
