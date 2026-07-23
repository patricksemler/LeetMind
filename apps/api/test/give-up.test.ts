import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadApiConfig } from "@algolift/shared";
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

  beforeAll(async () => {
    deps = buildDeps(loadApiConfig());
    server = buildServer(deps);
  });

  afterEach(async () => {
    await cleanup(pool, {
      problemVersionIds: problemVersionIds.splice(0),
      problemIds: problemIds.splice(0),
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
});
