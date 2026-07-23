import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadApiConfig } from "@algolift/shared";
import { buildDeps, type Deps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { cleanup, isDatabaseReachable, seedApprovedProblem, testPool } from "./helpers.js";

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)("GET /api/problems/next", () => {
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
      conceptIds: ["arrays_hashing", "shortest_paths"],
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns 200 with problem: null (not 500) when the pool is empty for a concept", async () => {
    const res = await server.inject({ method: "GET", url: "/api/problems/next?concept=shortest_paths" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.problem).toBeNull();
    expect(typeof body.rationale).toBe("string");
    expect(body.rationale.length).toBeGreaterThan(0);
  });

  it("selects an approved unattempted problem near the target band and explains why", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing", difficultyRating: 1150 });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const res = await server.inject({ method: "GET", url: "/api/problems/next?concept=arrays_hashing&rating=1200" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.problem).not.toBeNull();
    expect(body.problem.problem_version_id).toBe(seeded.problemVersionId);
    expect(body.problem.concepts_revealed).toBeNull();
    expect(typeof body.rationale).toBe("string");
    expect(body.evidence).toBeDefined();
  });
});
