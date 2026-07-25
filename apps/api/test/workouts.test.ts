import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadApiConfig } from "@algolift/shared";
import { targetBand } from "@algolift/learner";
import { buildDeps, type Deps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { cleanup, isDatabaseReachable, seedApprovedProblem, testPool } from "./helpers.js";

const dbReachable = await isDatabaseReachable();
const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!dbReachable)("workout assembly + skip", () => {
  let deps: Deps;
  let server: FastifyInstance;
  const pool = testPool();
  const problemVersionIds: string[] = [];
  const problemIds: string[] = [];
  const workoutIds: string[] = [];
  const touchedConceptIds = new Set<string>(["arrays_hashing", "two_pointers", "sliding_window"]);

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
      conceptIds: [...touchedConceptIds],
    });
  });

  afterAll(async () => {
    await server.close();
  });

  async function setConceptState(
    conceptId: string,
    fields: { rating?: number; uncertainty?: number; last_practiced_at?: Date | null; next_review_at?: Date | null },
  ): Promise<void> {
    touchedConceptIds.add(conceptId);
    await pool.query(
      `update user_concept_state
          set rating = coalesce($3, rating),
              uncertainty = coalesce($4, uncertainty),
              last_practiced_at = $5,
              next_review_at = $6
        where user_id = $1 and concept_id = $2`,
      [deps.config.singleUserId, conceptId, fields.rating ?? null, fields.uncertainty ?? null, fields.last_practiced_at ?? null, fields.next_review_at ?? null],
    );
  }

  it("assembles a workout with warm-up/working/overload/recovery roles and persists workouts + workout_items transactionally", async () => {
    // arrays_hashing: strong and recently practiced -> warm-up candidate.
    await setConceptState("arrays_hashing", { rating: 1600, uncertainty: 100, last_practiced_at: new Date(Date.now() - 2 * DAY_MS) });
    // two_pointers: default (1200/350) -> the weakest reachable concept -> working/overload target.
    const band = targetBand({ rating: 1200 });
    // sliding_window: due for review.
    await setConceptState("sliding_window", { rating: 1400, next_review_at: new Date(Date.now() - 5 * DAY_MS) });

    const warmup = await seedApprovedProblem(pool, { conceptId: "arrays_hashing", difficultyRating: 1200, title: "Warmup Problem" });
    const working = await seedApprovedProblem(pool, { conceptId: "two_pointers", difficultyRating: Math.round(band.ideal), title: "Working Problem" });
    const overload = await seedApprovedProblem(pool, { conceptId: "two_pointers", difficultyRating: Math.round(band.max + 150), title: "Overload Problem" });
    const recovery = await seedApprovedProblem(pool, { conceptId: "sliding_window", difficultyRating: 1400, title: "Recovery Problem" });
    for (const seeded of [warmup, working, overload, recovery]) {
      problemVersionIds.push(seeded.problemVersionId);
      problemIds.push(seeded.problemId);
    }

    const res = await server.inject({ method: "POST", url: "/api/workouts", payload: {} });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    workoutIds.push(body.workout.id);

    const roles = body.workout.items.map((i: { role: string }) => i.role);
    expect(roles).toContain("warmup");
    expect(roles).toContain("working");
    expect(roles).toContain("overload");
    expect(roles).toContain("recovery");
    expect(typeof body.workout.rationale.summary).toBe("string");
    expect(body.workout.rationale.summary.length).toBeGreaterThan(0);

    for (const item of body.workout.items) {
      expect(typeof item.rationale).toBe("string");
      expect(item.rationale.length).toBeGreaterThan(0);
      expect(item.selection_evidence).toBeTypeOf("object");
    }

    // Persisted transactionally: both tables reflect exactly this workout's items.
    const workoutRow = await pool.query("select * from workouts where id = $1", [body.workout.id]);
    expect(workoutRow.rows.length).toBe(1);
    const itemRows = await pool.query("select * from workout_items where workout_id = $1 order by position asc", [body.workout.id]);
    expect(itemRows.rows.length).toBe(body.workout.items.length);
    expect(itemRows.rows.map((r: { role: string }) => r.role).sort()).toEqual([...roles].sort());
  });

  it("GET /api/workouts/current returns null when no workout is active", async () => {
    const res = await server.inject({ method: "GET", url: "/api/workouts/current" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).workout).toBeNull();
  });

  it("GET /api/workouts/current returns the just-created active workout", async () => {
    const seeded = await seedApprovedProblem(pool, {
      conceptId: "arrays_hashing",
      difficultyRating: Math.round(targetBand({ rating: 1200 }).ideal),
    });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const created = await server.inject({ method: "POST", url: "/api/workouts", payload: {} });
    const workoutId = JSON.parse(created.body).workout.id;
    workoutIds.push(workoutId);

    const res = await server.inject({ method: "GET", url: "/api/workouts/current" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.workout?.id).toBe(workoutId);
    expect(body.workout.status).toBe("active");
  });

  it("respects focus_concept, restricting the working-set target", async () => {
    await setConceptState("arrays_hashing", { rating: 1200 });
    await setConceptState("two_pointers", { rating: 900 }); // weaker, but NOT the focus concept

    const band = targetBand({ rating: 1200 });
    const focused = await seedApprovedProblem(pool, { conceptId: "arrays_hashing", difficultyRating: Math.round(band.ideal), title: "Focused" });
    const offFocus = await seedApprovedProblem(pool, { conceptId: "two_pointers", difficultyRating: Math.round(targetBand({ rating: 900 }).ideal), title: "OffFocus" });
    problemVersionIds.push(focused.problemVersionId, offFocus.problemVersionId);
    problemIds.push(focused.problemId, offFocus.problemId);

    const res = await server.inject({ method: "POST", url: "/api/workouts", payload: { focus_concept: "arrays_hashing" } });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    workoutIds.push(body.workout.id);

    const working = body.workout.items.find((i: { role: string }) => i.role === "working");
    expect(working?.problem_version_id).toBe(focused.problemVersionId);
  });

  it("degrades gracefully (200 with an empty/small workout) rather than erroring on a thin pool", async () => {
    const res = await server.inject({ method: "POST", url: "/api/workouts", payload: { focus_concept: "heaps_pq" } });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    workoutIds.push(body.workout.id);
    expect(Array.isArray(body.workout.items)).toBe(true);
  });

  it("skip(preference) writes zero learning events and marks the item skipped_preference", async () => {
    const seeded = await seedApprovedProblem(pool, {
      conceptId: "arrays_hashing",
      difficultyRating: Math.round(targetBand({ rating: 1200 }).ideal),
    });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const created = await server.inject({ method: "POST", url: "/api/workouts", payload: {} });
    const workout = JSON.parse(created.body).workout;
    workoutIds.push(workout.id);
    const itemId = workout.items[0].id;

    const res = await server.inject({
      method: "POST",
      url: `/api/workout-items/${itemId}/skip`,
      payload: { reason: "preference", active_ms: 5000 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.item.state).toBe("skipped_preference");
    expect(body.mastery_change).toBeUndefined();

    const events = await pool.query("select count(*)::int as count from learning_events where problem_version_id = $1", [seeded.problemVersionId]);
    expect(events.rows[0].count).toBe(0);
  });

  it("skip(inability) writes exactly one learning event, lowers rating AND uncertainty, and is idempotent", async () => {
    await setConceptState("arrays_hashing", { rating: 1200, uncertainty: 350 });
    const seeded = await seedApprovedProblem(pool, {
      conceptId: "arrays_hashing",
      difficultyRating: Math.round(targetBand({ rating: 1200 }).ideal),
    });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const created = await server.inject({ method: "POST", url: "/api/workouts", payload: {} });
    const workout = JSON.parse(created.body).workout;
    workoutIds.push(workout.id);
    const item = workout.items.find((i: { problem_version_id: string }) => i.problem_version_id === seeded.problemVersionId);
    expect(item).toBeDefined();

    const before = await pool.query("select rating, uncertainty from user_concept_state where user_id = $1 and concept_id = 'arrays_hashing'", [deps.config.singleUserId]);

    const first = await server.inject({
      method: "POST",
      url: `/api/workout-items/${item.id}/skip`,
      payload: { reason: "inability", active_ms: 3000 },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body);
    expect(firstBody.item.state).toBe("skipped_inability");
    expect(firstBody.mastery_change.outcome).toBe(0);
    expect(firstBody.mastery_change.changes.length).toBeGreaterThan(0);

    const after = await pool.query("select rating, uncertainty from user_concept_state where user_id = $1 and concept_id = 'arrays_hashing'", [deps.config.singleUserId]);
    expect(after.rows[0].rating).toBeLessThan(before.rows[0].rating);
    expect(after.rows[0].uncertainty).toBeLessThan(before.rows[0].uncertainty);

    const eventCount = await pool.query(
      "select count(*)::int as count from learning_events where problem_version_id = $1 and kind = 'skip'",
      [seeded.problemVersionId],
    );
    expect(eventCount.rows[0].count).toBe(1);

    // Idempotent: a second skip call writes NO additional learning event and returns the same result.
    const second = await server.inject({
      method: "POST",
      url: `/api/workout-items/${item.id}/skip`,
      payload: { reason: "inability", active_ms: 3000 },
    });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).mastery_change).toEqual(firstBody.mastery_change);

    const eventCountAfterSecond = await pool.query(
      "select count(*)::int as count from learning_events where problem_version_id = $1 and kind = 'skip'",
      [seeded.problemVersionId],
    );
    expect(eventCountAfterSecond.rows[0].count).toBe(1);
  });

  it("resolving the last item flips a standard workout to completed, and GET current returns null", async () => {
    const seeded = await seedApprovedProblem(pool, {
      conceptId: "arrays_hashing",
      difficultyRating: Math.round(targetBand({ rating: 1200 }).ideal),
    });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const created = await server.inject({ method: "POST", url: "/api/workouts", payload: {} });
    const workout = JSON.parse(created.body).workout;
    workoutIds.push(workout.id);
    expect(workout.items.length).toBeGreaterThan(0);

    for (const item of workout.items) {
      const res = await server.inject({
        method: "POST",
        url: `/api/workout-items/${item.id}/skip`,
        payload: { reason: "preference" },
      });
      expect(res.statusCode).toBe(200);
    }

    const row = await pool.query("select status, completed_at from workouts where id = $1", [workout.id]);
    expect(row.rows[0].status).toBe("completed");
    expect(row.rows[0].completed_at).not.toBeNull();

    const current = await server.inject({ method: "GET", url: "/api/workouts/current" });
    expect(JSON.parse(current.body).workout).toBeNull();
  });

  it("POST /api/workout-items/:id/start marks the item active and stamps started_at", async () => {
    const seeded = await seedApprovedProblem(pool, {
      conceptId: "arrays_hashing",
      difficultyRating: Math.round(targetBand({ rating: 1200 }).ideal),
    });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const created = await server.inject({ method: "POST", url: "/api/workouts", payload: {} });
    const workout = JSON.parse(created.body).workout;
    workoutIds.push(workout.id);
    const itemId = workout.items[0].id;

    const res = await server.inject({ method: "POST", url: `/api/workout-items/${itemId}/start` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.item.state).toBe("active");
    expect(body.item.started_at).not.toBeNull();
  });

  it("404s start/skip for an unknown workout item id", async () => {
    const start = await server.inject({ method: "POST", url: "/api/workout-items/01ARZ3NDEKTSV4RRFFQ69G5FAV/start" });
    expect(start.statusCode).toBe(404);
    const skip = await server.inject({
      method: "POST",
      url: "/api/workout-items/01ARZ3NDEKTSV4RRFFQ69G5FAV/skip",
      payload: { reason: "preference" },
    });
    expect(skip.statusCode).toBe(404);
  });
});
