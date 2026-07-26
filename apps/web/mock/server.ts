/**
 * Mock implementation of every endpoint in docs/CONTRACTS.md §9, backed by in-memory fixtures.
 * This is what `apps/web` runs against in dev (`pnpm dev:mock`) until `apps/api` exists — flip
 * `VITE_API_BASE` to point at the real API and nothing in `apps/web/src` needs to change.
 *
 * It is also a de-facto executable spec of §9: every response shape is built and validated
 * through the same `@leetmind/shared` zod schemas the real API must satisfy, and `toPublicProblem`
 * (the *only* legal constructor of a client-facing problem, per §4.2) is imported rather than
 * reimplemented.
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import {
  ConceptSchema,
  CreateSubmissionRequest,
  GenerateNowRequest,
  GiveUpRequest,
  HINT_PENALTY_CAPS,
  HintLevel,
  newId,
  ProblemVersionSchema,
  SkipBaselineItemRequest,
  type Submission,
  TakeHintRequest,
  toPublicProblem,
} from "@leetmind/shared";
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
  advanceMockBaseline,
  buildBaseline,
  resetBaseline,
  baselineItems,
  baselineState,
} from "./state.js";

// Sanity-check every fixture against the full, server-only schema at boot — catches fixture
// authoring mistakes before they can produce a broken PublicProblem.
for (const fixture of problemFixtures) {
  ProblemVersionSchema.parse(fixture.content);
}

const HINT_LADDER: HintLevel[] = ["l1_orientation", "l2_conceptual", "l3_structural", "outline"];

const app: Express = express();
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

// --- GET /api/practice/next ----------------------------------------------------------------------
//
// The mock's job here is to exercise all three branches the real endpoint can return, since two of
// them (needs_baseline, generating) are otherwise only reachable against a live stack with an
// empty content pool. `?mock=generating` forces the generating branch so the polling UI can be
// developed and tested without waiting on a real `claude -p` run.

app.get(
  "/api/practice/next",
  handle((req, res) => {
    if (!baselineState.everStarted) {
      res.json({
        problem: null,
        generating: null,
        needs_baseline: true,
        rationale: "Take the short baseline first — it seeds honest starting ratings so practice can target your edge.",
        evidence: {},
      });
      return;
    }

    const weakest = [...conceptState.entries()].sort((a, b) => a[1].rating - b[1].rating)[0];
    const conceptId = weakest?.[0] ?? "arrays_hashing";

    const unsolved = problemFixtures.filter((p) => !getProblemUserState(p.problemVersionId).solved);
    const forceGenerating = req.query.mock === "generating";

    if (forceGenerating || unsolved.length === 0) {
      res.json({
        problem: null,
        generating: {
          job_id: "job_mock_generate",
          concept_id: conceptId,
          target_rating: Math.round(weakest?.[1].rating ?? 1200),
          reason: `${conceptId} is your weakest concept. Nothing verified is left in that range, so a new problem is being generated and verified for you.`,
        },
        needs_baseline: false,
        rationale: "Generating your next problem.",
        evidence: { concept: conceptId },
      });
      return;
    }

    const targetRating = weakest?.[1].rating ?? 1200;
    const chosen = [...unsolved].sort(
      (a, b) => Math.abs(a.content.difficulty.rating - targetRating) - Math.abs(b.content.difficulty.rating - targetRating),
    )[0]!;

    res.json({
      problem: toPublicProblem({
        problemVersionId: chosen.problemVersionId,
        content: chosen.content,
        hintsTaken: getProblemUserState(chosen.problemVersionId).hintsTaken,
        revealConcepts: hasSolvedOrGivenUp(chosen.problemVersionId),
      }),
      generating: null,
      needs_baseline: false,
      rationale: `${conceptId} is your weakest concept (rating ${Math.round(targetRating)}); this problem sits in the 65-80% band.`,
      evidence: { concept: conceptId, candidate_count: unsolved.length },
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
      baseline_item_id: body.baseline_item_id ?? null,
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
      baselineItemId: body.baseline_item_id,
      activeMs: body.active_ms ?? 0,
    });

    if (body.baseline_item_id) {
      const item = baselineItems.get(body.baseline_item_id);
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

// --- GET /api/problems/:versionId/submissions/latest ---------------------------------------

app.get(
  "/api/problems/:versionId/submissions/latest",
  handle((req, res) => {
    const versionId = pparam(req.params.versionId);
    const latest = [...submissions.values()]
      .filter((s) => s.problemVersionId === versionId)
      .sort((a, b) => new Date(b.row.created_at).getTime() - new Date(a.row.created_at).getTime())[0];
    res.json({ submission: latest?.row ?? null });
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

    const inFlight = [...submissions.values()].some(
      (s) => s.mode === "submit" && s.problemVersionId === versionId && s.row.status !== "completed" && s.row.status !== "cancelled",
    );
    if (inFlight) {
      res.status(409).json({
        error: { code: "conflict", message: "A submission for this problem is still being judged — wait for it to finish before giving up." },
        correlation_id: res.getHeader("x-correlation-id"),
      });
      return;
    }

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

    if (body.baseline_item_id) {
      const item = baselineItems.get(body.baseline_item_id);
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

// Mirrors the real `GET /api/progress` shape (apps/api/src/routes/progress.ts) exactly — field
// names here used to drift from it (`solves_by_difficulty` vs real `solve_bands`, `id` vs real
// `concept_id`, etc.), which is exactly the class of bug this endpoint's own web consumer
// (Progress.tsx) was silently broken by (QA-PLAN.md §1.4): everything here shipped green against
// this mock while rendering "No submissions yet" / duplicate-key errors / "due —" against the
// real API.
app.get(
  "/api/progress",
  handle((_req, res) => {
    const now = Date.now();
    const concepts = CONCEPTS.map((c) => {
      const cs = conceptState.get(c.id)!;
      return {
        concept_id: c.id,
        name: c.name,
        rating: Math.round(cs.rating),
        uncertainty: Math.round(cs.uncertainty),
        attempts: cs.attempts,
        solves: cs.solves,
        unassisted_solves: cs.unassisted_solves,
        skips: cs.skips,
        current_streak: cs.current_streak,
        best_streak: cs.best_streak,
        last_practiced_at: cs.last_practiced_at,
        next_review_at: cs.next_review_at,
        trend: cs.solves > cs.attempts / 2 ? "up" : cs.attempts > 0 ? "flat" : "flat",
      };
    });

    const reviewsDue = CONCEPTS.map((c) => {
      const cs = conceptState.get(c.id)!;
      if (!cs.next_review_at) return null;
      const dueAtMs = new Date(cs.next_review_at).getTime();
      if (dueAtMs > now) return null;
      return { concept_id: c.id, days_overdue: (now - dueAtMs) / 86_400_000, state: cs };
    }).filter((r): r is NonNullable<typeof r> => r !== null);

    const submissionRows = [...submissions.values()].filter((s) => s.mode === "submit" && s.row.status === "completed");
    const byBand = new Map<number, { solved_without_hints: number; solved_with_hints: number; attempts: number }>();
    for (const s of submissionRows) {
      const fixture = problemsById.get(s.problemVersionId);
      const band = fixture ? Math.floor(fixture.content.difficulty.rating / 200) * 200 : 0;
      const entry = byBand.get(band) ?? { solved_without_hints: 0, solved_with_hints: 0, attempts: 0 };
      entry.attempts += 1;
      if (s.row.verdict === "accepted") {
        const hinted = getProblemUserState(s.problemVersionId).hintsTaken.length > 0;
        if (hinted) entry.solved_with_hints += 1;
        else entry.solved_without_hints += 1;
      }
      byBand.set(band, entry);
    }
    const solveBands = [...byBand.entries()]
      .sort(([a], [b]) => a - b)
      .map(([band, entry]) => ({ band, ...entry }));

    const activeMsSamples = submissionRows.map((s) => s.activeMs).filter((n) => n > 0).sort((a, b) => a - b);
    const medianActiveMs = activeMsSamples.length
      ? activeMsSamples[Math.floor(activeMsSamples.length / 2)]!
      : 0;

    const errorCounts = new Map<string, number>();
    for (const cs of conceptState.values()) {
      for (const [k, v] of Object.entries(cs.error_counts)) errorCounts.set(k, (errorCounts.get(k) ?? 0) + v);
    }
    const errorCategories = [...errorCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .map(([kind, count]) => ({ kind, count }));

    const highestUnassisted = problemFixtures
      .filter((p) => getProblemUserState(p.problemVersionId).solved && getProblemUserState(p.problemVersionId).hintsTaken.length === 0)
      .sort((a, b) => b.content.difficulty.rating - a.content.difficulty.rating)[0];

    res.json({
      concepts,
      reviews_due: reviewsDue,
      stats: {
        solve_bands: solveBands,
        error_categories: errorCategories,
        median_active_ms: medianActiveMs,
      },
      records: {
        highest_unassisted_difficulty_solved: highestUnassisted?.content.difficulty.rating ?? null,
        best_comparable_time_improvement: null,
      },
      history: [...learningEvents].reverse().slice(0, 20),
    });
  }),
);

// --- GET /api/system/stats -----------------------------------------------------------------

// Mirrors the real `GET /api/system/stats` shape (apps/api/src/routes/system.ts /
// @leetmind/queue's `Queue.stats()`) — this used to be its own dialect entirely
// (`queue.depth`/`by_kind`/`wait_p50_ms`, flat `verdicts`/`buffer_depth`/`generation_pass_rate`
// maps, a single `model_runs` object) and every one of those shapes rendered garbage against the
// real API (QA-PLAN.md §1.5): "0 / 0 / 0 ms", literal "window × 0" badges, "0% / by_stage".
app.get(
  "/api/system/stats",
  handle((_req, res) => {
    const jitter = () => Math.round(Math.random() * 3);
    const verdictCounts = new Map<string, number>();
    for (const s of submissions.values()) {
      if (s.row.verdict) verdictCounts.set(s.row.verdict, (verdictCounts.get(s.row.verdict) ?? 0) + 1);
    }

    const bufferByBand = new Map<string, { concept_id: string; band: number; count: number }>();
    for (const p of problemFixtures) {
      const conceptId = p.content.concepts[0]!.id;
      const band = Math.floor(p.content.difficulty.rating / 200) * 200;
      const key = `${conceptId}:${band}`;
      const entry = bufferByBand.get(key) ?? { concept_id: conceptId, band, count: 0 };
      entry.count += 1;
      bufferByBand.set(key, entry);
    }

    res.json({
      queue: {
        kinds: [
          { kind: "judge", counts: { queued: jitter() }, oldest_queued_age_ms: jitter() * 1000 },
          { kind: "verify", counts: { queued: jitter() }, oldest_queued_age_ms: jitter() * 1000 },
          { kind: "generate", counts: { queued: jitter() }, oldest_queued_age_ms: jitter() * 1000 },
        ],
        wait_time_ms: { p50: 120 + jitter() * 10, p95: 480 + jitter() * 20 },
        dead_count: 0,
        recent_dead: [],
        lease_recovery: { recovered: 0, redead: 0 },
      },
      workers: [
        { worker_id: "judge-mock-1", kind: "judge", last_seen_at: new Date().toISOString(), stale: false },
        { worker_id: "content-mock-1", kind: "content", last_seen_at: new Date(Date.now() - 4000).toISOString(), stale: false },
      ],
      verdicts: { window: "24h", counts: [...verdictCounts.entries()].map(([verdict, count]) => ({ verdict, count })) },
      buffer_depth: { by_concept_band: [...bufferByBand.values()] },
      generation_pass_rate: {
        by_stage: [
          { stage: "schema", passed: 94, total: 100 },
          { stage: "compile", passed: 91, total: 100 },
          { stage: "differential", passed: 83, total: 100 },
          { stage: "boundary", passed: 78, total: 100 },
          { stage: "examples", passed: 98, total: 100 },
          { stage: "mutation", passed: 71, total: 100 },
        ],
      },
      model_runs: [{ kind: "generate", invoker: "claude", runs: 12, avg_duration_ms: 8200, avg_cost_usd: 0.043, total_cost_usd: 0.516 }],
      dead_jobs: [],
    });
  }),
);

// --- GET /api/me --------------------------------------------------------------------------------

app.get(
  "/api/me",
  handle((_req, res) => {
    res.json({
      user: { id: USER_ID, handle: "local", email: null },
      has_baseline: baselineState.everStarted,
    });
  }),
);

// --- POST /api/baseline/start --------------------------------------------------------------------

app.post(
  "/api/baseline/start",
  handle((_req, res) => {
    res.json({ baseline: buildBaseline() });
  }),
);

// --- GET /api/baseline/current -------------------------------------------------------------------

app.get(
  "/api/baseline/current",
  handle((_req, res) => {
    // Same adaptive side effect the real endpoint has: reading it is what appends the next probe.
    res.json({ baseline: advanceMockBaseline() });
  }),
);

// --- POST /api/baseline-items/:id/skip -----------------------------------------------------------

app.post(
  "/api/baseline-items/:id/skip",
  handle((req, res) => {
    const item = baselineItems.get(pparam(req.params.id));
    if (!item) return notFound(res, `no baseline item ${pparam(req.params.id)}`);
    const parsed = SkipBaselineItemRequest.safeParse(req.body);
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

// --- POST /api/baseline-items/:id/start ----------------------------------------------------------

app.post(
  "/api/baseline-items/:id/start",
  handle((req, res) => {
    const item = baselineItems.get(pparam(req.params.id));
    if (!item) return notFound(res, `no baseline item ${pparam(req.params.id)}`);
    // Mirrors the real API's guard (packages/db/src/baseline.ts startBaselineItem): only
    // `pending -> active`. Unconditionally setting `active` un-completed already-terminal items
    // (solved/skipped/gave_up) every time the client revisited via the baseline list's "Review"
    // link — the item mount effect fires this unconditionally, assuming idempotence.
    if (item.state === "pending") {
      item.state = "active";
      item.started_at = item.started_at ?? new Date().toISOString();
    }
    res.json({ item });
  }),
);

// --- POST /api/mock/reset-baseline ---------------------------------------------------------------
// Mock-only: puts the fixture back into the never-onboarded state so the first-run flow can be
// driven from a browser (or an e2e run) without restarting the process.

app.post(
  "/api/mock/reset-baseline",
  handle((_req, res) => {
    resetBaseline();
    res.json({ ok: true });
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

// Exported (rather than only ever `app.listen()`-ed below) so mock/server.test.ts can drive it
// in-process with supertest — no port binding, and no risk of colliding with an already-running
// dev instance.
export { app };

// Only bind a real port when this file is run directly (`pnpm mock` / `pnpm dev:mock`), not when
// it's imported as a module (by the test file above).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const PORT = Number(process.env.MOCK_PORT ?? process.env.VITE_API_BASE?.split(":").pop() ?? 8080);
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[mock-api] listening on http://localhost:${PORT} (${problemFixtures.length} fixture problems)`);
  });
}
