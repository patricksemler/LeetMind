// GET /api/practice/next — the iterative autogenerate loop that replaces the workout ladder.
//
// The contract is deliberately one endpoint rather than a session object: practice has no
// beginning and no end, so there is nothing to persist between problems. Each call answers exactly
// one question — "what should this user do right now?" — with one of three shapes:
//
//   needs_baseline  no baseline has ever been taken, so there are no honest ratings to target
//   problem         a verified, approved, unattempted problem at the edge of their ability
//   generating      the approved pool can't cover that edge, so a generate job is in flight
//
// The third case is what makes the mode *autogenerate* rather than merely adaptive: instead of
// telling the user "nothing available, come back later" (which is what `GET /api/problems/next`
// did), the API commissions the missing problem and reports the wait. And on every successful
// serve it also tops the buffer up in the background, so the common case never reaches that state
// at all — the user only ever waits on generation if they out-run the content plane.
import type { FastifyInstance } from "fastify";
import {
  getLatestBaselineSession,
  listApprovedUnattempted,
  query,
  withTransaction,
  type ProblemVersionRow,
} from "@leetmind/db";
import { GenerationRequestSchema, newId } from "@leetmind/shared";
import { selectNext, targetBand, type CandidateProblem, type ConceptState } from "@leetmind/learner";
import type { Deps } from "../deps.js";
import { buildPublicProblem } from "../mappers/publicProblem.js";
import { defaultConceptState, loadConceptStates, toPoolCandidate } from "../lib/candidatePool.js";

/** Progressive rating-band widenings tried, in order, before concluding the pool can't serve the
 * user's current edge and generation is needed. */
const WIDEN_STEPS = [0, 150, 300, 600];
const CANDIDATE_LIMIT = 25;

/** How many approved-and-unattempted problems the user's current band should hold before the
 * background top-up stops firing. Mirrors `BUFFER_LOW_WATERMARK` in the Python replenishment
 * worker — this is the same idea applied to the one cell the user is actually standing in, which
 * demand prediction can lag behind after a run of solves. */
const PRACTICE_BUFFER_WATERMARK = 3;

/** Must track content/leetmind_content/generation/prompts/v1.py's `PROMPT_VERSION` — the content
 * plane is a separate Python codebase apps/api may not import, so this is a documented
 * cross-language constant, not a guess. Kept in step with routes/generate.ts. */
const PROMPT_VERSION = "v1";

/** Elevated above the replenishment worker's default `generate` priority (100) but below the
 * manual `/api/generate-now` escape hatch (1): a user actively waiting on this problem should jump
 * ahead of speculative background replenishment. */
const PRACTICE_GENERATE_PRIORITY = 20;

interface PracticeTarget {
  conceptId: string;
  targetRating: number;
  state: ConceptState;
  /** Human-readable reason this concept was chosen — surfaced to the user verbatim. */
  why: string;
}

/**
 * Picks the concept this user should be working on right now: the weakest one they have actual
 * evidence for, falling back to the taxonomy's foundational order for a profile with no evidence
 * at all (someone who skipped their entire baseline).
 *
 * "Weakest" is by rating alone rather than by `scoreCandidate`'s full blend, because this decision
 * happens *before* there are candidates to score — it chooses the band to search, and
 * `selectNext` then does the real scoring within it.
 */
export function chooseTarget(
  states: Record<string, ConceptState>,
  orderedConceptIds: string[],
  attemptedConceptIds: Set<string>,
): PracticeTarget | null {
  const evidenced = orderedConceptIds
    .filter((id) => attemptedConceptIds.has(id) && states[id])
    .map((id) => ({ id, state: states[id]! }))
    .sort((a, b) => a.state.rating - b.state.rating);

  const chosen = evidenced[0];
  if (chosen) {
    const band = targetBand(chosen.state);
    return {
      conceptId: chosen.id,
      targetRating: Math.round(band.ideal),
      state: chosen.state,
      why: `${chosen.id} is your weakest concept (rating ${Math.round(chosen.state.rating)}).`,
    };
  }

  // No evidence anywhere — start at the foundations rather than picking arbitrarily.
  const first = orderedConceptIds[0];
  if (!first) return null;
  const state = states[first] ?? defaultConceptState(first);
  const band = targetBand(state);
  return {
    conceptId: first,
    targetRating: Math.round(band.ideal),
    state,
    why: `Starting at the foundations (${first}) — your baseline left no evidence to target yet.`,
  };
}

/** The 200-wide band cell a rating falls in, matching the replenishment worker's cell scheme. */
function bandOf(rating: number): number {
  return Math.floor(rating / 200) * 200;
}

/**
 * At most one in-flight generation per (user, concept, band) cell.
 *
 * The key deliberately carries a monotonically increasing `slot` rather than being a single fixed
 * string: `enqueue`'s `on conflict (idempotency_key) do nothing` is permanent, so a fixed key would
 * no-op forever the moment its first job finished — the cell could never be generated for again.
 * This mirrors the slot scheme the Python replenishment worker already uses (QA-PLAN.md §2.11
 * documents the plateau a fixed range caused there), and the in-flight check below is what keeps a
 * client polling every two seconds from enqueuing a job per poll.
 */
async function findInFlightGeneration(prefix: string): Promise<{ id: string } | null> {
  const rows = await query<{ id: string }>(
    `select id from jobs
      where kind = 'generate'
        and status in ('queued', 'leased')
        and idempotency_key like $1
      order by created_at desc
      limit 1`,
    [`${prefix}%`],
  );
  return rows[0] ?? null;
}

async function attemptCount(prefix: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `select count(*) as n from jobs where kind = 'generate' and idempotency_key like $1`,
    [`${prefix}%`],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Problem versions this user already saw during a baseline.
 *
 * `listApprovedUnattempted` excludes by `submissions` only, and a baseline skip writes no
 * submission — so without this, the very first thing practice offered after onboarding was the
 * problem the user had just marked "I haven't learned this yet" (confirmed live). Re-serving it
 * immediately is both a bad experience and bad evidence: the answer to "can you do this?" is
 * already recorded.
 */
async function seenInBaseline(userId: string): Promise<Set<string>> {
  const rows = await query<{ problem_version_id: string }>(
    `select bi.problem_version_id
       from baseline_items bi
       join baseline_sessions bs on bs.id = bi.baseline_session_id
      where bs.user_id = $1`,
    [userId],
  );
  return new Set(rows.map((r) => r.problem_version_id));
}

/** Recent titles for this concept, fed back as `similarity_exclusions` so generation doesn't
 * repeat content the user has just seen. Same signal the replenishment worker uses. */
async function recentTitles(conceptId: string, limit = 10): Promise<string[]> {
  const rows = await query<{ title: string }>(
    `select pv.title
       from problem_versions pv
       join problem_concepts pc on pc.problem_version_id = pv.id
      where pc.concept_id = $1
        and pv.state in ('candidate', 'verifying', 'approved')
      order by pv.created_at desc
      limit $2`,
    [conceptId, limit],
  );
  return rows.map((r) => r.title);
}

export interface EnsureGenerationResult {
  jobId: string | null;
  enqueued: boolean;
}

/**
 * Ensures a `generate` job is in flight for this cell, without ever stacking duplicates. Returns
 * the existing job when one is already queued or leased.
 */
export async function ensureGeneration(
  deps: Deps,
  opts: {
    userId: string;
    conceptId: string;
    targetRating: number;
    correlationId?: string;
    priority: number;
  },
): Promise<EnsureGenerationResult> {
  const prefix = `generate:practice:${opts.userId}:${opts.conceptId}:${bandOf(opts.targetRating)}:`;

  const inFlight = await findInFlightGeneration(prefix);
  if (inFlight) return { jobId: inFlight.id, enqueued: false };

  const slot = await attemptCount(prefix);
  const generationRequest = GenerationRequestSchema.parse({
    concepts: [{ id: opts.conceptId, weight: 1 }],
    target_rating: opts.targetRating,
    rating_tolerance: 100,
    expected_minutes: [5, 20],
    required_patterns: [],
    forbidden_patterns: [],
    similarity_exclusions: await recentTitles(opts.conceptId),
    allow_types: [],
    prompt_version: PROMPT_VERSION,
  });

  const job = await withTransaction((client) =>
    deps.queue.enqueue(client, {
      kind: "generate",
      payload: { request: generationRequest, correlation_id: opts.correlationId },
      priority: opts.priority,
      idempotencyKey: `${prefix}${slot}`,
      correlationId: opts.correlationId,
    }),
  );

  // `null` means another request won the race on this exact key between the in-flight check and
  // the insert. Re-read rather than reporting "no generation happening", which would make the
  // client show an error state for a job that is in fact running.
  if (!job) {
    const raced = await findInFlightGeneration(prefix);
    return { jobId: raced?.id ?? null, enqueued: false };
  }
  return { jobId: job.id, enqueued: true };
}

export function registerPracticeRoutes(fastify: FastifyInstance, deps: Deps): void {
  fastify.get("/api/practice/next", async (request, reply) => {
    const userId = request.userId;
    const correlationId = request.correlationId;

    // Gate on the baseline. Practice targets "the edge of your ability", which is meaningless
    // before anything has measured it — so a user with no baseline is routed to take one rather
    // than being served problems against flat 1200 defaults.
    const baseline = await getLatestBaselineSession(userId);
    if (!baseline) {
      reply.send({
        problem: null,
        generating: null,
        needs_baseline: true,
        rationale: "Take the short baseline first — it seeds honest starting ratings so practice can target your edge.",
        evidence: {},
      });
      return;
    }

    const [states, conceptRows, attemptedRows, alreadySeen] = await Promise.all([
      loadConceptStates(userId),
      query<{ id: string }>("select id from concepts order by sort_order asc, id asc"),
      query<{ concept_id: string }>(
        "select concept_id from user_concept_state where user_id = $1 and attempts > 0",
        [userId],
      ),
      seenInBaseline(userId),
    ]);

    const orderedConceptIds = conceptRows.map((c) => c.id);
    const attempted = new Set(attemptedRows.map((r) => r.concept_id));
    const target = chooseTarget(states, orderedConceptIds, attempted);

    if (!target) {
      reply.send({
        problem: null,
        generating: null,
        needs_baseline: false,
        rationale: "The concept taxonomy is empty — run `pnpm db:migrate` to seed it.",
        evidence: {},
      });
      return;
    }

    const band = targetBand(target.state);
    let candidateRows: ProblemVersionRow[] = [];
    let widened = false;
    let usedWindow: { min: number; max: number } | null = null;

    for (const [i, pad] of WIDEN_STEPS.entries()) {
      const window = { min: Math.floor(band.min - pad), max: Math.ceil(band.max + pad) };
      const rows = await listApprovedUnattempted(userId, {
        conceptId: target.conceptId,
        minRating: window.min,
        maxRating: window.max,
        limit: CANDIDATE_LIMIT,
      });
      candidateRows = rows.filter((r) => !alreadySeen.has(r.id));
      usedWindow = window;
      if (candidateRows.length > 0) {
        widened = i > 0;
        break;
      }
    }

    // Nothing for the target concept at any width. Rather than silently drifting to some other
    // concept the user isn't weakest at, commission the problem that's actually missing.
    if (candidateRows.length === 0) {
      const generation = await ensureGeneration(deps, {
        userId,
        conceptId: target.conceptId,
        targetRating: target.targetRating,
        correlationId,
        priority: PRACTICE_GENERATE_PRIORITY,
      });

      reply.send({
        problem: null,
        generating: {
          job_id: generation.jobId,
          concept_id: target.conceptId,
          target_rating: target.targetRating,
          reason: `${target.why} Nothing verified is left in that range, so a new problem is being generated and verified for you.`,
        },
        needs_baseline: false,
        rationale: "Generating your next problem.",
        evidence: { concept: target.conceptId, target_rating: target.targetRating, band },
      });
      return;
    }

    const candidates = candidateRows
      .map(toPoolCandidate)
      .filter((c): c is NonNullable<ReturnType<typeof toPoolCandidate>> => c !== null);

    if (candidates.length === 0) {
      reply.send({
        problem: null,
        generating: null,
        needs_baseline: false,
        rationale: "Approved problems exist but none have usable concept weights to select on.",
        evidence: { candidate_count: candidateRows.length },
      });
      return;
    }

    // `scoreCandidate` throws on a concept it has no state for, and a candidate may touch a
    // secondary concept this user has never been probed on.
    const scoringStates: Record<string, ConceptState> = { ...states };
    for (const c of candidates) {
      for (const w of c.concepts) {
        if (!scoringStates[w.id]) scoringStates[w.id] = defaultConceptState(w.id);
      }
    }

    const picked = selectNext(candidates as CandidateProblem[], scoringStates, new Date());
    const versionRow = candidateRows.find((r) => r.id === picked.candidate.problem_version_id);
    if (!versionRow) {
      reply.send({
        problem: null,
        generating: null,
        needs_baseline: false,
        rationale: "Selection produced no matching candidate.",
        evidence: {},
      });
      return;
    }

    const problem = await buildPublicProblem(versionRow, userId);

    // Background top-up. Fire-and-forget on purpose: the user already has their problem, and
    // making them wait on an enqueue would defeat the point. A failure here is logged and
    // otherwise invisible — the next request simply tries again.
    if (candidateRows.length < PRACTICE_BUFFER_WATERMARK) {
      void ensureGeneration(deps, {
        userId,
        conceptId: target.conceptId,
        targetRating: target.targetRating,
        correlationId,
        priority: PRACTICE_GENERATE_PRIORITY,
      }).catch((err: unknown) => {
        deps.logger.warn({ err, concept: target.conceptId }, "background practice top-up failed");
      });
    }

    const rationale = widened
      ? `${picked.rationale} (Search widened past the ideal band — the pool near your level is thin.)`
      : picked.rationale;

    reply.send({
      problem,
      generating: null,
      needs_baseline: false,
      rationale,
      evidence: {
        factors: picked.factors,
        score: picked.score,
        concept: target.conceptId,
        why_concept: target.why,
        widened,
        window: usedWindow,
        candidate_count: candidateRows.length,
        buffer_low: candidateRows.length < PRACTICE_BUFFER_WATERMARK,
      },
    });
  });
}
