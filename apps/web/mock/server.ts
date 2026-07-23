/**
 * Mock implementation of every endpoint in docs/CONTRACTS.md §9, backed by in-memory fixtures.
 * This is what `apps/web` runs against in dev (`pnpm dev:mock`) until `apps/api` exists — flip
 * `VITE_API_BASE` to point at the real API and nothing in `apps/web/src` needs to change.
 *
 * It is also a de-facto executable spec of §9: every response shape is built and validated
 * through the same `@algolift/shared` zod schemas the real API must satisfy, and `toPublicProblem`
 * (the *only* legal constructor of a client-facing problem, per §4.2) is imported rather than
 * reimplemented.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import {
  ConceptSchema,
  CreateSubmissionRequest,
  CreateWorkoutRequest,
  GenerateNowRequest,
  GiveUpRequest,
  HINT_PENALTY_CAPS,
  HintLevel,
  newId,
  ProblemVersionSchema,
  SkipWorkoutItemRequest,
  type Submission,
  TakeHintRequest,
  toPublicProblem,
} from "@algolift/shared";
import { CONCEPT_EDGES, CONCEPTS } from "./fixtures/concepts.js";
import { runLifecycle } from "./lifecycle.js";
import { outcomeScore, updateConcepts } from "./mastery.js";
import { subscribe } from "./sse.js";
import {
  bumpSubmissionCount,
  conceptState,
  getProblemUserState,
  hasSolvedOrGivenUp,
  learningEvents,
  problemFixtures,
  problemsById,
  submissions,
  USER_ID,
  workoutItems,
  workoutState,
} from "./state.js";
import { buildDiagnosticWorkout, buildStandardWorkout } from "./state.js";

// Sanity-check every fixture against the full, server-only schema at boot — catches fixture
// authoring mistakes before they can produce a broken PublicProblem.
for (const fixture of problemFixtures) {
  ProblemVersionSchema.parse(fixture.content);
}

const HINT_LADDER: HintLevel[] = ["l1_orientation", "l2_conceptual", "l3_structural", "outline"];

const app = express();
app.use(express.json({ limit: "2mb" }));

app.use((req: Request, res: Response, next: NextFunction) => {
  const correlationId = (req.header("x-correlation-id") ?? newId()) as string;
  res.setHeader("x-correlation-id", correlationId);
  next();
});

/** Express 5 types route params as `string | string[]` (array route patterns); every route here
 * uses a plain `:id`-style segment, so this just narrows back to the plain string. */
function pparam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function notFound(res: Response, message: string) {
  res.status(404).json({ error: { code: "not_found", message }, correlation_id: res.getHeader("x-correlation-id") });
}

function badRequest(res: Response, message: string, details?: unknown) {
  res
    .status(400)
    .json({ error: { code: "validation_error", message, details }, correlation_id: res.getHeader("x-correlation-id") });
}

function handle(fn: (req: Request, res: Response) => void | Promise<void>) {
  return (req: Request, res: Response) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error("[mock-api] unhandled error", err);
      res
        .status(500)
        .json({ error: { code: "internal_error", message: "unexpected mock server error" }, correlation_id: res.getHeader("x-correlation-id") });
    });
  };
}

// --- GET /health -------------------------------------------------------------------------------

app.get(
  "/health",
  handle((_req, res) => {
    res.json({ ok: true, version: "mock-0.1.0", db: "up" });
  }),
);

// --- GET /api/problems/next --------------------------------------------------------------------

app.get(
  "/api/problems/next",
  handle((req, res) => {
    const concept = typeof req.query.concept === "string" ? req.query.concept : undefined;
    const ratingParam = typeof req.query.rating === "string" ? Number(req.query.rating) : undefined;

    let candidates = problemFixtures.filter((p) => !getProblemUserState(p.problemVersionId).solved);
    if (candidates.length === 0) candidates = problemFixtures;
    if (concept) {
      const withConcept = candidates.filter((p) => p.content.concepts.some((c) => c.id === concept));
      if (withConcept.length > 0) candidates = withConcept;
    }

    const weakest = [...conceptState.entries()].sort((a, b) => a[1].rating - b[1].rating)[0];
    const targetRating = ratingParam ?? weakest?.[1].rating ?? 1200;

    candidates.sort(
      (a, b) => Math.abs(a.content.difficulty.rating - targetRating) - Math.abs(b.content.difficulty.rating - targetRating),
    );
    const chosen = candidates[0] ?? problemFixtures[0]!;

    const publicProblem = toPublicProblem({
      problemVersionId: chosen.problemVersionId,
      content: chosen.content,
      hintsTaken: getProblemUserState(chosen.problemVersionId).hintsTaken,
      revealConcepts: hasSolvedOrGivenUp(chosen.problemVersionId),
    });

    res.json({
      problem: publicProblem,
      rationale: concept
        ? `Nearest-band match for ${concept}: target rating ${Math.round(targetRating)}.`
        : `Weakest active concept is ${weakest?.[0] ?? "arrays_hashing"} (rating ${Math.round(targetRating)}); this problem sits in the 65–80% band.`,
      evidence: { candidate_count: candidates.length, target_rating: Math.round(targetRating) },
    });
  }),
);

// --- GET /api/problems/:versionId ----------------------------------------------------------

app.get(
  "/api/problems/:versionId",
  handle((req, res) => {
    const fixture = problemsById.get(pparam(req.params.versionId));
    if (!fixture) return notFound(res, `no problem version ${pparam(req.params.versionId)}`);
    const problem = toPublicProblem({
      problemVersionId: fixture.problemVersionId,
      content: fixture.content,
      hintsTaken: getProblemUserState(fixture.problemVersionId).hintsTaken,
      revealConcepts: hasSolvedOrGivenUp(fixture.problemVersionId),
    });
    res.json({ problem });
  }),
);

// --- POST /api/submissions -------------------------------------------------------------------

app.post(
  "/api/submissions",
  handle((req, res) => {
    const parsed = CreateSubmissionRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(res, "invalid submission body", parsed.error.flatten());
    const body = parsed.data;

    const fixture = problemsById.get(body.problem_version_id);
    if (!fixture) return notFound(res, `no problem version ${body.problem_version_id}`);

    const id = newId();
    const row: Submission = {
      id,
      user_id: USER_ID,
      problem_version_id: body.problem_version_id,
      workout_item_id: body.workout_item_id ?? null,
      mode: body.mode,
      language: body.language,
      source: body.source,
      status: "created",
      verdict: null,
      passed_tests: 0,
      total_tests: 0,
      runtime_ms: null,
      memory_kb: null,
      failure: null,
      active_ms: body.active_ms ?? null,
      correlation_id: (res.getHeader("x-correlation-id") as string) ?? null,
      created_at: new Date().toISOString(),
      completed_at: null,
    };

    submissions.set(id, {
      row,
      problemVersionId: body.problem_version_id,
      mode: body.mode,
      language: body.language,
      source: body.source,
      customInput: body.custom_input,
      workoutItemId: body.workout_item_id,
      activeMs: body.active_ms ?? 0,
    });

    if (body.workout_item_id) {
      const item = workoutItems.get(body.workout_item_id);
      if (item && item.state === "pending") {
        item.state = "active";
        item.started_at = new Date().toISOString();
      }
    }

    res.status(201).json({ submission_id: id, status: "created" });

    // Never block the response on the verdict (CONTRACTS.md §9) — the job runs after we've responded.
    void runLifecycle(id);
  }),
);

// --- GET /api/submissions/:id -----------------------------------------------------------------

app.get(
  "/api/submissions/:id",
  handle((req, res) => {
    const sub = submissions.get(pparam(req.params.id));
    if (!sub) return notFound(res, `no submission ${pparam(req.params.id)}`);
    res.json({ submission: sub.row });
  }),
);

// --- GET /api/submissions/:id/events -----------------------------------------------------------

app.get("/api/submissions/:id/events", (req, res) => {
  const sub = submissions.get(pparam(req.params.id));
  if (!sub) return notFound(res, `no submission ${pparam(req.params.id)}`);
  subscribe(pparam(req.params.id), res);
});

// --- POST /api/hints -----------------------------------------------------------------------

app.post(
  "/api/hints",
  handle((req, res) => {
    const parsed = TakeHintRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(res, "invalid hint request", parsed.error.flatten());
    const { problem_version_id, level } = parsed.data;

    if (level === "editorial") {
      return badRequest(res, "editorial is only reached via POST /api/problems/:versionId/give-up");
    }

    const fixture = problemsById.get(problem_version_id);
    if (!fixture) return notFound(res, `no problem version ${problem_version_id}`);

    const userState = getProblemUserState(problem_version_id);
    if (!userState.hintsTaken.includes(level)) userState.hintsTaken.push(level);

    const idx = HINT_LADDER.indexOf(level);
    const nextLevel = idx >= 0 && idx + 1 < HINT_LADDER.length ? HINT_LADDER[idx + 1]! : "editorial";

    res.json({
      level,
      text: fixture.content.hints[level],
      penalty_cap: HINT_PENALTY_CAPS[level],
      next_level_penalty: HINT_PENALTY_CAPS[nextLevel],
    });
  }),
);

// --- GET /api/hints/:versionId ---------------------------------------------------------------

app.get(
  "/api/hints/:versionId",
  handle((req, res) => {
    const fixture = problemsById.get(pparam(req.params.versionId));
    if (!fixture) return notFound(res, `no problem version ${pparam(req.params.versionId)}`);
    const userState = getProblemUserState(pparam(req.params.versionId));
    const taken: HintLevel[] = userState.gaveUp ? [...userState.hintsTaken, "editorial"] : [...userState.hintsTaken];
    const available = HINT_LADDER.filter((l) => !userState.hintsTaken.includes(l));
    res.json({ taken, available, penalties: HINT_PENALTY_CAPS });
  }),
);

// --- POST /api/problems/:versionId/give-up ----------------------------------------------------

app.post(
  "/api/problems/:versionId/give-up",
  handle((req, res) => {
    const versionId = pparam(req.params.versionId);
    const fixture = problemsById.get(versionId);
    if (!fixture) return notFound(res, `no problem version ${versionId}`);

    const parsed = GiveUpRequest.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, "invalid give-up body", parsed.error.flatten());
    const body = parsed.data;

    const userState = getProblemUserState(versionId);
    userState.gaveUp = true;
    const activeMs = body.active_ms ?? 0;

    const { outcome, evidenceWeight } = outcomeScore({
      verdict: null,
      gaveUp: true,
      skipped: null,
      highestHint: null,
      activeMs,
      expectedMinutes: fixture.content.expected_active_minutes,
      substantiveSubmissions: 0,
    });

    const states: Record<string, { rating: number; uncertainty: number }> = {};
    for (const c of fixture.content.concepts) {
      const cs = conceptState.get(c.id);
      if (cs) states[c.id] = { rating: cs.rating, uncertainty: cs.uncertainty };
    }
    const { changes, explanation, newStates } = updateConcepts({
      states,
      weights: fixture.content.concepts.map((c) => ({ id: c.id, weight: c.weight })),
      problemRating: fixture.content.difficulty.rating,
      outcome,
      evidenceWeight,
    });
    for (const c of fixture.content.concepts) {
      const cs = conceptState.get(c.id);
      const next = newStates[c.id];
      if (!cs || !next) continue;
      cs.rating = next.rating;
      cs.uncertainty = next.uncertainty;
      cs.attempts += 1;
      cs.current_streak = 0;
      cs.total_active_ms += activeMs;
      cs.last_practiced_at = new Date().toISOString();
    }

    learningEvents.push({
      id: `le_giveup_${versionId}_${Date.now()}`,
      kind: "give_up",
      problem_version_id: versionId,
      verdict: null,
      outcome,
      hints_used: [...userState.hintsTaken],
      active_ms: activeMs,
      difficulty_rating: fixture.content.difficulty.rating,
      created_at: new Date().toISOString(),
    });

    if (body.workout_item_id) {
      const item = workoutItems.get(body.workout_item_id);
      if (item) {
        item.state = "gave_up";
        item.completed_at = new Date().toISOString();
        item.active_ms = activeMs;
      }
    }

    const concepts = fixture.content.concepts
      .map((c) => CONCEPTS.find((full) => full.id === c.id))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c) => ConceptSchema.parse(c));

    res.json({
      editorial_md: fixture.content.hints.editorial_md,
      concepts,
      mastery_change: { changes, outcome, explanation },
    });
  }),
);

// --- GET /api/progress -------------------------------------------------------------------------

app.get(
  "/api/progress",
  handle((_req, res) => {
    const now = Date.now();
    const concepts = CONCEPTS.map((c) => {
      const cs = conceptState.get(c.id)!;
      return {
        id: c.id,
        name: c.name,
        rating: Math.round(cs.rating),
        uncertainty: Math.round(cs.uncertainty),
        trend: cs.solves > cs.attempts / 2 ? "up" : cs.attempts > 0 ? "flat" : "unstarted",
        attempts: cs.attempts,
        solves: cs.solves,
        unassisted_solves: cs.unassisted_solves,
        current_streak: cs.current_streak,
        best_streak: cs.best_streak,
        last_practiced_at: cs.last_practiced_at,
      };
    });

    const reviewsDue = CONCEPTS.map((c) => {
      const cs = conceptState.get(c.id)!;
      return { concept_id: c.id, name: c.name, due_at: cs.next_review_at, interval_days: cs.review_interval_days };
    }).filter((r) => r.due_at && new Date(r.due_at).getTime() <= now);

    const submissionRows = [...submissions.values()].filter((s) => s.mode === "submit" && s.row.status === "completed");
    const byDifficulty: Record<string, { solved: number; with_hints: number; without_hints: number }> = {};
    for (const s of submissionRows) {
      const fixture = problemsById.get(s.problemVersionId);
      const band = fixture ? `${Math.floor(fixture.content.difficulty.rating / 100) * 100}` : "unknown";
      byDifficulty[band] ??= { solved: 0, with_hints: 0, without_hints: 0 };
      if (s.row.verdict === "accepted") {
        byDifficulty[band].solved += 1;
        const hinted = getProblemUserState(s.problemVersionId).hintsTaken.length > 0;
        if (hinted) byDifficulty[band].with_hints += 1;
        else byDifficulty[band].without_hints += 1;
      }
    }

    const activeMsSamples = submissionRows.map((s) => s.activeMs).filter((n) => n > 0).sort((a, b) => a - b);
    const medianActiveMs = activeMsSamples.length
      ? activeMsSamples[Math.floor(activeMsSamples.length / 2)]!
      : 0;

    const errorCategoryRecurrences: Record<string, number> = {};
    for (const cs of conceptState.values()) {
      for (const [k, v] of Object.entries(cs.error_counts)) errorCategoryRecurrences[k] = (errorCategoryRecurrences[k] ?? 0) + v;
    }

    const highestUnassisted = problemFixtures
      .filter((p) => getProblemUserState(p.problemVersionId).solved && getProblemUserState(p.problemVersionId).hintsTaken.length === 0)
      .sort((a, b) => b.content.difficulty.rating - a.content.difficulty.rating)[0];

    res.json({
      concepts,
      reviews_due: reviewsDue,
      stats: {
        solves_by_difficulty: byDifficulty,
        median_active_ms: medianActiveMs,
        error_category_recurrences: errorCategoryRecurrences,
        total_submissions: submissionRows.length,
      },
      records: {
        highest_unassisted_difficulty: highestUnassisted?.content.difficulty.rating ?? null,
        highest_unassisted_title: highestUnassisted?.content.title ?? null,
        comparable_time_improvements: [],
      },
      history: workoutState.workout
        ? [
            {
              workout_id: workoutState.workout.id,
              kind: workoutState.workout.kind,
              status: workoutState.workout.status,
              created_at: workoutState.workout.created_at,
              items_completed: (workoutState.workout.items ?? []).filter((i) => i.state === "solved").length,
              items_total: (workoutState.workout.items ?? []).length,
            },
          ]
        : [],
    });
  }),
);

// --- GET /api/system/stats -----------------------------------------------------------------

app.get(
  "/api/system/stats",
  handle((_req, res) => {
    const jitter = () => Math.round(Math.random() * 3);
    const verdictCounts: Record<string, number> = {};
    for (const s of submissions.values()) {
      if (s.row.verdict) verdictCounts[s.row.verdict] = (verdictCounts[s.row.verdict] ?? 0) + 1;
    }

    const bufferDepth: Record<string, number> = {};
    for (const p of problemFixtures) {
      const band = `${p.content.concepts[0]!.id}:${Math.floor(p.content.difficulty.rating / 200) * 200}`;
      bufferDepth[band] = (bufferDepth[band] ?? 0) + 1;
    }

    res.json({
      queue: {
        depth: jitter(),
        by_kind: { judge: jitter(), verify: jitter(), generate: jitter() },
        wait_p50_ms: 120 + jitter() * 10,
        wait_p95_ms: 480 + jitter() * 20,
        wait_p99_ms: 900 + jitter() * 40,
      },
      workers: [
        { worker_id: "judge-mock-1", kind: "judge", last_seen_at: new Date().toISOString(), leased_jobs: 0 },
        { worker_id: "content-mock-1", kind: "content", last_seen_at: new Date(Date.now() - 4000).toISOString(), leased_jobs: 0 },
      ],
      verdicts: verdictCounts,
      buffer_depth: bufferDepth,
      generation_pass_rate: {
        schema: 0.94,
        compile: 0.91,
        differential: 0.83,
        boundary: 0.78,
        examples: 0.98,
        mutation: 0.71,
      },
      model_runs: { p50_ms: 8200, p95_ms: 21400, avg_cost_usd: 0.043 },
      dead_jobs: [],
    });
  }),
);

// --- POST /api/workouts (M3) --------------------------------------------------------------------

app.post(
  "/api/workouts",
  handle((req, res) => {
    const parsed = CreateWorkoutRequest.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, "invalid workout request", parsed.error.flatten());
    const workout = buildStandardWorkout();
    res.json({ workout });
  }),
);

// --- GET /api/workouts/current (M3) ---------------------------------------------------------

app.get(
  "/api/workouts/current",
  handle((_req, res) => {
    res.json({ workout: workoutState.workout });
  }),
);

// --- POST /api/workout-items/:id/skip (M3) -----------------------------------------------------

app.post(
  "/api/workout-items/:id/skip",
  handle((req, res) => {
    const item = workoutItems.get(pparam(req.params.id));
    if (!item) return notFound(res, `no workout item ${pparam(req.params.id)}`);
    const parsed = SkipWorkoutItemRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(res, "invalid skip request", parsed.error.flatten());
    const { reason, active_ms } = parsed.data;

    item.state = reason === "inability" ? "skipped_inability" : "skipped_preference";
    item.completed_at = new Date().toISOString();
    item.active_ms = active_ms ?? 0;

    if (reason === "preference") {
      // CONTRACTS.md §8: skip(preference) -> no learning event at all.
      res.json({ item });
      return;
    }

    const fixture = problemsById.get(item.problem_version_id);
    if (!fixture) {
      res.json({ item });
      return;
    }

    const { outcome, evidenceWeight } = outcomeScore({
      verdict: null,
      gaveUp: false,
      skipped: "inability",
      highestHint: null,
      activeMs: active_ms ?? 0,
      expectedMinutes: fixture.content.expected_active_minutes,
      substantiveSubmissions: 0,
    });

    const states: Record<string, { rating: number; uncertainty: number }> = {};
    for (const c of fixture.content.concepts) {
      const cs = conceptState.get(c.id);
      if (cs) states[c.id] = { rating: cs.rating, uncertainty: cs.uncertainty };
    }
    const { changes, explanation, newStates } = updateConcepts({
      states,
      weights: fixture.content.concepts.map((c) => ({ id: c.id, weight: c.weight })),
      problemRating: fixture.content.difficulty.rating,
      outcome,
      evidenceWeight,
    });
    for (const c of fixture.content.concepts) {
      const cs = conceptState.get(c.id);
      const next = newStates[c.id];
      if (!cs || !next) continue;
      cs.rating = next.rating;
      cs.uncertainty = next.uncertainty;
      cs.attempts += 1;
      cs.skips += 1;
      cs.current_streak = 0;
    }

    learningEvents.push({
      id: `le_skip_${item.id}`,
      kind: "skip",
      problem_version_id: item.problem_version_id,
      verdict: null,
      outcome,
      hints_used: [],
      active_ms: active_ms ?? 0,
      created_at: new Date().toISOString(),
    });

    res.json({ item, mastery_change: { changes, outcome, explanation } });
  }),
);

// --- POST /api/workout-items/:id/start (M3) ---------------------------------------------------

app.post(
  "/api/workout-items/:id/start",
  handle((req, res) => {
    const item = workoutItems.get(pparam(req.params.id));
    if (!item) return notFound(res, `no workout item ${pparam(req.params.id)}`);
    item.state = "active";
    item.started_at = item.started_at ?? new Date().toISOString();
    res.json({ item });
  }),
);

// --- POST /api/diagnostic/start (M3) -----------------------------------------------------------

app.post(
  "/api/diagnostic/start",
  handle((_req, res) => {
    const workout = buildDiagnosticWorkout();
    res.json({ workout });
  }),
);

// --- POST /api/generate-now (M3 escape hatch) ---------------------------------------------------

app.post(
  "/api/generate-now",
  handle((req, res) => {
    const parsed = GenerateNowRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(res, "invalid generate-now request", parsed.error.flatten());
    res.json({ job_id: newId() });
  }),
);

// --- GET /api/concepts -------------------------------------------------------------------------

app.get(
  "/api/concepts",
  handle((_req, res) => {
    res.json({ concepts: CONCEPTS, edges: CONCEPT_EDGES });
  }),
);

const PORT = Number(process.env.MOCK_PORT ?? process.env.VITE_API_BASE?.split(":").pop() ?? 8080);
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-api] listening on http://localhost:${PORT} (${problemFixtures.length} fixture problems)`);
});
