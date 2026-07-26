import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadApiConfig } from "@leetmind/shared";
import { buildDeps, type Deps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { cleanup, isDatabaseReachable, seedApprovedProblem, testPool } from "./helpers.js";

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)("hint ladder", () => {
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

  it("rejects a level that skips a rung", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const res = await server.inject({
      method: "POST",
      url: "/api/hints",
      payload: { problem_version_id: seeded.problemVersionId, level: "l3_structural" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("allows ascending l1 -> l2 -> l3 -> outline in order, and each response is idempotent", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    for (const level of ["l1_orientation", "l2_conceptual", "l3_structural", "outline"] as const) {
      const first = await server.inject({
        method: "POST",
        url: "/api/hints",
        payload: { problem_version_id: seeded.problemVersionId, level },
      });
      expect(first.statusCode, `taking ${level} in order should succeed`).toBe(200);
      const firstBody = JSON.parse(first.body);
      expect(firstBody.level).toBe(level);
      expect(typeof firstBody.penalty_cap).toBe("number");

      // Re-taking the same level is idempotent: same response, no error.
      const second = await server.inject({
        method: "POST",
        url: "/api/hints",
        payload: { problem_version_id: seeded.problemVersionId, level },
      });
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.body)).toEqual(firstBody);
    }

    const hintEventCount = await pool.query<{ count: string }>(
      "select count(*)::text as count from hint_events where problem_version_id = $1",
      [seeded.problemVersionId],
    );
    expect(hintEventCount.rows[0]?.count).toBe("4");
  });

  it("rejects taking editorial via POST /api/hints (must use give-up)", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const res = await server.inject({
      method: "POST",
      url: "/api/hints",
      payload: { problem_version_id: seeded.problemVersionId, level: "editorial" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/hints/:versionId reports taken/available/penalties", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    await server.inject({
      method: "POST",
      url: "/api/hints",
      payload: { problem_version_id: seeded.problemVersionId, level: "l1_orientation" },
    });

    const res = await server.inject({ method: "GET", url: `/api/hints/${seeded.problemVersionId}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.taken).toEqual(["l1_orientation"]);
    expect(body.available).toEqual(["l2_conceptual"]);
    expect(body.penalties.l1_orientation).toBe(0.9);
    expect(body.penalties.editorial).toBe(0);
  });

  it("GET /api/hints/:versionId returns the text of taken rungs, and only those", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const before = await server.inject({ method: "GET", url: `/api/hints/${seeded.problemVersionId}` });
    expect(JSON.parse(before.body).texts).toEqual({});

    for (const level of ["l1_orientation", "l2_conceptual"]) {
      await server.inject({
        method: "POST",
        url: "/api/hints",
        payload: { problem_version_id: seeded.problemVersionId, level },
      });
    }

    const res = await server.inject({ method: "GET", url: `/api/hints/${seeded.problemVersionId}` });
    const body = JSON.parse(res.body);
    // The read is enough to redraw the ladder — the client never has to re-POST to get text back.
    expect(Object.keys(body.texts).sort()).toEqual(["l1_orientation", "l2_conceptual"]);
    expect(body.texts.l1_orientation).toBe(seeded.content.hints.l1_orientation);
    expect(body.texts.l2_conceptual).toBe(seeded.content.hints.l2_conceptual);
    // Un-taken rungs stay server-side, and the editorial is never served here at all.
    expect(res.body).not.toContain(seeded.sentinels.l3Text);
    expect(res.body).not.toContain(seeded.sentinels.outlineText);
    expect(res.body).not.toContain(seeded.sentinels.editorialText);
  });
});
