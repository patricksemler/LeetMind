/**
 * "Prevent recurrence" (QA-PLAN.md §Prevent recurrence #1): the mock server's own responses,
 * parsed through the SAME `@leetmind/shared` zod schemas the web app parses the real API's
 * responses through. This is what would have caught Phase 1's entire class of bugs — the mock and
 * the real API drifted on field names (`solves_by_difficulty` vs `solve_bands`, `id` vs
 * `concept_id`, and more) while both shipped green, because nothing ever compared them against a
 * shared source of truth. A schema-parse failure here means the mock no longer speaks the same
 * shape the web app (and the real API) are contracted to.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GetConceptsResponse,
  HealthResponse,
  ListSubmissionsResponse,
  NextProblemResponse,
  ProgressResponse,
  SystemStatsResponse,
} from "@leetmind/shared";
import { app } from "./server.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`);
  expect(res.status, `${path} returned ${res.status}`).toBe(200);
  return res.json();
}

describe("mock server responses parse against the shared @leetmind/shared schemas", () => {
  it("GET /health", async () => {
    const body = await getJson("/health");
    expect(() => HealthResponse.parse(body)).not.toThrow();
  });

  it("GET /api/concepts", async () => {
    const body = await getJson("/api/concepts");
    expect(() => GetConceptsResponse.parse(body)).not.toThrow();
  });

  it("GET /api/problems/next", async () => {
    const body = await getJson("/api/problems/next");
    expect(() => NextProblemResponse.parse(body)).not.toThrow();
  });

  it("GET /api/progress — the exact endpoint whose mock/real drift caused QA-PLAN.md §1.4", async () => {
    const body = await getJson("/api/progress");
    expect(() => ProgressResponse.parse(body)).not.toThrow();
  });

  it("GET /api/system/stats — the exact endpoint whose mock/real drift caused QA-PLAN.md §1.5", async () => {
    const body = await getJson("/api/system/stats");
    expect(() => SystemStatsResponse.parse(body)).not.toThrow();
  });

  it("GET /api/problems/:versionId/submissions — backs the workspace's Submissions tab", async () => {
    const next = NextProblemResponse.parse(await getJson("/api/problems/next"));
    const versionId = next.problem!.problem_version_id;
    const body = await getJson(`/api/problems/${versionId}/submissions`);
    expect(() => ListSubmissionsResponse.parse(body)).not.toThrow();
  });
});
