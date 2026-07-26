// GET /api/practice/next — the one endpoint the whole app runs on.
//
// The contract is deliberately one endpoint rather than a session object: practice has no
// beginning and no end, so there is nothing to persist between problems. Each call answers exactly
// one question — "what should this user do right now?" — with one of two shapes:
//
//   problem     something to work on now (possibly a teaching problem, or a scheduled follow-up)
//   generating  the approved pool can't cover that edge, so a generate job is in flight
//
// There is deliberately **no** "you must do something else first" state. The `needs_baseline` gate
// that used to sit at the top of this handler is gone: a brand-new user's very first request
// returns a problem. Calibration still happens — the cold-start stepping rule
// (packages/learner/src/coldstart.ts) drives the first few problems — but it never announces
// itself, and there is nothing to opt into or finish.
//
// Resolution order, highest priority first. Each tier answers a question the tiers below it cannot:
//
//   1. open teaching episode — the user was shown a solution and has not written it out yet.
//      Blocks everything: the whole point of teaching mode is that you cannot walk away from it.
//   2. due follow-up        — a debt from a past teaching episode (reinforce now, transfer later).
//   3. cold start           — fewer than COLD_START_PROBLEM_COUNT attempts, so ratings mean little
//                             and the stepping rule finds the level faster than Elo can.
//   4. normal selection     — weakest evidenced concept, scored candidates, target success band.
//                             May itself decide to *teach* rather than test (two failures in a row).
//
// And on every successful serve it tops the buffer up in the background, so the common case never
// reaches the `generating` state at all — the user only ever waits on generation if they out-run
// the content plane.
import type { FastifyInstance } from "fastify";
import {
  dueFollowup,
  getProblemVersion,
  insertHintEvent,
  listApprovedUnattempted,
  query,
  withTransaction,
  type ProblemShape,
  type ProblemVersionRow,
  type ScheduledFollowupRow,
} from "@leetmind/db";
import { GenerationRequestSchema, newId } from "@leetmind/shared";
import {
  COLD_START_PROBLEM_COUNT,
  nextColdStartStep,
  selectNext,
  targetBand,
  type CandidateProblem,
  type ColdStartHistoryEntry,
  type ConceptState,
} from "@leetmind/learner";
import type { Deps } from "../deps.js";
import { buildPublicProblem } from "../mappers/publicProblem.js";
import {
  defaultConceptState,
  findCandidateNear,
  loadConceptStates,
  toPoolCandidate,
} from "../lib/candidatePool.js";
import {
  openTeachingEpisode,
  queueFollowUps,
  resolveFollowupProblem,
  shouldTeachConcept,
} from "../lib/teaching.js";

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
 * at all.
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
    why: `Starting at the foundations (${first}).`,
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
 * Problem versions this user saw during a baseline, back when baselines existed.
 *
 * The baseline product surface is gone, but its tables are retained as read-only history
 * (migration 007) and a long-lived local install can still hold rows here. A baseline skip wrote no
 * submission, so `listApprovedUnattempted` would happily re-offer a problem the user had already
 * marked "I haven't learned this yet" — which is both a bad experience and bad evidence, since the
 * answer to "can you do this?" is already recorded. Cheap to keep, and it costs nothing on a fresh
 * install where the tables are empty.
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

/**
 * This user's resolved attempts so far, oldest first, in the shape `nextColdStartStep` wants.
 *
 * Derived from `learning_events` rather than persisted as a cold-start session, which is what lets
 * the cold start have no product surface at all: there is no row to create on first visit, nothing
 * to resume, and nothing left dangling if the user closes the tab three problems in. The phase is
 * simply "this user has fewer than N learning events", which is true or false on every request
 * without anything having been set up.
 */
async function coldStartHistory(userId: string): Promise<ColdStartHistoryEntry[]> {
  // The primary concept comes from a scalar subquery rather than a join, for two reasons. A join
  // would DROP any event whose problem has since been retired or lost its concept rows — leaving
  // that user permanently in the cold start, being handed calibration problems forever. And a join
  // would DOUBLE-count an event if a problem ever carried two primary concepts (the content schema
  // forbids it; the table does not).
  const rows = await query<{ concept_id: string | null; kind: string; outcome: number }>(
    `select (select pc.concept_id
               from problem_concepts pc
              where pc.problem_version_id = le.problem_version_id
                and pc.role = 'primary'
              limit 1) as concept_id,
            le.kind,
            le.outcome
       from learning_events le
      where le.user_id = $1
        and le.kind in ('submission', 'give_up', 'skip')
      order by le.created_at asc
      limit $2`,
    [userId, COLD_START_PROBLEM_COUNT],
  );

  return rows.map((r) => ({
    // An unattributable event still counts toward "how far into the cold start are we" and still
    // moves the difficulty target; it just can't mark a concept as probed. The empty string never
    // matches a real concept id, which is exactly the behaviour wanted.
    concept_id: r.concept_id ?? "",
    outcome:
      r.kind === "submission" && r.outcome > 0.2 ? "solved" : r.kind === "skip" ? "skipped" : "failed",
  }));
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

/** The primary concept of a problem version, which is what every teaching/follow-up decision is
 * attributed to. Falls back to the heaviest concept when no role is marked primary. */
function primaryConceptOf(row: ProblemVersionRow): { id: string; rating: number } | null {
  const content = row.content as {
    concepts?: Array<{ id?: unknown; weight?: unknown; role?: unknown }>;
  };
  const concepts = Array.isArray(content?.concepts) ? content.concepts : [];
  const usable = concepts.filter(
    (c): c is { id: string; weight: number; role?: string } =>
      typeof c?.id === "string" && typeof c?.weight === "number",
  );
  if (usable.length === 0) return null;

  const primary =
    usable.find((c) => c.role === "primary") ??
    usable.reduce((best, c) => (c.weight > best.weight ? c : best));
  return { id: primary.id, rating: row.difficulty_rating };
}

export function registerPracticeRoutes(fastify: FastifyInstance, deps: Deps): void {
  fastify.get("/api/practice/next", async (request, reply) => {
    const userId = request.userId;
    const correlationId = request.correlationId;
    const now = new Date();

    // --- 1. an open teaching episode blocks everything ------------------------------------------
    //
    // The user has been shown a full solution and has not typed it out yet. Serving anything else
    // here would make the write-it-out step optional, which is the one thing teaching mode cannot
    // allow: reading a solution and moving straight on is precisely the failure mode it exists to
    // prevent.
    const episode = await openTeachingEpisode(userId);
    if (episode) {
      const row = await getProblemVersion(episode.problem_version_id);
      if (row) {
        const problem = await buildPublicProblem(row, userId);
        reply.send({
          problem,
          generating: null,
          teaching: {
            reason: episode.reason,
            trigger: episode.trigger,
            transcribed: false,
          },
          followup: null,
          rationale: episode.reason,
          evidence: { teaching: true, trigger: episode.trigger },
        });
        return;
      }
      // Problem row vanished (retired out from under an open episode). Fall through rather than
      // dead-ending the user on an episode they can never close.
      deps.logger.warn(
        { problemVersionId: episode.problem_version_id },
        "open teaching episode references a missing problem version — falling through",
      );
    }

    const [states, conceptRows, attemptedRows, alreadySeen, pendingFollowup] = await Promise.all([
      loadConceptStates(userId),
      query<{ id: string }>("select id from concepts order by sort_order asc, id asc"),
      query<{ concept_id: string }>(
        "select concept_id from user_concept_state where user_id = $1 and attempts > 0",
        [userId],
      ),
      seenInBaseline(userId),
      dueFollowup(userId, now),
    ]);

    const orderedConceptIds = conceptRows.map((c) => c.id);

    // --- 2. a due follow-up outranks ordinary selection -----------------------------------------
    //
    // Ahead of normal scoring because a follow-up is a debt with a *reason attached* — the user was
    // taught something and this is the problem that checks whether it took. `scoreCandidate` has no
    // way to know that; left to itself it would drift back to whatever concept is numerically
    // weakest and the teaching episode would quietly go unmeasured.
    if (pendingFollowup) {
      const row = await resolveFollowupProblem(userId, pendingFollowup, getProblemVersion);
      if (row) {
        const problem = await buildPublicProblem(row, userId);
        reply.send({
          problem,
          generating: null,
          teaching: null,
          followup: followupContext(pendingFollowup),
          rationale: pendingFollowup.rationale,
          evidence: {
            followup_kind: pendingFollowup.kind,
            concept: pendingFollowup.concept_id,
            target_rating: pendingFollowup.target_rating,
            shape_match: pendingFollowup.shape_match,
          },
        });
        return;
      }

      // Nothing in the pool fits the debt. Commission it rather than dropping it — an unservable
      // follow-up is exactly the case the generator exists for.
      const generation = await ensureGeneration(deps, {
        userId,
        conceptId: pendingFollowup.concept_id,
        targetRating: pendingFollowup.target_rating,
        correlationId,
        priority: PRACTICE_GENERATE_PRIORITY,
      });
      reply.send({
        problem: null,
        generating: {
          job_id: generation.jobId,
          concept_id: pendingFollowup.concept_id,
          target_rating: pendingFollowup.target_rating,
          reason: `${pendingFollowup.rationale} Nothing suitable is left in the pool, so one is being written for you.`,
        },
        teaching: null,
        followup: followupContext(pendingFollowup),
        rationale: "Generating your follow-up problem.",
        evidence: { followup_kind: pendingFollowup.kind, concept: pendingFollowup.concept_id },
      });
      return;
    }

    // --- 3. cold start ---------------------------------------------------------------------------
    //
    // Fewer than COLD_START_PROBLEM_COUNT resolved attempts: the ratings are all still at their
    // seeded defaults, so `scoreCandidate`'s "weakest concept" is meaningless (everything ties) and
    // its target band is drawn around a number nobody has measured. The stepping rule finds the
    // right neighbourhood in about two problems; Elo, capped at SWING_CAP per problem, takes six.
    const history = await coldStartHistory(userId);
    if (history.length < COLD_START_PROBLEM_COUNT) {
      const step = nextColdStartStep(orderedConceptIds, history);
      if (step.concept_id) {
        const row = await findCandidateNear(userId, step.concept_id, step.target_rating, alreadySeen);
        if (row) {
          const problem = await buildPublicProblem(row, userId);
          void topUp(deps, userId, step.concept_id, step.target_rating, correlationId);
          reply.send({
            problem,
            generating: null,
            teaching: null,
            followup: null,
            rationale: step.rationale,
            evidence: {
              cold_start: true,
              problems_in: history.length,
              of: COLD_START_PROBLEM_COUNT,
              concept: step.concept_id,
              target_rating: step.target_rating,
            },
          });
          return;
        }

        const generation = await ensureGeneration(deps, {
          userId,
          conceptId: step.concept_id,
          targetRating: step.target_rating,
          correlationId,
          priority: PRACTICE_GENERATE_PRIORITY,
        });
        reply.send({
          problem: null,
          generating: {
            job_id: generation.jobId,
            concept_id: step.concept_id,
            target_rating: step.target_rating,
            reason: "Writing your first problem — nothing verified is in the pool at that level yet.",
          },
          teaching: null,
          followup: null,
          rationale: "Generating your next problem.",
          evidence: { cold_start: true, concept: step.concept_id },
        });
        return;
      }
      // `step.concept_id === null` with a short history means the taxonomy ran out of unprobed
      // concepts, not that the cold start finished. Fall through to normal selection.
    }

    // --- 4. normal selection ---------------------------------------------------------------------
    const attempted = new Set(attemptedRows.map((r) => r.concept_id));
    const target = chooseTarget(states, orderedConceptIds, attempted);

    if (!target) {
      reply.send({
        problem: null,
        generating: null,
        teaching: null,
        followup: null,
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
        teaching: null,
        followup: null,
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
        teaching: null,
        followup: null,
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

    const picked = selectNext(candidates as CandidateProblem[], scoringStates, now);
    const versionRow = candidateRows.find((r) => r.id === picked.candidate.problem_version_id);
    if (!versionRow) {
      reply.send({
        problem: null,
        generating: null,
        teaching: null,
        followup: null,
        rationale: "Selection produced no matching candidate.",
        evidence: {},
      });
      return;
    }

    // --- teach instead of test, when the evidence says another problem won't help ----------------
    //
    // Checked here, after a concrete problem is in hand, because opening a teaching episode means
    // revealing *this problem's* editorial and owing follow-ups against *this problem's* rating —
    // none of which can be recorded against a concept alone.
    const teachDecision = await shouldTeachConcept(userId, target.conceptId);
    if (teachDecision.teach) {
      const primary = primaryConceptOf(versionRow);
      if (primary) {
        // Records the editorial reveal WITHOUT the give-up route's mastery penalty. The user has
        // not failed this problem — they failed the two before it, and those already cost them.
        // Charging again for being taught would punish the intervention.
        await withTransaction((client) =>
          insertHintEvent(client, {
            id: newId(),
            user_id: userId,
            problem_version_id: versionRow.id,
            level: "editorial",
          }),
        );
        await queueFollowUps({
          userId,
          conceptId: primary.id,
          problemVersionId: versionRow.id,
          problemRating: primary.rating,
          originShape: versionRow.shape as ProblemShape | null,
          trigger: "consecutive_failures",
          now,
        });

        const problem = await buildPublicProblem(versionRow, userId);
        reply.send({
          problem,
          generating: null,
          teaching: {
            reason: teachDecision.reason,
            trigger: "consecutive_failures",
            transcribed: false,
          },
          followup: null,
          rationale: teachDecision.reason,
          evidence: { teaching: true, trigger: "consecutive_failures", concept: primary.id },
        });
        return;
      }
    }

    const problem = await buildPublicProblem(versionRow, userId);

    if (candidateRows.length < PRACTICE_BUFFER_WATERMARK) {
      void topUp(deps, userId, target.conceptId, target.targetRating, correlationId);
    }

    const rationale = widened
      ? `${picked.rationale} (Search widened past the ideal band — the pool near your level is thin.)`
      : picked.rationale;

    reply.send({
      problem,
      generating: null,
      teaching: null,
      followup: null,
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

  /** Background pool top-up. Fire-and-forget on purpose: the user already has their problem, and
   * making them wait on an enqueue would defeat the point. A failure here is logged and otherwise
   * invisible — the next request simply tries again. */
  function topUp(
    d: Deps,
    userId: string,
    conceptId: string,
    targetRating: number,
    correlationId?: string,
  ): void {
    void ensureGeneration(d, {
      userId,
      conceptId,
      targetRating,
      correlationId,
      priority: PRACTICE_GENERATE_PRIORITY,
    }).catch((err: unknown) => {
      d.logger.warn({ err, concept: conceptId }, "background practice top-up failed");
    });
  }
}

function followupContext(row: ScheduledFollowupRow) {
  return {
    id: row.id,
    kind: row.kind,
    concept_id: row.concept_id,
    rationale: row.rationale,
  };
}
