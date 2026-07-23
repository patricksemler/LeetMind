import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { query, type UserConceptStateRow } from "@algolift/db";
import { createJudgeHandler } from "../src/handler.js";
import {
  countExecutionAttempts,
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
} from "./helpers.js";

const dbReachable = await isDatabaseReachable();
const dockerReachable = dbReachable ? await isDockerReachable() : false;
const canRun = dbReachable && dockerReachable;

describe.skipIf(!canRun)("handleJudgeJob (integration: live Postgres + Docker)", () => {
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

  async function seed(opts: Parameters<typeof seedApprovedProblem>[0] = {}): Promise<SeededProblem> {
    const problem = await seedApprovedProblem(opts);
    problemsToTeardown.push(problem);
    return problem;
  }

  it("1. happy path: correct solution against a 3-test hidden suite -> accepted + one learning event + rating up", async () => {
    const problem = await seed();
    const submission = await insertTestSubmission({
      versionId: problem.versionId,
      source: "def solve(a, b):\n    return a + b\n",
      mode: "submit",
      activeMs: 3 * 60_000,
    });

    const before = await snapshotConceptState();

    await handler(
      makeJudgeJob({
        submission_id: submission.id,
        mode: "submit",
        language: "python",
        problem_version_id: problem.versionId,
        user_id: TEST_USER_ID,
      }),
      makeCtx(),
    );

    const reloaded = await reloadSubmission(submission.id);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.verdict).toBe("accepted");
    expect(reloaded.passed_tests).toBe(3);
    expect(reloaded.total_tests).toBe(3);

    expect(await countExecutionAttempts(submission.id)).toBe(1);
    const attemptRows = await query<{ image_digest: string | null }>(
      "select image_digest from execution_attempts where submission_id = $1",
      [submission.id],
    );
    expect(attemptRows[0]?.image_digest).toBeTruthy();

    expect(await countLearningEvents(submission.id)).toBe(1);

    const after = await snapshotConceptState();
    expect(after.rating).toBeGreaterThan(before.rating);
  });

  it("2. wrong answer: verdict wrong_answer, rating moves down, failure never leaks the hidden expected value", async () => {
    const SECRET_EXPECTED = 918273645;
    const problem = await seed({
      hiddenTests: [
        { args: [1, 2], expected: 3, origin: "example" },
        { args: [500000, 500000], expected: SECRET_EXPECTED, origin: "random" },
        { args: [0, 0], expected: 0, origin: "boundary" },
      ],
    });
    const submission = await insertTestSubmission({
      versionId: problem.versionId,
      // Deliberately wrong: subtracts instead of adds.
      source: "def solve(a, b):\n    return a - b\n",
      mode: "submit",
    });

    const before = await snapshotConceptState();

    await handler(
      makeJudgeJob({
        submission_id: submission.id,
        mode: "submit",
        language: "python",
        problem_version_id: problem.versionId,
        user_id: TEST_USER_ID,
      }),
      makeCtx(),
    );

    const reloaded = await reloadSubmission(submission.id);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.verdict).toBe("wrong_answer");

    // Safe-diagnostics-only for `submit` mode (CONTRACTS §4.5): no preview fields at all, and —
    // belt and suspenders — the specific hidden expected value never appears anywhere in the
    // serialized failure, however it might have been (mis)represented.
    expect(reloaded.failure?.expected_preview).toBeUndefined();
    expect(reloaded.failure?.input_preview).toBeUndefined();
    expect(reloaded.failure?.actual_preview).toBeUndefined();
    expect(JSON.stringify(reloaded.failure ?? {})).not.toContain(String(SECRET_EXPECTED));

    const after = await snapshotConceptState();
    expect(after.rating).toBeLessThan(before.rating);
  });

  it("3. duplicate delivery: running the handler twice yields exactly one verdict, one learning event, one rating change", async () => {
    const problem = await seed();
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

    await handler(job, makeCtx());
    const afterFirst = await snapshotConceptState();
    const learningEventsAfterFirst = await countLearningEvents(submission.id);
    const attemptsAfterFirst = await countExecutionAttempts(submission.id);
    expect(learningEventsAfterFirst).toBe(1);
    expect(attemptsAfterFirst).toBe(1);

    // Second delivery of the SAME job (queue at-least-once redelivery, e.g. after a lease-expiry
    // requeue that raced a still-completing worker) must be a pure no-op past the duplicate guard.
    await handler(job, makeCtx());

    const afterSecond = await snapshotConceptState();
    expect(await countLearningEvents(submission.id)).toBe(1);
    expect(await countExecutionAttempts(submission.id)).toBe(1);
    expect(afterSecond.rating).toBe(afterFirst.rating);
    expect(afterSecond.uncertainty).toBe(afterFirst.uncertainty);

    const reloaded = await reloadSubmission(submission.id);
    expect(reloaded.verdict).toBe("accepted");
  });

  it("4. lease lost mid-judge: heartbeat() returning false aborts without writing a verdict", async () => {
    const problem = await seed();
    const submission = await insertTestSubmission({
      versionId: problem.versionId,
      source: "def solve(a, b):\n    return a + b\n",
      mode: "submit",
    });

    await handler(
      makeJudgeJob({
        submission_id: submission.id,
        mode: "submit",
        language: "python",
        problem_version_id: problem.versionId,
        user_id: TEST_USER_ID,
      }),
      makeCtx({ heartbeat: async () => false }),
    );

    const reloaded = await reloadSubmission(submission.id);
    // The handler progressed through assigned/compiling/running (each a legitimate, non-terminal
    // transition) but must have stopped BEFORE executing/writing a verdict once the lease-check
    // heartbeat came back false.
    expect(reloaded.status).not.toBe("completed");
    expect(reloaded.verdict).toBeNull();
    expect(await countExecutionAttempts(submission.id)).toBe(0);
    expect(await countLearningEvents(submission.id)).toBe(0);
  });

  it("5. run mode: never writes a learning_events row, and DOES include input/expected previews", async () => {
    const problem = await seed();
    const submission = await insertTestSubmission({
      versionId: problem.versionId,
      // Wrong on purpose so there's a `failure` to inspect for previews.
      source: "def solve(a, b):\n    return a - b\n",
      mode: "run",
    });

    await handler(
      makeJudgeJob({
        submission_id: submission.id,
        mode: "run",
        language: "python",
        problem_version_id: problem.versionId,
        user_id: TEST_USER_ID,
      }),
      makeCtx(),
    );

    const reloaded = await reloadSubmission(submission.id);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.verdict).toBe("wrong_answer");
    expect(reloaded.failure?.input_preview).toBeDefined();
    expect(reloaded.failure?.expected_preview).toBeDefined();

    expect(await countLearningEvents(submission.id)).toBe(0);
  });

  it("6. timeout: an infinite loop hits time_limit and the submission still reaches completed", async () => {
    const fastDeps = testJudgeDeps({ wallTimeoutMs: 3000 });
    const fastHandler = createJudgeHandler(fastDeps);

    const problem = await seed();
    const submission = await insertTestSubmission({
      versionId: problem.versionId,
      source: "def solve(a, b):\n    while True:\n        pass\n",
      mode: "submit",
    });

    await fastHandler(
      makeJudgeJob({
        submission_id: submission.id,
        mode: "submit",
        language: "python",
        problem_version_id: problem.versionId,
        user_id: TEST_USER_ID,
      }),
      makeCtx(),
    );

    const reloaded = await reloadSubmission(submission.id);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.verdict).toBe("time_limit");
  }, 30_000);

  it("7. compile/syntax error -> compilation_error, excluded from mastery, error category recorded", async () => {
    const problem = await seed();
    const submission = await insertTestSubmission({
      versionId: problem.versionId,
      // Missing colon: a real Python SyntaxError at import time.
      source: "def solve(a, b)\n    return a + b\n",
      mode: "submit",
    });

    const before = await snapshotConceptState();

    await handler(
      makeJudgeJob({
        submission_id: submission.id,
        mode: "submit",
        language: "python",
        problem_version_id: problem.versionId,
        user_id: TEST_USER_ID,
      }),
      makeCtx(),
    );

    const reloaded = await reloadSubmission(submission.id);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.verdict).toBe("compilation_error");

    expect(await countLearningEvents(submission.id)).toBe(0);

    const after = await snapshotConceptState();
    expect(after.error_counts.compilation ?? 0).toBe((before.error_counts.compilation ?? 0) + 1);
    // Excluded from mastery impact -> rating must not have moved.
    expect(after.rating).toBe(before.rating);
  });
});
