import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { insertSubmission, notify, withTransaction, queryOne, type JobRow } from "@leetmind/db";
import { isId, judgeJobKey, loadApiConfig, newId } from "@leetmind/shared";
import { buildDeps, type Deps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { cleanup, isDatabaseReachable, seedApprovedProblem, testPool } from "./helpers.js";

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)("submissions", () => {
  let deps: Deps;
  let server: FastifyInstance;
  const pool = testPool();
  const problemVersionIds: string[] = [];
  const problemIds: string[] = [];
  const submissionIds: string[] = [];

  beforeAll(async () => {
    deps = buildDeps(loadApiConfig());
    server = buildServer(deps);
  });

  afterEach(async () => {
    await cleanup(pool, {
      problemVersionIds: problemVersionIds.splice(0),
      problemIds: problemIds.splice(0),
      submissionIds: submissionIds.splice(0),
      userId: deps.config.singleUserId,
      conceptIds: ["arrays_hashing"],
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("echoes a caller-supplied x-correlation-id and mints a fresh ULID when absent", async () => {
    const withHeader = await server.inject({
      method: "GET",
      url: "/health",
      headers: { "x-correlation-id": "my-custom-correlation-id" },
    });
    expect(withHeader.headers["x-correlation-id"]).toBe("my-custom-correlation-id");

    const withoutHeader = await server.inject({ method: "GET", url: "/health" });
    const generated = withoutHeader.headers["x-correlation-id"];
    expect(typeof generated).toBe("string");
    expect(isId(generated as string)).toBe(true);
  });

  it("includes the correlation id in error response bodies too", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/submissions/not-a-real-id",
      headers: { "x-correlation-id": "err-corr-id" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.correlation_id).toBe("err-corr-id");
    expect(body.error.code).toBe("bad_request");
  });

  it("POST /api/submissions writes the submission row and enqueues the judge job atomically, sharing one correlation id", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const res = await server.inject({
      method: "POST",
      url: "/api/submissions",
      headers: { "x-correlation-id": "atomic-test-corr" },
      payload: {
        problem_version_id: seeded.problemVersionId,
        language: "python",
        source: "def twoSum(nums, target):\n    return []\n",
        mode: "submit",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("queued");
    submissionIds.push(body.submission_id);

    const submissionRow = await queryOne<{ id: string; correlation_id: string | null }>(
      "select id, correlation_id from submissions where id = $1",
      [body.submission_id],
    );
    expect(submissionRow?.correlation_id).toBe("atomic-test-corr");

    const jobRow = await queryOne<JobRow>(
      "select * from jobs where kind = 'judge' and payload->>'submission_id' = $1",
      [body.submission_id],
    );
    expect(jobRow).not.toBeNull();
    expect(jobRow?.correlation_id).toBe("atomic-test-corr");
    expect(jobRow?.idempotency_key).toBe(judgeJobKey(body.submission_id));
  });

  it("a failure partway through the submission transaction rolls back both the submission row and the job row", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const submissionId = newId();

    await expect(
      withTransaction(async (client) => {
        await insertSubmission(client, {
          id: submissionId,
          user_id: deps.config.singleUserId,
          problem_version_id: seeded.problemVersionId,
          mode: "submit",
          language: "python",
          source: "def twoSum(nums, target):\n    return []\n",
          source_hash: "deadbeef",
          status: "queued",
          correlation_id: "forced-rollback-corr",
        });
        await deps.queue.enqueue(client, {
          kind: "judge",
          payload: { submission_id: submissionId },
          idempotencyKey: judgeJobKey(submissionId),
          correlationId: "forced-rollback-corr",
        });
        await notify(client, {
          type: "status",
          submission_id: submissionId,
          user_id: deps.config.singleUserId,
          status: "queued",
        });
        throw new Error("forced failure after both writes");
      }),
    ).rejects.toThrow("forced failure after both writes");

    const submissionRow = await queryOne("select id from submissions where id = $1", [submissionId]);
    expect(submissionRow).toBeNull();

    const jobRow = await queryOne(
      "select id from jobs where kind = 'judge' and payload->>'submission_id' = $1",
      [submissionId],
    );
    expect(jobRow).toBeNull();
  });

  it("the judge job's idempotency key prevents a second enqueue for the same submission", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const res = await server.inject({
      method: "POST",
      url: "/api/submissions",
      payload: {
        problem_version_id: seeded.problemVersionId,
        language: "python",
        source: "def twoSum(nums, target):\n    return []\n",
        mode: "submit",
      },
    });
    const submissionId = JSON.parse(res.body).submission_id as string;
    submissionIds.push(submissionId);

    // Simulate a duplicate dispatch attempt (e.g. at-least-once retry infra) trying to enqueue a
    // second judge job for the exact same submission.
    const secondEnqueue = await deps.queue.enqueue(pool, {
      kind: "judge",
      payload: { submission_id: submissionId, mode: "submit", language: "python", problem_version_id: seeded.problemVersionId, user_id: deps.config.singleUserId },
      idempotencyKey: judgeJobKey(submissionId),
    });
    expect(secondEnqueue).toBeNull();

    const countRow = await queryOne<{ count: string }>(
      "select count(*)::text as count from jobs where kind = 'judge' and payload->>'submission_id' = $1",
      [submissionId],
    );
    expect(countRow?.count).toBe("1");
  });

  it("mode:'run' is accepted, and no longer takes user-supplied input", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const res = await server.inject({
      method: "POST",
      url: "/api/submissions",
      payload: {
        problem_version_id: seeded.problemVersionId,
        language: "python",
        source: "def twoSum(nums, target):\n    return []\n",
        mode: "run",
      },
    });
    expect(res.statusCode).toBe(201);
    submissionIds.push(JSON.parse(res.body).submission_id);

    // `custom_input` was removed from the request contract: Run means "the public examples", so
    // there is nothing for the caller to supply. An extra key must not be silently honoured.
    const stale = await server.inject({
      method: "POST",
      url: "/api/submissions",
      payload: {
        problem_version_id: seeded.problemVersionId,
        language: "python",
        source: "def twoSum(nums, target):\n    return []\n",
        mode: "run",
        custom_input: { nums: [1, 2, 3], target: 5 },
      },
    });
    expect(stale.statusCode).toBe(201);
    const staleId = JSON.parse(stale.body).submission_id;
    submissionIds.push(staleId);
    const row = await pool.query<{ custom_input: unknown }>("select custom_input from submissions where id = $1", [staleId]);
    expect(row.rows[0]?.custom_input).toBeNull();
  });

  it("rejects sources over the 256KB limit with 400", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const res = await server.inject({
      method: "POST",
      url: "/api/submissions",
      payload: {
        problem_version_id: seeded.problemVersionId,
        language: "python",
        source: "x".repeat(300 * 1024),
        mode: "submit",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects unknown languages with 400", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const res = await server.inject({
      method: "POST",
      url: "/api/submissions",
      payload: {
        problem_version_id: seeded.problemVersionId,
        language: "rust",
        source: "fn main() {}",
        mode: "submit",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown baseline_item_id with 400, not a raw FK-violation 500", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const res = await server.inject({
      method: "POST",
      url: "/api/submissions",
      payload: {
        problem_version_id: seeded.problemVersionId,
        language: "python",
        source: "def solve(): pass",
        mode: "submit",
        baseline_item_id: "not-a-real-baseline-item",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/submissions/:id strips expected_preview/input_preview/actual_preview for mode:'submit' but keeps them for mode:'run'", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const failure = {
      kind: "wrong_answer",
      message: "output did not match",
      first_failing_test_index: 0,
      input_preview: { nums: [1, 2], target: 3 },
      expected_preview: [0, 1],
      actual_preview: [1, 0],
    };

    const submitId = newId();
    await pool.query(
      `insert into submissions (id, user_id, problem_version_id, mode, language, source, source_hash, status, verdict, passed_tests, total_tests, failure, completed_at)
       values ($1, $2, $3, 'submit', 'python', 'src', 'h', 'completed', 'wrong_answer', 0, 1, $4, now())`,
      [submitId, deps.config.singleUserId, seeded.problemVersionId, JSON.stringify(failure)],
    );
    submissionIds.push(submitId);

    const runId = newId();
    await pool.query(
      `insert into submissions (id, user_id, problem_version_id, mode, language, source, source_hash, status, verdict, passed_tests, total_tests, failure, completed_at)
       values ($1, $2, $3, 'run', 'python', 'src', 'h', 'completed', 'wrong_answer', 0, 1, $4, now())`,
      [runId, deps.config.singleUserId, seeded.problemVersionId, JSON.stringify(failure)],
    );
    submissionIds.push(runId);

    const submitRes = await server.inject({ method: "GET", url: `/api/submissions/${submitId}` });
    const submitBody = JSON.parse(submitRes.body);
    expect(submitBody.submission.failure.expected_preview).toBeUndefined();
    expect(submitBody.submission.failure.input_preview).toBeUndefined();
    // CONTRACTS.md §4.5: all three preview fields are populated "only for run mode and for
    // example-derived tests" — actual_preview must be stripped for submit mode too, not just
    // expected/input (confirmed-missing case, QA-PLAN.md §3 "sanitizeFailure misses actual_preview").
    expect(submitBody.submission.failure.actual_preview).toBeUndefined();
    expect(submitBody.submission.failure.kind).toBe("wrong_answer");

    const runRes = await server.inject({ method: "GET", url: `/api/submissions/${runId}` });
    const runBody = JSON.parse(runRes.body);
    expect(runBody.submission.failure.expected_preview).toEqual([0, 1]);
    expect(runBody.submission.failure.input_preview).toEqual({ nums: [1, 2], target: 3 });
    expect(runBody.submission.failure.actual_preview).toEqual([1, 0]);
  });

  it("GET /api/problems/:versionId/submissions/latest hydrates the workspace after a refresh mid-submission", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const nullRes = await server.inject({ method: "GET", url: `/api/problems/${seeded.problemVersionId}/submissions/latest` });
    expect(nullRes.statusCode).toBe(200);
    expect(JSON.parse(nullRes.body).submission).toBeNull();

    const older = newId();
    await pool.query(
      `insert into submissions (id, user_id, problem_version_id, mode, language, source, source_hash, status, created_at)
       values ($1, $2, $3, 'submit', 'python', 'src', 'h', 'running', now() - interval '1 minute')`,
      [older, deps.config.singleUserId, seeded.problemVersionId],
    );
    submissionIds.push(older);

    const newer = newId();
    await pool.query(
      `insert into submissions (id, user_id, problem_version_id, mode, language, source, source_hash, status, created_at)
       values ($1, $2, $3, 'submit', 'python', 'src', 'h', 'running', now())`,
      [newer, deps.config.singleUserId, seeded.problemVersionId],
    );
    submissionIds.push(newer);

    const res = await server.inject({ method: "GET", url: `/api/problems/${seeded.problemVersionId}/submissions/latest` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).submission.id).toBe(newer);
  });
});
