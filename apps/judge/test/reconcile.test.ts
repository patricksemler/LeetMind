import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { query } from "@leetmind/db";
import { reconcileStrandedSubmissions } from "../src/reconcile.js";
import {
  insertTestSubmission,
  isDatabaseReachable,
  reloadSubmission,
  seedApprovedProblem,
  teardownProblem,
  TEST_USER_ID,
  testJudgeDeps,
  type SeededProblem,
} from "./helpers.js";

const dbReachable = await isDatabaseReachable();

// Regression tests for QA-PLAN.md §2.3: a judge job that exhausts its retries (or whose worker
// died outright, reaped by @leetmind/queue's reaper) leaves `jobs.status='dead'` but never wrote
// a terminal state for the submission it was judging — confirmed live, the user sees "running…"
// forever with no recovery.
describe.skipIf(!dbReachable)("reconcileStrandedSubmissions (integration: live Postgres)", () => {
  const deps = testJudgeDeps();
  const problemsToTeardown: SeededProblem[] = [];
  const jobIdsToDelete: string[] = [];

  beforeAll(async () => {
    // no-op: deps is built once
  });

  afterEach(async () => {
    if (jobIdsToDelete.length > 0) {
      await query("delete from jobs where id = any($1)", [jobIdsToDelete.splice(0)]);
    }
    let problem: SeededProblem | undefined;
    while ((problem = problemsToTeardown.pop())) {
      await teardownProblem(problem);
    }
  });

  async function seed(): Promise<SeededProblem> {
    const problem = await seedApprovedProblem();
    problemsToTeardown.push(problem);
    return problem;
  }

  async function insertDeadJudgeJob(submissionId: string): Promise<string> {
    const jobId = `job_${submissionId}`;
    await query(
      `insert into jobs (id, kind, payload, status, attempts, max_attempts)
       values ($1, 'judge', $2::jsonb, 'dead', 3, 3)`,
      [jobId, JSON.stringify({ submission_id: submissionId, mode: "submit", language: "python", problem_version_id: "irrelevant", user_id: TEST_USER_ID })],
    );
    jobIdsToDelete.push(jobId);
    return jobId;
  }

  it("completes a stranded non-terminal submission with internal_error once its judge job is dead", async () => {
    const problem = await seed();
    const submission = await insertTestSubmission({ versionId: problem.versionId, source: "irrelevant", mode: "submit", status: "running" });
    await insertDeadJudgeJob(submission.id);

    const count = await reconcileStrandedSubmissions(deps);
    expect(count).toBe(1);

    const reloaded = await reloadSubmission(submission.id);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.verdict).toBe("internal_error");
    expect(reloaded.failure?.kind).toBe("internal_error");
  });

  it("is idempotent — a second sweep finds nothing left to reconcile", async () => {
    const problem = await seed();
    const submission = await insertTestSubmission({ versionId: problem.versionId, source: "irrelevant", mode: "submit", status: "assigned" });
    await insertDeadJudgeJob(submission.id);

    await reconcileStrandedSubmissions(deps);
    const secondPass = await reconcileStrandedSubmissions(deps);
    expect(secondPass).toBe(0);
  });

  it("leaves an already-terminal submission alone even if its job is dead (duplicate-delivery safe)", async () => {
    const problem = await seed();
    const submission = await insertTestSubmission({ versionId: problem.versionId, source: "irrelevant", mode: "submit", status: "completed" });
    await query("update submissions set verdict = 'accepted', passed_tests = 3, total_tests = 3 where id = $1", [submission.id]);
    await insertDeadJudgeJob(submission.id);

    const count = await reconcileStrandedSubmissions(deps);
    expect(count).toBe(0);

    const reloaded = await reloadSubmission(submission.id);
    expect(reloaded.verdict).toBe("accepted");
  });
});
