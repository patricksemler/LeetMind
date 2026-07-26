import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadApiConfig } from "@leetmind/shared";
import { insertSubmission, insertBaselineSession, insertBaselineItem, withTransaction } from "@leetmind/db";
import { buildDeps, type Deps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { cleanup, isDatabaseReachable, seedApprovedProblem, testPool } from "./helpers.js";

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)("give-up idempotency", () => {
  let deps: Deps;
  let server: FastifyInstance;
  const pool = testPool();
  const problemVersionIds: string[] = [];
  const problemIds: string[] = [];
  const baselineSessionIds: string[] = [];
  const submissionIds: string[] = [];

  beforeAll(async () => {
    deps = buildDeps(loadApiConfig());
    server = buildServer(deps);
  });

  afterEach(async () => {
    await cleanup(pool, {
      problemVersionIds: problemVersionIds.splice(0),
      problemIds: problemIds.splice(0),
      baselineSessionIds: baselineSessionIds.splice(0),
      submissionIds: submissionIds.splice(0),
      userId: deps.config.singleUserId,
      conceptIds: ["arrays_hashing"],
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("applies the mastery hit exactly once across two give-up calls, and returns the same result both times", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing", difficultyRating: 1200 });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const first = await server.inject({
      method: "POST",
      url: `/api/problems/${seeded.problemVersionId}/give-up`,
      payload: { active_ms: 60_000 },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body);
    expect(firstBody.editorial_md).toContain(seeded.sentinels.editorialText);
    expect(firstBody.mastery_change.outcome).toBe(0);
    expect(firstBody.mastery_change.changes.length).toBeGreaterThan(0);

    const second = await server.inject({
      method: "POST",
      url: `/api/problems/${seeded.problemVersionId}/give-up`,
      payload: { active_ms: 60_000 },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = JSON.parse(second.body);
    expect(secondBody.mastery_change).toEqual(firstBody.mastery_change);

    const eventCount = await pool.query<{ count: string }>(
      "select count(*)::text as count from learning_events where problem_version_id = $1 and kind = 'give_up'",
      [seeded.problemVersionId],
    );
    expect(eventCount.rows[0]?.count).toBe("1");

    const stateRow = await pool.query<{ attempts: number }>(
      "select attempts from user_concept_state where user_id = $1 and concept_id = 'arrays_hashing'",
      [deps.config.singleUserId],
    );
    // Exactly one mastery-affecting attempt increment, not two.
    expect(stateRow.rows[0]?.attempts).toBe(1);
  });

  it("reveals concepts_revealed on the problem after giving up", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const before = await server.inject({ method: "GET", url: `/api/problems/${seeded.problemVersionId}` });
    expect(JSON.parse(before.body).problem.concepts_revealed).toBeNull();

    await server.inject({ method: "POST", url: `/api/problems/${seeded.problemVersionId}/give-up`, payload: {} });

    const after = await server.inject({ method: "GET", url: `/api/problems/${seeded.problemVersionId}` });
    const revealed = JSON.parse(after.body).problem.concepts_revealed;
    expect(revealed).not.toBeNull();
    expect(revealed[0].id).toBe("arrays_hashing");
    expect(revealed[0].name).toBe("Arrays & Hashing");
  });

  it("completes the baseline item as gave_up when baseline_item_id is provided — previously parsed and ignored entirely", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const item = await withTransaction(async (client) => {
      const session = await insertBaselineSession(client, { id: `bs_${seeded.problemVersionId}`, user_id: deps.config.singleUserId });
      baselineSessionIds.push(session.id);
      return insertBaselineItem(client, {
        id: `bi_${seeded.problemVersionId}`,
        baseline_session_id: session.id,
        position: 0,
        problem_version_id: seeded.problemVersionId,
      });
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/problems/${seeded.problemVersionId}/give-up`,
      payload: { baseline_item_id: item.id, active_ms: 30_000 },
    });
    expect(res.statusCode).toBe(200);

    const row = await pool.query<{ state: string; completed_at: Date | null }>(
      "select state, completed_at from baseline_items where id = $1",
      [item.id],
    );
    expect(row.rows[0]?.state).toBe("gave_up");
    expect(row.rows[0]?.completed_at).not.toBeNull();
  });

  it("rejects give-up with 409 while a judge job is still in flight for this problem version", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const submission = await withTransaction((client) =>
      insertSubmission(client, {
        id: `sub_${seeded.problemVersionId}`,
        user_id: deps.config.singleUserId,
        problem_version_id: seeded.problemVersionId,
        mode: "submit",
        language: "python",
        source: "def twoSum(nums, target):\n    return []\n",
        source_hash: "irrelevant",
        status: "running",
      }),
    );
    submissionIds.push(submission.id);

    const res = await server.inject({
      method: "POST",
      url: `/api/problems/${seeded.problemVersionId}/give-up`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);

    const events = await pool.query<{ count: string }>(
      "select count(*)::text as count from learning_events where problem_version_id = $1 and kind = 'give_up'",
      [seeded.problemVersionId],
    );
    expect(events.rows[0]?.count).toBe("0");
  });

  it("rejects give-up with 409 once the problem is already solved — the UI disables the control, but a stale client can still post", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const submission = await withTransaction((client) =>
      insertSubmission(client, {
        id: `sub_${seeded.problemVersionId}`,
        user_id: deps.config.singleUserId,
        problem_version_id: seeded.problemVersionId,
        mode: "submit",
        language: "python",
        source: "def twoSum(nums, target):\n    return []\n",
        source_hash: "irrelevant",
        status: "completed",
      }),
    );
    submissionIds.push(submission.id);
    await pool.query("update submissions set verdict = 'accepted', completed_at = now() where id = $1", [submission.id]);

    const res = await server.inject({
      method: "POST",
      url: `/api/problems/${seeded.problemVersionId}/give-up`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);

    const events = await pool.query<{ count: string }>(
      "select count(*)::text as count from learning_events where problem_version_id = $1 and kind = 'give_up'",
      [seeded.problemVersionId],
    );
    expect(events.rows[0]?.count).toBe("0");
  });

  it("labels only submissions created AFTER the give-up as practice — a give-up must not retroactively relabel earlier scored attempts", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);
    const userId = deps.config.singleUserId;

    // A scored wrong-answer attempt, completed before any give-up.
    const before = await withTransaction((client) =>
      insertSubmission(client, {
        id: `subA${seeded.problemVersionId.slice(4)}`,
        user_id: userId,
        problem_version_id: seeded.problemVersionId,
        mode: "submit",
        language: "python",
        source: "def twoSum(nums, target):\n    return []\n",
        source_hash: "irrelevant",
        status: "completed",
      }),
    );
    submissionIds.push(before.id);
    await pool.query("update submissions set verdict = 'wrong_answer', completed_at = now() where id = $1", [before.id]);

    const giveUp = await server.inject({
      method: "POST",
      url: `/api/problems/${seeded.problemVersionId}/give-up`,
      payload: {},
    });
    expect(giveUp.statusCode).toBe(200);

    // The pre-give-up submission stays a scored attempt.
    const latestBefore = await server.inject({
      method: "GET",
      url: `/api/problems/${seeded.problemVersionId}/submissions/latest`,
    });
    expect(latestBefore.statusCode).toBe(200);
    expect(JSON.parse(latestBefore.body).submission.practice).toBeUndefined();

    // A post-give-up attempt is practice.
    const after = await withTransaction((client) =>
      insertSubmission(client, {
        id: `subB${seeded.problemVersionId.slice(4)}`,
        user_id: userId,
        problem_version_id: seeded.problemVersionId,
        mode: "submit",
        language: "python",
        source: "def twoSum(nums, target):\n    return []\n",
        source_hash: "irrelevant",
        status: "completed",
      }),
    );
    submissionIds.push(after.id);
    await pool.query("update submissions set verdict = 'wrong_answer', completed_at = now() where id = $1", [after.id]);

    const latestAfter = await server.inject({
      method: "GET",
      url: `/api/problems/${seeded.problemVersionId}/submissions/latest`,
    });
    expect(latestAfter.statusCode).toBe(200);
    expect(JSON.parse(latestAfter.body).submission.practice).toBe(true);
  });
});
