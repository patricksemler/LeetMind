import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadApiConfig } from "@leetmind/shared";
import { buildDeps, type Deps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { cleanup, isDatabaseReachable, seedApprovedProblem, testPool } from "./helpers.js";

const dbReachable = await isDatabaseReachable();

// The baseline probes the first 6 concepts by `concepts.sort_order` (docs/CONTRACTS.md §3 seed
// order): arrays_hashing, two_pointers, sliding_window, stacks_queues, binary_search, linked_list.
const CLUSTER_CONCEPTS = ["arrays_hashing", "two_pointers", "sliding_window", "stacks_queues", "binary_search", "linked_list"];

describe.skipIf(!dbReachable)("baseline onboarding", () => {
  let deps: Deps;
  let server: FastifyInstance;
  const pool = testPool();
  const problemVersionIds: string[] = [];
  const problemIds: string[] = [];
  const baselineSessionIds: string[] = [];

  beforeAll(async () => {
    deps = buildDeps(loadApiConfig());
    server = buildServer(deps);
  });

  afterEach(async () => {
    await cleanup(pool, {
      problemVersionIds: problemVersionIds.splice(0),
      problemIds: problemIds.splice(0),
      baselineSessionIds: baselineSessionIds.splice(0),
      userId: deps.config.singleUserId,
      conceptIds: CLUSTER_CONCEPTS,
    });
  });

  afterAll(async () => {
    await server.close();
  });

  /** Seeds one low-mid (~1050 rated) approved problem per cluster concept, so the baseline's naive
   * starting step always finds a candidate immediately (no widen-band fallback needed). */
  async function seedClusterPool(): Promise<void> {
    for (const conceptId of CLUSTER_CONCEPTS) {
      const seeded = await seedApprovedProblem(pool, { conceptId, difficultyRating: 1050, title: `${conceptId} baseline seed` });
      problemVersionIds.push(seeded.problemVersionId);
      problemIds.push(seeded.problemId);
    }
  }

  async function startBaseline() {
    const res = await server.inject({ method: "POST", url: "/api/baseline/start" });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    baselineSessionIds.push(body.baseline.id);
    return body.baseline;
  }

  it("POST /api/baseline/start creates a session seeded with only the first probe", async () => {
    await seedClusterPool();
    const baseline = await startBaseline();

    expect(baseline.status).toBe("active");
    expect(baseline.items.length).toBe(1);
    expect(baseline.items[0].state).toBe("pending");
    expect(CLUSTER_CONCEPTS).toContain(baseline.items[0].selection_evidence.concept_id);
    // The plan covers all six clusters even though only one item exists yet — that is what makes
    // the flow adaptive rather than a fixed list.
    expect(baseline.rationale.plan.length).toBe(6);
    expect(baseline.planned_count).toBe(6);
  });

  it("adapts downward after a skip, and appends the next probe on GET /api/baseline/current", async () => {
    await seedClusterPool();
    // Also seed an EASIER candidate for the second-probed concept so the post-skip lower target
    // still resolves to a real item.
    const secondConceptId = CLUSTER_CONCEPTS[1]!;
    const easier = await seedApprovedProblem(pool, { conceptId: secondConceptId, difficultyRating: 800, title: "easier second" });
    problemVersionIds.push(easier.problemVersionId);
    problemIds.push(easier.problemId);

    const baseline = await startBaseline();
    const firstItem = baseline.items[0];
    expect(firstItem.selection_evidence.concept_id).toBe(CLUSTER_CONCEPTS[0]);

    const skip = await server.inject({
      method: "POST",
      url: `/api/baseline-items/${firstItem.id}/skip`,
      payload: { reason: "inability", active_ms: 1000 },
    });
    expect(skip.statusCode).toBe(200);

    const current = await server.inject({ method: "GET", url: "/api/baseline/current" });
    expect(current.statusCode).toBe(200);
    const body = JSON.parse(current.body);
    expect(body.baseline.items.length).toBe(2);

    const secondItem = body.baseline.items[1];
    expect(secondItem.selection_evidence.concept_id).toBe(secondConceptId);
    // Dropped FAST relative to the plan's naive low-mid baseline (CONTRACTS.md §8 / PLAN.md §8).
    expect(secondItem.selection_evidence.target_rating).toBeLessThan(1050);
  });

  it("steps difficulty UP after a solve, and reflects that on the next GET", async () => {
    await seedClusterPool();
    const secondConceptId = CLUSTER_CONCEPTS[1]!;
    const harder = await seedApprovedProblem(pool, { conceptId: secondConceptId, difficultyRating: 1500, title: "harder second" });
    problemVersionIds.push(harder.problemVersionId);
    problemIds.push(harder.problemId);

    const baseline = await startBaseline();
    const firstItem = baseline.items[0];

    // Simulate a solve directly (no judge in this test env, same pattern as
    // test/security-sentinels.test.ts).
    await pool.query("update baseline_items set state = 'solved', completed_at = now() where id = $1", [firstItem.id]);

    const current = await server.inject({ method: "GET", url: "/api/baseline/current" });
    const body = JSON.parse(current.body);
    expect(body.baseline.items.length).toBe(2);
    const secondItem = body.baseline.items[1];
    expect(secondItem.selection_evidence.concept_id).toBe(secondConceptId);
    expect(secondItem.selection_evidence.target_rating).toBeGreaterThan(1050);
  });

  it("completes the session once the whole plan is resolved", async () => {
    await seedClusterPool();
    const baseline = await startBaseline();

    for (let i = 0; i < CLUSTER_CONCEPTS.length; i += 1) {
      const current = await server.inject({ method: "GET", url: "/api/baseline/current" });
      const body = JSON.parse(current.body);
      if (!body.baseline || body.baseline.status !== "active") break;
      const pending = body.baseline.items.find((it: { state: string }) => it.state === "pending");
      if (!pending) break;
      await pool.query("update baseline_items set state = 'solved', completed_at = now() where id = $1", [pending.id]);
    }

    const final = await server.inject({ method: "GET", url: "/api/baseline/current" });
    const finalBody = JSON.parse(final.body);
    if (finalBody.baseline) {
      expect(finalBody.baseline.items.length).toBeLessThanOrEqual(CLUSTER_CONCEPTS.length);
    }

    const row = await pool.query("select status from baseline_sessions where id = $1", [baseline.id]);
    expect(row.rows[0].status).toBe("completed");
  });

  it("skip(preference) writes zero learning events and marks the item skipped_preference", async () => {
    await seedClusterPool();
    const baseline = await startBaseline();
    const item = baseline.items[0];

    const before = await pool.query("select count(*)::int as n from learning_events where user_id = $1", [
      deps.config.singleUserId,
    ]);

    const res = await server.inject({
      method: "POST",
      url: `/api/baseline-items/${item.id}/skip`,
      payload: { reason: "preference" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).item.state).toBe("skipped_preference");
    expect(JSON.parse(res.body).mastery_change).toBeUndefined();

    const after = await pool.query("select count(*)::int as n from learning_events where user_id = $1", [
      deps.config.singleUserId,
    ]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("skip(inability) writes exactly one learning event, lowers rating AND uncertainty, and is idempotent", async () => {
    await seedClusterPool();
    const baseline = await startBaseline();
    const item = baseline.items[0];
    const conceptId = item.selection_evidence.concept_id as string;

    const before = await pool.query("select rating, uncertainty from user_concept_state where user_id = $1 and concept_id = $2", [
      deps.config.singleUserId,
      conceptId,
    ]);

    const first = await server.inject({
      method: "POST",
      url: `/api/baseline-items/${item.id}/skip`,
      payload: { reason: "inability", active_ms: 2000 },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body);
    expect(firstBody.item.state).toBe("skipped_inability");
    expect(firstBody.mastery_change.outcome).toBe(0);
    expect(firstBody.mastery_change.changes.length).toBeGreaterThan(0);

    const after = await pool.query("select rating, uncertainty from user_concept_state where user_id = $1 and concept_id = $2", [
      deps.config.singleUserId,
      conceptId,
    ]);
    // A skip is evidence, not a punishment: it lowers the estimate AND tightens the uncertainty
    // around it (CONTRACTS.md §8, evidenceWeight 0.5).
    expect(Number(after.rows[0].rating)).toBeLessThan(Number(before.rows[0].rating));
    expect(Number(after.rows[0].uncertainty)).toBeLessThan(Number(before.rows[0].uncertainty));

    // Replaying the same skip must not double-apply. The second call returns the FIRST call's
    // result (idempotent on learningEventKey), and the item stays terminal.
    const second = await server.inject({
      method: "POST",
      url: `/api/baseline-items/${item.id}/skip`,
      payload: { reason: "inability", active_ms: 2000 },
    });
    expect(second.statusCode).toBe(200);

    const events = await pool.query(
      "select count(*)::int as n from learning_events where user_id = $1 and kind = 'skip' and problem_version_id = $2",
      [deps.config.singleUserId, item.problem_version_id],
    );
    expect(events.rows[0].n).toBe(1);

    const settled = await pool.query("select rating, uncertainty from user_concept_state where user_id = $1 and concept_id = $2", [
      deps.config.singleUserId,
      conceptId,
    ]);
    expect(Number(settled.rows[0].rating)).toBe(Number(after.rows[0].rating));
  });

  it("POST /api/baseline-items/:id/start marks the item active and stamps started_at once", async () => {
    await seedClusterPool();
    const baseline = await startBaseline();
    const item = baseline.items[0];

    const first = await server.inject({ method: "POST", url: `/api/baseline-items/${item.id}/start` });
    expect(first.statusCode).toBe(200);
    const started = JSON.parse(first.body).item;
    expect(started.state).toBe("active");
    expect(started.started_at).toBeTruthy();

    // The workspace fires this unconditionally on mount, so a revisit must be a no-op rather than
    // resetting the clock.
    const second = await server.inject({ method: "POST", url: `/api/baseline-items/${item.id}/start` });
    expect(JSON.parse(second.body).item.started_at).toBe(started.started_at);
  });

  it("404s start/skip for an unknown baseline item id", async () => {
    const unknown = "01JJJJJJJJJJJJJJJJJJJJJJJJ";
    const start = await server.inject({ method: "POST", url: `/api/baseline-items/${unknown}/start` });
    expect(start.statusCode).toBe(404);
    const skip = await server.inject({
      method: "POST",
      url: `/api/baseline-items/${unknown}/skip`,
      payload: { reason: "inability" },
    });
    expect(skip.statusCode).toBe(404);
  });

  it("starting a fresh baseline abandons the previous one, so GET current never has two candidates", async () => {
    await seedClusterPool();
    const first = await startBaseline();
    const second = await startBaseline();
    expect(second.id).not.toBe(first.id);

    const firstRow = await pool.query("select status from baseline_sessions where id = $1", [first.id]);
    expect(firstRow.rows[0].status).toBe("abandoned");

    const current = await server.inject({ method: "GET", url: "/api/baseline/current" });
    expect(JSON.parse(current.body).baseline.id).toBe(second.id);
  });

  it("does not re-serve a problem the previous baseline already showed", async () => {
    // Exactly one candidate for the first cluster concept: if retakes ignored history, the retake
    // would show the identical problem, making it a memory test rather than a probe.
    const only = await seedApprovedProblem(pool, {
      conceptId: CLUSTER_CONCEPTS[0]!,
      difficultyRating: 1050,
      title: "only arrays candidate",
    });
    problemVersionIds.push(only.problemVersionId);
    problemIds.push(only.problemId);
    const other = await seedApprovedProblem(pool, {
      conceptId: CLUSTER_CONCEPTS[1]!,
      difficultyRating: 1050,
      title: "two pointers candidate",
    });
    problemVersionIds.push(other.problemVersionId);
    problemIds.push(other.problemId);

    const first = await startBaseline();
    expect(first.items[0].problem_version_id).toBe(only.problemVersionId);

    const retake = await startBaseline();
    expect(retake.items[0]?.problem_version_id).not.toBe(only.problemVersionId);
  });

  it("creates an immediately-completed session rather than erroring when the approved pool is empty", async () => {
    const baseline = await startBaseline();
    expect(baseline.items.length).toBe(0);
    expect(baseline.status).toBe("completed");
  });
});
