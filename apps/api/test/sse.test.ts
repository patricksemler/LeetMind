// Late-subscriber correctness (docs/CONTRACTS.md §4.5, apps/api brief): a client opening
// `GET /api/submissions/:id/events` after the submission already went terminal must still get the
// verdict — the live NOTIFY that announced it already fired and is gone by the time the stream
// opens, so the route must always check DB state first.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadApiConfig } from "@algolift/shared";
import { buildDeps, type Deps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { notifyBus } from "../src/sse.js";
import { cleanup, isDatabaseReachable, seedApprovedProblem, testPool } from "./helpers.js";

const dbReachable = await isDatabaseReachable();

function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  const blocks = body.split("\n\n").filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    const lines = block.split("\n");
    const eventLine = lines.find((l) => l.startsWith("event: "));
    const dataLine = lines.find((l) => l.startsWith("data: "));
    if (!eventLine || !dataLine) continue;
    events.push({ event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) });
  }
  return events;
}

describe.skipIf(!dbReachable)("SSE late-subscriber race", () => {
  let deps: Deps;
  let server: FastifyInstance;
  const pool = testPool();
  const problemVersionIds: string[] = [];
  const problemIds: string[] = [];
  const submissionIds: string[] = [];

  beforeAll(async () => {
    deps = buildDeps(loadApiConfig());
    server = buildServer(deps);
    await notifyBus.start();
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
    await notifyBus.stop();
    await server.close();
  });

  it("delivers the verdict (and mastery, if present) immediately when the submission is already terminal before the stream opens", async () => {
    const seeded = await seedApprovedProblem(pool, { conceptId: "arrays_hashing" });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const createRes = await server.inject({
      method: "POST",
      url: "/api/submissions",
      payload: {
        problem_version_id: seeded.problemVersionId,
        language: "python",
        source: "def twoSum(nums, target):\n    return []\n",
        mode: "submit",
      },
    });
    const submissionId = JSON.parse(createRes.body).submission_id as string;
    submissionIds.push(submissionId);

    // Simulate the judge finishing (and NOTIFYing) BEFORE any client ever opened the SSE stream —
    // marking the submission complete directly in the DB, with no live subscriber attached yet.
    await pool.query(
      `update submissions set status='completed', verdict='accepted', passed_tests=3, total_tests=3, runtime_ms=42, memory_kb=1024, completed_at=now() where id=$1`,
      [submissionId],
    );
    await pool.query(
      `insert into learning_events (id, user_id, problem_version_id, submission_id, kind, outcome, evidence, before_state, after_state)
       values (gen_random_uuid()::text, $1, $2, $3, 'submission', 1,
               $4::jsonb, '{}'::jsonb, '{}'::jsonb)`,
      [
        deps.config.singleUserId,
        seeded.problemVersionId,
        submissionId,
        JSON.stringify({
          changes: [{ concept_id: "arrays_hashing", before_rating: 1200, after_rating: 1216, before_uncertainty: 350, after_uncertainty: 340 }],
          explanation: "Expected 50% success; scored 1.",
        }),
      ],
    );

    // THEN open the stream — this is the race under test.
    const streamRes = await server.inject({ method: "GET", url: `/api/submissions/${submissionId}/events` });
    expect(streamRes.statusCode).toBe(200);
    expect(streamRes.headers["content-type"]).toContain("text/event-stream");

    const events = parseSseEvents(streamRes.body);
    const statusEvent = events.find((e) => e.event === "status");
    const verdictEvent = events.find((e) => e.event === "verdict");
    const masteryEvent = events.find((e) => e.event === "mastery");

    expect(statusEvent).toBeDefined();
    expect((statusEvent!.data as { status: string }).status).toBe("completed");

    expect(verdictEvent, "verdict event must still arrive even though it landed before the stream opened").toBeDefined();
    expect((verdictEvent!.data as { verdict: string }).verdict).toBe("accepted");
    expect((verdictEvent!.data as { passed_tests: number }).passed_tests).toBe(3);

    expect(masteryEvent, "mastery event must be included when a learning_events row exists").toBeDefined();
    expect((masteryEvent!.data as { outcome: number }).outcome).toBe(1);
  });

  it("returns 404 for an unknown submission id", async () => {
    const res = await server.inject({ method: "GET", url: "/api/submissions/01ARZ3NDEKTSV4RRFFQ69G5FAV/events" });
    expect(res.statusCode).toBe(404);
  });
});
