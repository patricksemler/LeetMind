// C++ judge integration — CONTRACTS §7's C++ pipeline wired through apps/judge/src/{execution,
// handler,rejudge}.ts. Mirrors test/handler.test.ts's Python cases but for `language: 'cpp'`
// submissions, using ./cppHelpers.ts (NOT ./helpers.ts, which the concurrent chaos-suite agent
// owns — see that file's header) for the one piece Python's helpers can't build: a
// `language: 'cpp'` submission row.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { query, type UserConceptStateRow } from "@leetmind/db";
import { createJudgeHandler } from "../src/handler.js";
import { rejudgeSubmission } from "../src/rejudge.js";
import {
  countExecutionAttempts,
  countLearningEvents,
  isDatabaseReachable,
  isDockerReachable,
  makeCtx,
  makeLeasedJudgeJob,
  reloadSubmission,
  restoreConceptState,
  seedApprovedProblem,
  snapshotConceptState,
  teardownProblem,
  TEST_USER_ID,
  testJudgeDeps,
  type SeededProblem,
} from "./helpers.js";
import { insertCppSubmission } from "./cppHelpers.js";

const dbReachable = await isDatabaseReachable();
const dockerReachable = dbReachable ? await isDockerReachable() : false;
const canRun = dbReachable && dockerReachable;

const CORRECT_CPP = "class Solution {\npublic:\n    long long solve(long long a, long long b) { return a + b; }\n};\n";
const WRONG_CPP = "class Solution {\npublic:\n    long long solve(long long a, long long b) { return a - b; }\n};\n";
const SYNTAX_ERROR_CPP = "class Solution {\npublic:\n    long long solve(long long a, long long b) { return this_is_not_defined; }\n};\n";

describe.skipIf(!canRun)("C++ judge integration (live Postgres + Docker)", () => {
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

  it("1. happy path: correct C++ solution -> accepted + one learning event + rating up, with compile info recorded", async () => {
    const problem = await seed();
    const submission = await insertCppSubmission({
      versionId: problem.versionId,
      source: CORRECT_CPP,
      mode: "submit",
      activeMs: 3 * 60_000,
    });

    const before = await snapshotConceptState();

    await handler(
      await makeLeasedJudgeJob(deps, {
        submission_id: submission.id,
        mode: "submit",
        language: "cpp",
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
    const attemptRows = await query<{
      image_digest: string | null;
      language_version: string | null;
      flags: string | null;
      usage: Record<string, unknown> | null;
    }>("select image_digest, language_version, flags, usage from execution_attempts where submission_id = $1", [submission.id]);
    expect(attemptRows[0]?.image_digest).toBeTruthy();
    expect(attemptRows[0]?.language_version).toBe("g++14");
    expect(attemptRows[0]?.flags).toContain("-std=c++20");
    expect(attemptRows[0]?.usage?.compile_ok).toBe(true);
    expect(typeof attemptRows[0]?.usage?.compile_duration_ms).toBe("number");

    expect(await countLearningEvents(submission.id)).toBe(1);

    const after = await snapshotConceptState();
    expect(after.rating).toBeGreaterThan(before.rating);
  }, 60_000);

  it("2. wrong answer: C++ solution -> wrong_answer, rating moves down, no hidden expected leaked", async () => {
    // Not the default hidden_tests fixture: its first test is origin:"example", which (correctly,
    // per CONTRACTS §4.5 — see handler.test.ts's tests 2/2b) reveals its own preview even in
    // submit mode. This test is specifically about a GENUINELY hidden test never leaking.
    const problem = await seed({
      hiddenTests: [
        { args: [1, 2], expected: 3, origin: "boundary" },
        { args: [10, -3], expected: 7, origin: "random" },
        { args: [0, 0], expected: 0, origin: "adversarial" },
      ],
    });
    const submission = await insertCppSubmission({
      versionId: problem.versionId,
      source: WRONG_CPP,
      mode: "submit",
    });

    const before = await snapshotConceptState();

    await handler(
      await makeLeasedJudgeJob(deps, {
        submission_id: submission.id,
        mode: "submit",
        language: "cpp",
        problem_version_id: problem.versionId,
        user_id: TEST_USER_ID,
      }),
      makeCtx(),
    );

    const reloaded = await reloadSubmission(submission.id);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.verdict).toBe("wrong_answer");
    expect(reloaded.failure?.expected_preview).toBeUndefined();
    expect(reloaded.failure?.input_preview).toBeUndefined();

    const after = await snapshotConceptState();
    expect(after.rating).toBeLessThan(before.rating);
  }, 60_000);

  it("3. compile error: a real g++ syntax error -> compilation_error, excluded from mastery, readable path-scrubbed diagnostics", async () => {
    const problem = await seed();
    const submission = await insertCppSubmission({
      versionId: problem.versionId,
      source: SYNTAX_ERROR_CPP,
      mode: "submit",
    });

    const before = await snapshotConceptState();

    await handler(
      await makeLeasedJudgeJob(deps, {
        submission_id: submission.id,
        mode: "submit",
        language: "cpp",
        problem_version_id: problem.versionId,
        user_id: TEST_USER_ID,
      }),
      makeCtx(),
    );

    const reloaded = await reloadSubmission(submission.id);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.verdict).toBe("compilation_error");
    expect(reloaded.failure?.stderr_tail).toContain("this_is_not_defined");
    expect(reloaded.failure?.stderr_tail).not.toContain("/bundle/");
    expect(reloaded.failure?.stderr_tail).not.toContain("/work/");

    expect(await countLearningEvents(submission.id)).toBe(0);

    const after = await snapshotConceptState();
    expect(after.error_counts.compilation ?? 0).toBe((before.error_counts.compilation ?? 0) + 1);
    expect(after.rating).toBe(before.rating);
  }, 60_000);

  it("4. run mode with custom_input: no expected value, no learning event, verdict accepted iff it ran cleanly", async () => {
    const problem = await seed();
    const submission = await insertCppSubmission({
      versionId: problem.versionId,
      source: CORRECT_CPP,
      mode: "run",
      customInput: { args: [10, 5] },
    });

    await handler(
      await makeLeasedJudgeJob(deps, {
        submission_id: submission.id,
        mode: "run",
        language: "cpp",
        problem_version_id: problem.versionId,
        user_id: TEST_USER_ID,
      }),
      makeCtx(),
    );

    const reloaded = await reloadSubmission(submission.id);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.verdict).toBe("accepted");
    expect(reloaded.passed_tests).toBe(0);
    expect(reloaded.total_tests).toBe(0);
    expect(await countLearningEvents(submission.id)).toBe(0);
  }, 60_000);

  it("5. rejudge: a historical C++ submission reproduces its verdict without re-applying mastery", async () => {
    const problem = await seed();
    const submission = await insertCppSubmission({
      versionId: problem.versionId,
      source: CORRECT_CPP,
      mode: "submit",
    });

    await handler(
      await makeLeasedJudgeJob(deps, {
        submission_id: submission.id,
        mode: "submit",
        language: "cpp",
        problem_version_id: problem.versionId,
        user_id: TEST_USER_ID,
      }),
      makeCtx(),
    );

    const afterJudge = await reloadSubmission(submission.id);
    expect(afterJudge.verdict).toBe("accepted");
    expect(await countExecutionAttempts(submission.id)).toBe(1);
    expect(await countLearningEvents(submission.id)).toBe(1);
    const conceptAfterJudge = await snapshotConceptState();

    const rejudgeResult = await rejudgeSubmission(submission.id, deps);

    expect(rejudgeResult.matched).toBe(true);
    expect(rejudgeResult.newVerdict).toBe("accepted");
    expect(rejudgeResult.originalVerdict).toBe("accepted");

    // A new execution_attempts row was recorded (attempt 2), but nothing about the STORED
    // submission or mastery changed — a rejudge is a reproducibility check, not a re-judgment.
    expect(await countExecutionAttempts(submission.id)).toBe(2);
    expect(await countLearningEvents(submission.id)).toBe(1);
    const conceptAfterRejudge = await snapshotConceptState();
    expect(conceptAfterRejudge.rating).toBe(conceptAfterJudge.rating);

    const attemptRows = await query<{ attempt: number; language_version: string | null; flags: string | null }>(
      "select attempt, language_version, flags from execution_attempts where submission_id = $1 order by attempt asc",
      [submission.id],
    );
    expect(attemptRows.map((r) => r.attempt)).toEqual([1, 2]);
    expect(attemptRows[1]?.language_version).toBe("g++14");
    expect(attemptRows[1]?.flags).toContain("-std=c++20");
  }, 90_000);
});
