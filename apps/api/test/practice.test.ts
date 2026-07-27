import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadApiConfig } from "@leetmind/shared";
import { newIdForTest } from "./practiceHelpers.js";
import { buildDeps, type Deps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { chooseTarget } from "../src/lib/practiceSelection.js";
import { cleanup, isDatabaseReachable, seedApprovedProblem, testPool } from "./helpers.js";
import { COLD_START_PROBLEM_COUNT, COLD_START_RATING, type ConceptState } from "@leetmind/learner";

const dbReachable = await isDatabaseReachable();

const TOUCHED_CONCEPTS = ["arrays_hashing", "two_pointers", "sliding_window", "binary_search"];

function state(conceptId: string, rating: number): ConceptState {
  return {
    concept_id: conceptId,
    rating,
    uncertainty: 200,
    last_practiced_at: null,
    next_review_at: null,
    review_interval_days: 1,
    review_ease: 2.5,
    review_reps: 0,
  };
}

describe("chooseTarget (pure)", () => {
  const ordered = ["arrays_hashing", "two_pointers", "sliding_window"];

  it("picks the weakest concept the user has actual evidence for", () => {
    const states = {
      arrays_hashing: state("arrays_hashing", 1500),
      two_pointers: state("two_pointers", 1100),
      sliding_window: state("sliding_window", 1300),
    };
    const target = chooseTarget(
      states,
      ordered,
      new Set(["arrays_hashing", "two_pointers", "sliding_window"]),
    );
    expect(target?.conceptId).toBe("two_pointers");
    expect(target?.why).toContain("weakest");
  });

  it("ignores concepts with a state row but no attempts — an untouched default is not evidence", () => {
    const states = {
      arrays_hashing: state("arrays_hashing", 1500),
      // Lower rating, but never attempted: must not be treated as "known to be weak".
      two_pointers: state("two_pointers", 900),
    };
    const target = chooseTarget(states, ordered, new Set(["arrays_hashing"]));
    expect(target?.conceptId).toBe("arrays_hashing");
  });

  it("falls back to the foundational concept when there is no evidence at all", () => {
    const target = chooseTarget({}, ordered, new Set());
    expect(target?.conceptId).toBe("arrays_hashing");
    expect(target?.why).toContain("foundations");
  });

  it("returns null rather than throwing when the taxonomy is empty", () => {
    expect(chooseTarget({}, [], new Set())).toBeNull();
  });
});

describe.skipIf(!dbReachable)("GET /api/practice/next", () => {
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
    await pool.query(
      "delete from jobs where kind = 'generate' and idempotency_key like 'generate:practice:%'",
    );
    await cleanup(pool, {
      problemVersionIds: problemVersionIds.splice(0),
      problemIds: problemIds.splice(0),
      baselineSessionIds: baselineSessionIds.splice(0),
      userId: deps.config.singleUserId,
      conceptIds: TOUCHED_CONCEPTS,
    });
  });

  afterAll(async () => {
    await server.close();
  });

  /**
   * Pushes the user past the cold start.
   *
   * The first COLD_START_PROBLEM_COUNT problems are chosen by the stepping rule, not by
   * `scoreCandidate`, so every test about *selection* has to get out of that phase first. These
   * carry no `problem_version_id`, which is deliberate: it exercises the unattributable-event path
   * (a problem retired out from under an old event) while still counting toward the phase.
   */
  async function exitColdStart(): Promise<void> {
    for (let i = 0; i < COLD_START_PROBLEM_COUNT; i += 1) {
      await pool.query(
        `insert into learning_events (id, user_id, kind, outcome, evidence, before_state, after_state)
         values ($1, $2, 'submission', 1, '{}', '{}', '{}')`,
        [newIdForTest(), deps.config.singleUserId],
      );
    }
  }

  async function setAttempted(conceptId: string, rating: number): Promise<void> {
    await pool.query(
      `update user_concept_state set rating = $3, uncertainty = 200, attempts = 3 where user_id = $1 and concept_id = $2`,
      [deps.config.singleUserId, conceptId, rating],
    );
  }

  async function next() {
    const res = await server.inject({ method: "GET", url: "/api/practice/next" });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body);
  }

  it("serves a brand-new user a problem instead of gating them behind onboarding", async () => {
    // The gate this replaces returned `{ problem: null, needs_baseline: true }` and the client
    // bounced to /baseline. A first-time user now gets something to do on their first request.
    const seeded = await seedApprovedProblem(pool, {
      conceptId: "arrays_hashing",
      difficultyRating: COLD_START_RATING,
      title: "First problem",
    });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const body = await next();
    expect(body.problem.problem_version_id).toBe(seeded.problemVersionId);
    expect(body.evidence.cold_start).toBe(true);
    expect(body.evidence.of).toBe(COLD_START_PROBLEM_COUNT);
  });

  it("aims the cold start below the 1200 seed, and steps up after a solve", async () => {
    // Nothing seeded, so the pool can't answer and the route reports what it WANTED — which is the
    // cleanest way to observe the target the stepping rule chose.
    const first = await next();
    expect(first.generating.target_rating).toBe(COLD_START_RATING);
    expect(COLD_START_RATING).toBeLessThan(1200);

    await pool.query(
      `insert into learning_events (id, user_id, kind, outcome, evidence, before_state, after_state)
       values ($1, $2, 'submission', 1, '{}', '{}', '{}')`,
      [newIdForTest(), deps.config.singleUserId],
    );

    const second = await next();
    expect(second.generating.target_rating).toBeGreaterThan(COLD_START_RATING);
  });

  it("serves a problem targeting the weakest evidenced concept", async () => {
    await exitColdStart();
    await setAttempted("arrays_hashing", 1500);
    await setAttempted("two_pointers", 1100);

    // One candidate per concept, both comfortably inside their band.
    const weak = await seedApprovedProblem(pool, {
      conceptId: "two_pointers",
      difficultyRating: 1100,
      title: "Weak concept problem",
    });
    const strong = await seedApprovedProblem(pool, {
      conceptId: "arrays_hashing",
      difficultyRating: 1500,
      title: "Strong concept problem",
    });
    for (const s of [weak, strong]) {
      problemVersionIds.push(s.problemVersionId);
      problemIds.push(s.problemId);
    }

    const body = await next();
    expect(body.generating).toBeNull();
    expect(body.problem.problem_version_id).toBe(weak.problemVersionId);
    expect(body.evidence.concept).toBe("two_pointers");
  });

  it("enqueues generation and reports it, rather than an empty state, when nothing covers the target band", async () => {
    await exitColdStart();
    await setAttempted("two_pointers", 1100);

    const body = await next();
    expect(body.problem).toBeNull();
    expect(body.generating).not.toBeNull();
    expect(body.generating.concept_id).toBe("two_pointers");
    expect(body.generating.job_id).toBeTruthy();
    expect(body.generating.reason).toContain("generated");

    const jobs = await pool.query<{ id: string; kind: string; status: string }>(
      "select id, kind, status from jobs where idempotency_key like 'generate:practice:%'",
    );
    expect(jobs.rows.length).toBe(1);
    expect(jobs.rows[0]!.kind).toBe("generate");
    expect(jobs.rows[0]!.status).toBe("queued");
  });

  it("does not stack a second generate job while one is already in flight for the same cell", async () => {
    await exitColdStart();
    await setAttempted("two_pointers", 1100);

    // The web client polls this endpoint every couple of seconds for the whole generation wait —
    // if each poll enqueued, a two-minute generation would produce ~60 duplicate jobs.
    const first = await next();
    const second = await next();
    const third = await next();

    expect(second.generating.job_id).toBe(first.generating.job_id);
    expect(third.generating.job_id).toBe(first.generating.job_id);

    const jobs = await pool.query<{ n: string }>(
      "select count(*)::int as n from jobs where idempotency_key like 'generate:practice:%'",
    );
    expect(Number(jobs.rows[0]!.n)).toBe(1);
  });

  it("uses a fresh slot once the previous job for a cell is finished, so a cell is never permanently locked out", async () => {
    await exitColdStart();
    await setAttempted("two_pointers", 1100);

    const first = await next();
    await pool.query("update jobs set status = 'done' where id = $1", [first.generating.job_id]);

    const second = await next();
    expect(second.generating.job_id).not.toBe(first.generating.job_id);

    const jobs = await pool.query<{ n: string }>(
      "select count(*)::int as n from jobs where idempotency_key like 'generate:practice:%'",
    );
    expect(Number(jobs.rows[0]!.n)).toBe(2);
  });

  it("tops the buffer up in the background while still serving the problem it has", async () => {
    await exitColdStart();
    await setAttempted("two_pointers", 1100);

    // A single in-band candidate is below PRACTICE_BUFFER_WATERMARK, so serving it should also
    // commission a replacement — that is what keeps the loop from stalling on the next request.
    const only = await seedApprovedProblem(pool, {
      conceptId: "two_pointers",
      difficultyRating: 1100,
      title: "Last one in the band",
    });
    problemVersionIds.push(only.problemVersionId);
    problemIds.push(only.problemId);

    const body = await next();
    expect(body.problem.problem_version_id).toBe(only.problemVersionId);
    expect(body.evidence.buffer_low).toBe(true);

    // The top-up is deliberately fire-and-forget, so poll briefly rather than assuming it has
    // already committed by the time the response was written.
    let count = 0;
    for (let i = 0; i < 40; i += 1) {
      const jobs = await pool.query<{ n: string }>(
        "select count(*)::int as n from jobs where idempotency_key like 'generate:practice:%'",
      );
      count = Number(jobs.rows[0]!.n);
      if (count > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(count).toBe(1);
  });

  it("never re-serves a problem an old baseline already showed, even though a skip writes no submission", async () => {
    // The baseline product surface is gone, but its tables survive as read-only history
    // (migration 007) and a long-lived install can still hold rows. A baseline skip wrote no
    // `submissions` row, which is exactly why `listApprovedUnattempted` alone would offer the
    // problem again — re-asking "can you do this?" when the answer is already on record.
    await exitColdStart();
    await setAttempted("two_pointers", 1100);

    const seeded = await seedApprovedProblem(pool, {
      conceptId: "two_pointers",
      difficultyRating: 1100,
      title: "Already skipped in the baseline",
    });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const sessionId = newIdForTest();
    baselineSessionIds.push(sessionId);
    await pool.query("insert into baseline_sessions (id, user_id) values ($1, $2)", [
      sessionId,
      deps.config.singleUserId,
    ]);
    await pool.query(
      `insert into baseline_items (id, baseline_session_id, position, problem_version_id, state)
       values ($1, $2, 0, $3, 'skipped_inability')`,
      [newIdForTest(), sessionId, seeded.problemVersionId],
    );

    const body = await next();
    expect(body.problem).toBeNull();
    expect(body.generating).not.toBeNull();
  });

  it("never serves a problem the user has already submitted against", async () => {
    await exitColdStart();
    await setAttempted("two_pointers", 1100);

    const seeded = await seedApprovedProblem(pool, {
      conceptId: "two_pointers",
      difficultyRating: 1100,
      title: "Already attempted",
    });
    problemVersionIds.push(seeded.problemVersionId);
    problemIds.push(seeded.problemId);

    const submissionId = newIdForTest();
    await pool.query(
      `insert into submissions (id, user_id, problem_version_id, mode, language, source, source_hash, status)
       values ($1, $2, $3, 'submit', 'python', 'x', 'h', 'completed')`,
      [submissionId, deps.config.singleUserId, seeded.problemVersionId],
    );

    try {
      const body = await next();
      // The only candidate is attempted, so the pool is empty for this concept -> generation.
      expect(body.problem).toBeNull();
      expect(body.generating).not.toBeNull();
    } finally {
      await pool.query("delete from submissions where id = $1", [submissionId]);
    }
  });
});
