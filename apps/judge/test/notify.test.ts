// CONTRACTS.md §4.5: judge/content workers emit `pg_notify('algolift_events', ...)` inside the
// same transaction as each state write. This test opens its own `LISTEN` client (the same
// transport apps/api's SSE fanout uses) and asserts the exact, ordered sequence of events a real
// submission produces: assigned/compiling/running/completed status transitions, progress at start
// and completion, the verdict, and finally mastery.
import { Client } from "pg";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadBaseConfig, NOTIFY_CHANNEL } from "@algolift/shared";
import type { UserConceptStateRow } from "@algolift/db";
import { createJudgeHandler } from "../src/handler.js";
import {
  insertTestSubmission,
  isDatabaseReachable,
  isDockerReachable,
  makeCtx,
  makeLeasedJudgeJob,
  restoreConceptState,
  seedApprovedProblem,
  snapshotConceptState,
  teardownProblem,
  TEST_USER_ID,
  testJudgeDeps,
  type SeededProblem,
} from "./helpers.js";

const dbReachable = await isDatabaseReachable();
const dockerReachable = dbReachable ? await isDockerReachable() : false;
const canRun = dbReachable && dockerReachable;

interface CapturedEvent {
  type: string;
  [key: string]: unknown;
}

describe.skipIf(!canRun)("pg_notify sequence (integration: live Postgres LISTEN + Docker)", () => {
  const deps = testJudgeDeps();
  const handler = createJudgeHandler(deps);

  let conceptSnapshot: UserConceptStateRow;
  const problemsToTeardown: SeededProblem[] = [];

  beforeAll(async () => {
    conceptSnapshot = await snapshotConceptState();
  });

  afterEach(async () => {
    await restoreConceptState(conceptSnapshot);
    let problem: SeededProblem | undefined;
    while ((problem = problemsToTeardown.pop())) {
      await teardownProblem(problem);
    }
  });

  it("8. ordered status* -> progress -> verdict -> mastery for a submit-mode accepted submission", async () => {
    const problem = await seedApprovedProblem();
    problemsToTeardown.push(problem);
    const submission = await insertTestSubmission({
      versionId: problem.versionId,
      source: "def solve(a, b):\n    return a + b\n",
      mode: "submit",
    });

    const listenClient = new Client({ connectionString: loadBaseConfig().databaseUrl });
    await listenClient.connect();
    await listenClient.query(`LISTEN ${NOTIFY_CHANNEL}`);

    const events: CapturedEvent[] = [];
    let resolveDone: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    listenClient.on("notification", (msg) => {
      if (!msg.payload) return;
      const payload = JSON.parse(msg.payload) as CapturedEvent & { submission_id?: string };
      if (payload.submission_id !== submission.id) return;
      events.push(payload);
      if (payload.type === "mastery") resolveDone();
    });

    try {
      await handler(
        await makeLeasedJudgeJob(deps, {
          submission_id: submission.id,
          mode: "submit",
          language: "python",
          problem_version_id: problem.versionId,
          user_id: TEST_USER_ID,
        }),
        makeCtx(),
      );

      await Promise.race([
        done,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("timed out waiting for the mastery notify")), 15_000),
        ),
      ]);
    } finally {
      await listenClient.end();
    }

    const types = events.map((e) => e.type);
    expect(types).toEqual(["status", "progress", "status", "status", "status", "progress", "verdict", "mastery"]);

    const statusEvents = events.filter((e) => e.type === "status");
    expect(statusEvents.map((e) => e.status)).toEqual(["assigned", "compiling", "running", "completed"]);

    const progressEvents = events.filter((e) => e.type === "progress");
    expect(progressEvents[0]).toMatchObject({ passed: 0, total: 3 });
    expect(progressEvents[1]).toMatchObject({ passed: 3, total: 3 });

    const verdictEvent = events.find((e) => e.type === "verdict");
    expect(verdictEvent).toMatchObject({ verdict: "accepted", passed_tests: 3, total_tests: 3 });

    const masteryEvent = events.find((e) => e.type === "mastery");
    expect(masteryEvent).toBeDefined();
    expect(Array.isArray(masteryEvent?.changes)).toBe(true);
    expect(typeof masteryEvent?.explanation).toBe("string");

    // Ordering invariants beyond the exact array match above, spelled out explicitly per this
    // package's brief ("expect ordered status transitions then a verdict, then mastery").
    expect(types.indexOf("verdict")).toBeGreaterThan(types.lastIndexOf("status"));
    expect(types.indexOf("mastery")).toBeGreaterThan(types.indexOf("verdict"));
  });
});
