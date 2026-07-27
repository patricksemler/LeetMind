// Late-subscriber correctness (docs/CONTRACTS.md §4.5, apps/api brief): a client opening
// `GET /api/submissions/:id/events` after the submission already went terminal must still get the
// verdict — the live NOTIFY that announced it already fired and is gone by the time the stream
// opens, so the route must always check DB state first.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadApiConfig } from "@leetmind/shared";
import { notify } from "@leetmind/db";
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
    events.push({
      event: eventLine.slice("event: ".length),
      data: JSON.parse(dataLine.slice("data: ".length)),
    });
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

  let baseUrl: string;

  beforeAll(async () => {
    deps = buildDeps(loadApiConfig());
    server = buildServer(deps);
    await notifyBus.start();
    await server.listen({ port: 0, host: "127.0.0.1" });
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
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
          changes: [
            {
              concept_id: "arrays_hashing",
              before_rating: 1200,
              after_rating: 1216,
              before_uncertainty: 350,
              after_uncertainty: 340,
            },
          ],
          explanation: "Expected 50% success; scored 1.",
        }),
      ],
    );

    // THEN open the stream — this is the race under test.
    const streamRes = await server.inject({
      method: "GET",
      url: `/api/submissions/${submissionId}/events`,
    });
    expect(streamRes.statusCode).toBe(200);
    expect(streamRes.headers["content-type"]).toContain("text/event-stream");

    const events = parseSseEvents(streamRes.body);
    const statusEvent = events.find((e) => e.event === "status");
    const verdictEvent = events.find((e) => e.event === "verdict");
    const masteryEvent = events.find((e) => e.event === "mastery");

    expect(statusEvent).toBeDefined();
    expect((statusEvent!.data as { status: string }).status).toBe("completed");

    expect(
      verdictEvent,
      "verdict event must still arrive even though it landed before the stream opened",
    ).toBeDefined();
    expect((verdictEvent!.data as { verdict: string }).verdict).toBe("accepted");
    expect((verdictEvent!.data as { passed_tests: number }).passed_tests).toBe(3);

    expect(
      masteryEvent,
      "mastery event must be included when a learning_events row exists",
    ).toBeDefined();
    expect((masteryEvent!.data as { outcome: number }).outcome).toBe(1);
  });

  it("delivers a live verdict event — sanitized failure + reveal — via the LISTEN/NOTIFY path, not just catch-up", async () => {
    // Regression test for the P0 "live verdict never reaches the client" bug: the live path used
    // to chain `void buildReveal(...).then(...)` with no `.catch` (silently dropping the event on
    // any rejection) and skip `sanitizeFailure` entirely. This opens a REAL streaming connection
    // (not `server.inject`, which can't observe events published after the request is already
    // in flight) and completes the submission out-of-band — the way the judge actually would —
    // while the stream is open.
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

    const controller = new AbortController();
    const streamPromise = fetch(`${baseUrl}/api/submissions/${submissionId}/events`, {
      signal: controller.signal,
    });
    const response = await streamPromise;
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    async function readUntil(
      eventName: string,
      timeoutMs = 5000,
    ): Promise<{ event: string; data: unknown }> {
      let buffered = "";
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const blocks = buffered.split("\n\n");
        buffered = blocks.pop() ?? "";
        for (const block of blocks) {
          const lines = block.split("\n");
          const eventLine = lines.find((l) => l.startsWith("event: "));
          const dataLine = lines.find((l) => l.startsWith("data: "));
          if (!eventLine || !dataLine) continue;
          const event = eventLine.slice("event: ".length);
          if (event === eventName) {
            return { event, data: JSON.parse(dataLine.slice("data: ".length)) };
          }
        }
      }
      throw new Error(`timed out waiting for SSE event "${eventName}"`);
    }

    // Consume the initial `status` event emitted synchronously on subscribe.
    await readUntil("status");

    // Complete the submission out-of-band and NOTIFY — exactly what the judge's transaction does —
    // while the stream above is still open and live-subscribed.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update submissions set status='completed', verdict='accepted', passed_tests=3, total_tests=3, runtime_ms=42, memory_kb=1024, completed_at=now(), failure=$2::jsonb where id=$1`,
        [
          submissionId,
          JSON.stringify({
            kind: "solved",
            message: "Accepted",
            input_preview: ["should", "be", "stripped"],
          }),
        ],
      );
      await notify(client, {
        type: "verdict",
        submission_id: submissionId,
        user_id: deps.config.singleUserId,
        verdict: "accepted",
        passed_tests: 3,
        total_tests: 3,
        runtime_ms: 42,
        memory_kb: 1024,
        failure: {
          kind: "solved",
          message: "Accepted",
          input_preview: ["should", "be", "stripped"],
        },
      });
      await client.query("commit");
    } finally {
      client.release();
    }

    const verdictEvent = await readUntil("verdict");
    controller.abort();

    const data = verdictEvent.data as {
      verdict: string;
      passed_tests: number;
      failure?: Record<string, unknown>;
      reveal?: {
        editorial_md: string;
        target_complexity: { time: string; space: string };
        concepts: unknown[];
      };
    };
    expect(data.verdict).toBe("accepted");
    expect(data.passed_tests).toBe(3);
    expect(
      data.failure,
      "submit-mode failure must be sanitized on the live path too",
    ).not.toHaveProperty("input_preview");
    expect(
      data.reveal,
      "an accepted submit earns reveal live, not just after reload/reconnect",
    ).toBeDefined();
    expect(data.reveal!.editorial_md).toEqual(expect.any(String));
    expect(data.reveal!.target_complexity).toBeDefined();
  });

  it("returns 404 for an unknown submission id", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/submissions/01ARZ3NDEKTSV4RRFFQ69G5FAV/events",
    });
    expect(res.statusCode).toBe(404);
  });
});
