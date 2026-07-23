import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadApiConfig, ProgressResponse, SystemStatsResponse } from "@algolift/shared";
import { buildDeps, type Deps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { isDatabaseReachable } from "./helpers.js";

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)("basic routes", () => {
  let deps: Deps;
  let server: FastifyInstance;

  beforeAll(async () => {
    deps = buildDeps(loadApiConfig());
    server = buildServer(deps);
  });

  afterAll(async () => {
    await server.close();
  });

  it("GET /health reports db: up", async () => {
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.db).toBe("up");
    expect(typeof body.version).toBe("string");
  });

  it("GET /api/concepts returns the seeded taxonomy", async () => {
    const res = await server.inject({ method: "GET", url: "/api/concepts" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.concepts.length).toBe(20);
    expect(body.edges.length).toBe(20);
    expect(body.concepts.some((c: { id: string }) => c.id === "arrays_hashing")).toBe(true);
  });

  it("unknown routes 404 with the standard error envelope", async () => {
    const res = await server.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("not_found");
    expect(typeof body.correlation_id).toBe("string");
  });

  it("POST /api/workout-items/:id/start 404s for an unknown item id rather than 501 (M3 implemented)", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/workout-items/01ARZ3NDEKTSV4RRFFQ69G5FAV/start",
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /api/workout-items/:id/skip 404s for an unknown item id rather than 501 (M3 implemented)", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/workout-items/01ARZ3NDEKTSV4RRFFQ69G5FAV/skip",
      payload: { reason: "preference" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/system/stats returns queue/worker/verdict/buffer/pass-rate/model-run panels plus learner constants, and parses against SystemStatsResponse", async () => {
    const res = await server.inject({ method: "GET", url: "/api/system/stats" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.queue).toBeDefined();
    expect(Array.isArray(body.workers)).toBe(true);
    expect(body.learner_constants.K_MIN).toBe(16);
    expect(body.learner_constants.K_MAX).toBe(48);
    // "Prevent recurrence" (QA-PLAN.md): the REAL API's response parsed through the exact same
    // shared schema the web app parses it through and the mock server's own test asserts against
    // (apps/web/mock/server.test.ts) — this is what would have caught §1.5's mock/real drift.
    expect(() => SystemStatsResponse.parse(body)).not.toThrow();
  });

  it("GET /api/progress returns concepts/reviews_due/stats/records/history, and parses against ProgressResponse", async () => {
    const res = await server.inject({ method: "GET", url: "/api/progress" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.concepts)).toBe(true);
    expect(body.concepts.length).toBe(20);
    expect(Array.isArray(body.reviews_due)).toBe(true);
    expect(body.stats).toBeDefined();
    expect(body.records).toBeDefined();
    expect(Array.isArray(body.history)).toBe(true);
    // "Prevent recurrence" (QA-PLAN.md): see the §1.5 test above — same discipline for §1.4.
    expect(() => ProgressResponse.parse(body)).not.toThrow();
  });

  it("POST /api/generate-now enqueues an elevated-priority generate job", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/generate-now",
      payload: { concepts: [{ id: "arrays_hashing", weight: 1 }], target_rating: 1300 },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(typeof body.job_id).toBe("string");
    await deps.pool.query("delete from jobs where id = $1", [body.job_id]);
  });
});
