import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadApiConfig } from "@algolift/shared";
import { buildDeps, type Deps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { cleanup, isDatabaseReachable, seedApprovedProblem, testPool } from "./helpers.js";

const dbReachable = await isDatabaseReachable();

// The diagnostic probes the first 6 concepts by `concepts.sort_order` (docs/CONTRACTS.md §3 seed
// order): arrays_hashing, two_pointers, sliding_window, stacks_queues, binary_search, linked_list.
const CLUSTER_CONCEPTS = ["arrays_hashing", "two_pointers", "sliding_window", "stacks_queues", "binary_search", "linked_list"];

describe.skipIf(!dbReachable)("diagnostic onboarding", () => {
  let deps: Deps;
  let server: FastifyInstance;
  const pool = testPool();
  const problemVersionIds: string[] = [];
  const problemIds: string[] = [];
  const workoutIds: string[] = [];

  beforeAll(async () => {
    deps = buildDeps(loadApiConfig());
    server = buildServer(deps);
  });

  afterEach(async () => {
    await cleanup(pool, {
      problemVersionIds: problemVersionIds.splice(0),
      problemIds: problemIds.splice(0),
      workoutIds: workoutIds.splice(0),
      userId: deps.config.singleUserId,
      conceptIds: CLUSTER_CONCEPTS,
    });
  });

  afterAll(async () => {
    await server.close();
  });

  /** Seeds one low-mid (~1050 rated) approved problem per cluster concept, so the diagnostic's
   * naive baseline step always finds a candidate immediately (no widen-band fallback needed). */
  async function seedClusterPool(): Promise<void> {
    for (const conceptId of CLUSTER_CONCEPTS) {
      const seeded = await seedApprovedProblem(pool, { conceptId, difficultyRating: 1050, title: `${conceptId} diagnostic seed` });
      problemVersionIds.push(seeded.problemVersionId);
      problemIds.push(seeded.problemId);
    }
  }

  it("POST /api/diagnostic/start creates a diagnostic workout seeded with the first item", async () => {
    await seedClusterPool();

    const res = await server.inject({ method: "POST", url: "/api/diagnostic/start" });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    workoutIds.push(body.workout.id);

    expect(body.workout.kind).toBe("diagnostic");
    expect(body.workout.status).toBe("active");
    expect(body.workout.items.length).toBe(1);
    expect(body.workout.items[0].role).toBe("diagnostic");
    expect(body.workout.items[0].state).toBe("pending");
    expect(CLUSTER_CONCEPTS).toContain(body.workout.items[0].selection_evidence.concept_id);
    expect(body.workout.rationale.plan.length).toBe(6);
  });

  it("adapts downward (drops the next target rating) after a skip, and appends the next item on GET /api/workouts/current", async () => {
    await seedClusterPool();
    // Also seed an EASIER candidate for the second-probed concept so the post-skip lower target
    // still resolves to a real item.
    const secondConceptId = CLUSTER_CONCEPTS[1]!;
    const easier = await seedApprovedProblem(pool, { conceptId: secondConceptId, difficultyRating: 800, title: "easier second" });
    problemVersionIds.push(easier.problemVersionId);
    problemIds.push(easier.problemId);

    const start = await server.inject({ method: "POST", url: "/api/diagnostic/start" });
    const workout = JSON.parse(start.body).workout;
    workoutIds.push(workout.id);
    const firstItem = workout.items[0];
    expect(firstItem.selection_evidence.concept_id).toBe(CLUSTER_CONCEPTS[0]);

    const skip = await server.inject({
      method: "POST",
      url: `/api/workout-items/${firstItem.id}/skip`,
      payload: { reason: "inability", active_ms: 1000 },
    });
    expect(skip.statusCode).toBe(200);

    const current = await server.inject({ method: "GET", url: "/api/workouts/current" });
    expect(current.statusCode).toBe(200);
    const currentBody = JSON.parse(current.body);
    expect(currentBody.workout.items.length).toBe(2);

    const secondItem = currentBody.workout.items[1];
    expect(secondItem.selection_evidence.concept_id).toBe(secondConceptId);
    // Dropped FAST relative to the plan's naive low-mid baseline (CONTRACTS.md §8 / PLAN.md §8).
    expect(secondItem.selection_evidence.target_rating).toBeLessThan(1050);
  });

  it("steps difficulty UP after the item is marked solved, and reflects that on the next GET", async () => {
    await seedClusterPool();
    const secondConceptId = CLUSTER_CONCEPTS[1]!;
    // A harder candidate for the second concept so the post-solve HIGHER target resolves.
    const harder = await seedApprovedProblem(pool, { conceptId: secondConceptId, difficultyRating: 1500, title: "harder second" });
    problemVersionIds.push(harder.problemVersionId);
    problemIds.push(harder.problemId);

    const start = await server.inject({ method: "POST", url: "/api/diagnostic/start" });
    const workout = JSON.parse(start.body).workout;
    workoutIds.push(workout.id);
    const firstItem = workout.items[0];

    // Simulate a solve directly (no judge in this test env, same pattern as
    // test/security-sentinels.test.ts) — mark the workout_item solved.
    await pool.query("update workout_items set state = 'solved', completed_at = now() where id = $1", [firstItem.id]);

    const current = await server.inject({ method: "GET", url: "/api/workouts/current" });
    const currentBody = JSON.parse(current.body);
    expect(currentBody.workout.items.length).toBe(2);
    const secondItem = currentBody.workout.items[1];
    expect(secondItem.selection_evidence.concept_id).toBe(secondConceptId);
    expect(secondItem.selection_evidence.target_rating).toBeGreaterThan(1050);
  });

  it("completes the diagnostic once the whole plan is resolved", async () => {
    await seedClusterPool();
    const start = await server.inject({ method: "POST", url: "/api/diagnostic/start" });
    const workout = JSON.parse(start.body).workout;
    workoutIds.push(workout.id);

    // Resolve every planned concept in turn: mark solved and re-fetch until nothing pending remains
    // or the plan's 6 concepts have all been probed.
    for (let i = 0; i < CLUSTER_CONCEPTS.length; i += 1) {
      const current = await server.inject({ method: "GET", url: "/api/workouts/current" });
      const body = JSON.parse(current.body);
      if (!body.workout || body.workout.status !== "active") break;
      const pending = body.workout.items.find((it: { state: string }) => it.state === "pending");
      if (!pending) break;
      await pool.query("update workout_items set state = 'solved', completed_at = now() where id = $1", [pending.id]);
    }

    const final = await server.inject({ method: "GET", url: "/api/workouts/current" });
    // Either the workout completed (status flips, so GET /current returns null — no other active
    // workout exists), or every plan concept got an item; either way it must not loop forever.
    const finalBody = JSON.parse(final.body);
    if (finalBody.workout) {
      expect(finalBody.workout.items.length).toBeLessThanOrEqual(CLUSTER_CONCEPTS.length);
    }

    const workoutRow = await pool.query("select status from workouts where id = $1", [workout.id]);
    expect(workoutRow.rows[0].status).toBe("completed");
  });
});
