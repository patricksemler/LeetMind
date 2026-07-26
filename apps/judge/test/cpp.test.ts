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
/** Special-cases the public example and is wrong everywhere else — the exact behaviour hidden
 * tests exist to catch. C++ counterpart of handler.test.ts test 2a's Python source. */
const HARDCODED_CPP =
  "class Solution {\npublic:\n    long long solve(long long a, long long b) {\n        if (a == 1 && b == 2) return 3;\n        return a - b;\n    }\n};\n";

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

  it("2. wrong answer on the PUBLIC example: previews shown, and no mastery consequence at all", async () => {
    // Submit runs the public examples first, so a uniformly-wrong solution breaks on example #1 —
    // whose values are on the problem page anyway. What must never appear is a genuinely hidden
    // test's expected value; see test 2a below for that case.
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
    // The failure is on the public example, so its (already-visible) values are shown, and the
    // split confirms which half of the suite broke.
    expect(reloaded.failure?.first_failing_test_index).toBe(0);
    expect(reloaded.failure?.tests).toMatchObject({ public_passed: 0, public_total: 1 });
    expect(reloaded.failure?.expected_preview).toBe(3);

    // …and because the case that broke is one the statement prints and `Run` executes for free,
    // this attempt carries no mastery consequence at all — the same exemption compile-only
    // failures get (CONTRACTS §8, and the `!failedPublicCase(failure)` gate in src/handler.ts).
    // This assertion previously read `after.rating < before.rating`, which was correct before
    // that gate existed and has been wrong since.
    expect(await countLearningEvents(submission.id)).toBe(0);
    const after = await snapshotConceptState();
    expect(after.rating).toBe(before.rating);
  }, 60_000);

  it("2a. wrong answer on a HIDDEN case: rating moves down, and only that case is disclosed", async () => {
    // The other side of test 2's rule, and the case that actually exercises the C++ path's mastery
    // consequence: every public example passed, so nothing on the page warned the user this was
    // coming, and it scores like any other attempt. C++ mirror of handler.test.ts test 2a.
    const SECRET_EXPECTED = 918273645;
    const OTHER_SECRET_EXPECTED = 111222333;
    const problem = await seed({
      hiddenTests: [
        { args: [500000, 500000], expected: SECRET_EXPECTED, origin: "random" },
        { args: [777, 777], expected: OTHER_SECRET_EXPECTED, origin: "adversarial" },
      ],
    });
    const submission = await insertCppSubmission({
      versionId: problem.versionId,
      source: HARDCODED_CPP,
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

    // Every public example passed; the failure is in the hidden suite.
    expect(reloaded.failure?.tests).toMatchObject({ public_passed: 1, public_total: 1 });
    expect(reloaded.failure!.first_failing_test_index!).toBeGreaterThanOrEqual(1);

    // The legacy `*_preview` fields stay empty for a hidden failure — unbounded, never brought
    // back (see `sanitizeFailure` in apps/api).
    expect(reloaded.failure?.expected_preview).toBeUndefined();
    expect(reloaded.failure?.input_preview).toBeUndefined();
    expect(reloaded.failure?.actual_preview).toBeUndefined();

    // `failing_test` DOES disclose the one case that broke — and only that one, so a single
    // submission can never enumerate the hidden suite.
    expect(reloaded.failure?.failing_test).toMatchObject({
      origin: "hidden",
      args: [500000, 500000],
      expected: SECRET_EXPECTED,
    });
    expect(JSON.stringify(reloaded.failure ?? {})).not.toContain(String(OTHER_SECRET_EXPECTED));

    expect(await countLearningEvents(submission.id)).toBe(1);
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

  it("4. run mode grades the public examples and writes no learning event (C++)", async () => {
    const problem = await seed();
    const submission = await insertCppSubmission({
      versionId: problem.versionId,
      source: CORRECT_CPP,
      mode: "run",
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
    // A run is graded now — against the public examples — so it reports a real count rather than
    // the 0/0 the old custom-input mode produced. It still writes no learning event.
    expect(reloaded.total_tests).toBeGreaterThan(0);
    expect(reloaded.passed_tests).toBe(reloaded.total_tests);
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
