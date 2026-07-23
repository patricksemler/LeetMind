// `reveal` (docs/CONTRACTS.md §4.5): present only once the user has an accepted submission for
// that problem version, or has given up. Absent on every other GET /api/submissions/:id call.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadApiConfig, newId } from "@algolift/shared";
import { buildDeps, type Deps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { cleanup, isDatabaseReachable, seedApprovedProblem, testPool } from "./helpers.js";

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)("post-solve reveal", () => {
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

  it("is absent before any accepted submission or give-up exists", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const submissionId = newId();
    await pool.query(
      `insert into submissions (id, user_id, problem_version_id, mode, language, source, source_hash, status, verdict, passed_tests, total_tests, completed_at)
       values ($1, $2, $3, 'submit', 'python', 'def twoSum(nums, target):\n    return []\n', 'x', 'completed', 'wrong_answer', 0, 1, now())`,
      [submissionId, deps.config.singleUserId, seeded.problemVersionId],
    );
    submissionIds.push(submissionId);

    const res = await server.inject({ method: "GET", url: `/api/submissions/${submissionId}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).submission.reveal).toBeUndefined();
  });

  it("appears on GET /api/submissions/:id once that submission is itself accepted", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const submissionId = newId();
    await pool.query(
      `insert into submissions (id, user_id, problem_version_id, mode, language, source, source_hash, status, verdict, passed_tests, total_tests, completed_at)
       values ($1, $2, $3, 'submit', 'python', 'def twoSum(nums, target):\n    return []\n', 'x', 'completed', 'accepted', 1, 1, now())`,
      [submissionId, deps.config.singleUserId, seeded.problemVersionId],
    );
    submissionIds.push(submissionId);

    const res = await server.inject({ method: "GET", url: `/api/submissions/${submissionId}` });
    expect(res.statusCode).toBe(200);
    const reveal = JSON.parse(res.body).submission.reveal;
    expect(reveal).toBeDefined();
    expect(reveal.editorial_md).toContain(seeded.sentinels.editorialText);
    expect(reveal.target_complexity).toEqual(seeded.content.target_complexity);
    expect(reveal.concepts[0].id).toBe("arrays_hashing");
    expect(reveal.concepts[0].name).toBe("Arrays & Hashing");
  });

  it("appears retroactively on an EARLIER wrong_answer submission for the same version, once a later one is accepted", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const wrongId = newId();
    await pool.query(
      `insert into submissions (id, user_id, problem_version_id, mode, language, source, source_hash, status, verdict, passed_tests, total_tests, completed_at)
       values ($1, $2, $3, 'submit', 'python', 'bad', 'x', 'completed', 'wrong_answer', 0, 1, now())`,
      [wrongId, deps.config.singleUserId, seeded.problemVersionId],
    );
    submissionIds.push(wrongId);

    const before = await server.inject({ method: "GET", url: `/api/submissions/${wrongId}` });
    expect(JSON.parse(before.body).submission.reveal).toBeUndefined();

    const acceptedId = newId();
    await pool.query(
      `insert into submissions (id, user_id, problem_version_id, mode, language, source, source_hash, status, verdict, passed_tests, total_tests, completed_at)
       values ($1, $2, $3, 'submit', 'python', 'good', 'y', 'completed', 'accepted', 1, 1, now())`,
      [acceptedId, deps.config.singleUserId, seeded.problemVersionId],
    );
    submissionIds.push(acceptedId);

    const after = await server.inject({ method: "GET", url: `/api/submissions/${wrongId}` });
    expect(after.statusCode).toBe(200);
    expect(JSON.parse(after.body).submission.reveal).toBeDefined();
  });

  it("appears after a give-up, even with no accepted submission at all", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const submissionId = newId();
    await pool.query(
      `insert into submissions (id, user_id, problem_version_id, mode, language, source, source_hash, status, verdict, passed_tests, total_tests, completed_at)
       values ($1, $2, $3, 'submit', 'python', 'bad', 'x', 'completed', 'wrong_answer', 0, 1, now())`,
      [submissionId, deps.config.singleUserId, seeded.problemVersionId],
    );
    submissionIds.push(submissionId);

    await server.inject({ method: "POST", url: `/api/problems/${seeded.problemVersionId}/give-up`, payload: {} });

    const res = await server.inject({ method: "GET", url: `/api/submissions/${submissionId}` });
    expect(JSON.parse(res.body).submission.reveal).toBeDefined();
  });

  it("appears on the SSE catch-up verdict event for an already-terminal accepted submission", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const submissionId = newId();
    await pool.query(
      `insert into submissions (id, user_id, problem_version_id, mode, language, source, source_hash, status, verdict, passed_tests, total_tests, completed_at)
       values ($1, $2, $3, 'submit', 'python', 'good', 'x', 'completed', 'accepted', 1, 1, now())`,
      [submissionId, deps.config.singleUserId, seeded.problemVersionId],
    );
    submissionIds.push(submissionId);

    const res = await server.inject({ method: "GET", url: `/api/submissions/${submissionId}/events` });
    expect(res.statusCode).toBe(200);
    const verdictLine = res.body.split("\n\n").find((block) => block.includes("event: verdict"));
    expect(verdictLine).toBeDefined();
    const dataLine = verdictLine!.split("\n").find((l) => l.startsWith("data: "))!;
    const data = JSON.parse(dataLine.slice("data: ".length));
    expect(data.reveal).toBeDefined();
    expect(data.reveal.editorial_md).toContain(seeded.sentinels.editorialText);
  });
});
