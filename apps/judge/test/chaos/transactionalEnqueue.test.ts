// M4 chaos suite — scenario 6: transactional enqueue under rollback.
//
// packages/queue/src/queue.test.ts already proves this at the queue-only level (test #3: enqueue
// inside begin/rollback -> no job row). This test proves the FULL production shape CONTRACTS.md §9
// mandates for `POST /api/submissions` — "writes the submission row AND enqueues the judge job in
// one transaction" — against a REAL domain write (a `submissions` row, with its FK to a real
// `problem_versions` row), not just a bare payload. A rollback of that combined write must leave
// NEITHER row behind.
import { describe, expect, it, afterEach } from "vitest";
import { query, withTransaction, insertSubmission } from "@leetmind/db";
import { newId } from "@leetmind/shared";
import {
  isDatabaseReachable,
  seedApprovedProblem,
  teardownProblem,
  testQueue,
  TEST_USER_ID,
  type SeededProblem,
} from "./chaos-helpers.js";

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)("chaos 6: transactional enqueue under rollback", () => {
  const queue = testQueue({ workerId: "txn-test" });
  const problemsToTeardown: SeededProblem[] = [];

  afterEach(async () => {
    let problem: SeededProblem | undefined;
    while ((problem = problemsToTeardown.pop())) {
      await teardownProblem(problem);
    }
  });

  it("submission insert + judge enqueue, rolled back together, leaves neither row", async () => {
    const problem = await seedApprovedProblem();
    problemsToTeardown.push(problem);

    const submissionId = newId();
    const idempotencyKey = `judge:${submissionId}`;

    await expect(
      withTransaction(async (client) => {
        await insertSubmission(client, {
          id: submissionId,
          user_id: TEST_USER_ID,
          problem_version_id: problem.versionId,
          mode: "submit",
          language: "python",
          source: "def solve(a, b):\n    return a + b\n",
          source_hash: "chaos-rollback-fixture",
          status: "queued",
        });

        const job = await queue.enqueue(client, {
          kind: "judge",
          payload: {
            submission_id: submissionId,
            mode: "submit",
            language: "python",
            problem_version_id: problem.versionId,
            user_id: TEST_USER_ID,
          },
          idempotencyKey,
        });
        expect(job).not.toBeNull();

        // Force the rollback (withTransaction rolls back on any thrown error).
        throw new Error("deliberate rollback: domain write should never partially commit");
      }),
    ).rejects.toThrow("deliberate rollback");

    const submissionRows = await query("select id from submissions where id = $1", [submissionId]);
    expect(submissionRows, "submission row must not exist after rollback").toHaveLength(0);

    const jobRows = await query("select id from jobs where idempotency_key = $1", [idempotencyKey]);
    expect(jobRows, "job row must not exist after rollback").toHaveLength(0);
  });

  it("control case: the same combined write, committed, leaves BOTH rows (proves the rollback test isn't vacuous)", async () => {
    const problem = await seedApprovedProblem();
    problemsToTeardown.push(problem);

    const submissionId = newId();
    const idempotencyKey = `judge:${submissionId}`;

    await withTransaction(async (client) => {
      await insertSubmission(client, {
        id: submissionId,
        user_id: TEST_USER_ID,
        problem_version_id: problem.versionId,
        mode: "submit",
        language: "python",
        source: "def solve(a, b):\n    return a + b\n",
        source_hash: "chaos-commit-fixture",
        status: "queued",
      });
      const job = await queue.enqueue(client, {
        kind: "judge",
        payload: {
          submission_id: submissionId,
          mode: "submit",
          language: "python",
          problem_version_id: problem.versionId,
          user_id: TEST_USER_ID,
        },
        idempotencyKey,
      });
      expect(job).not.toBeNull();
    });

    const submissionRows = await query("select id from submissions where id = $1", [submissionId]);
    expect(submissionRows).toHaveLength(1);
    const jobRows = await query<{ id: string }>("select id from jobs where idempotency_key = $1", [
      idempotencyKey,
    ]);
    expect(jobRows).toHaveLength(1);

    // Clean up this one's own rows (this test's own submission + job, per §13 rule 3).
    await query("delete from submissions where id = $1", [submissionId]);
    await query("delete from jobs where id = $1", [jobRows[0]!.id]);
  });
});
