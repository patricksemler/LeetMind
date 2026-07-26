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
import { newId } from "@leetmind/shared";
import {
  COLD_START_PROBLEM_COUNT,
  nextColdStartStep,
  selectNext,
  targetBand,
  type CandidateProblem,
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
import { chooseTarget, primaryConceptOf } from "../lib/practiceSelection.js";
import {
  coldStartHistory,
  ensureGeneration,
  PRACTICE_GENERATE_PRIORITY,
  seenInBaseline,
} from "../lib/practiceQueries.js";

/** Progressive rating-band widenings tried, in order, before concluding the pool can't serve the
 * user's current edge and generation is needed. */
const WIDEN_STEPS = [0, 150, 300, 600];
const CANDIDATE_LIMIT = 25;

/** How many approved-and-unattempted problems the user's current band should hold before the
 * background top-up stops firing. Mirrors `BUFFER_LOW_WATERMARK` in the Python replenishment
 * worker — this is the same idea applied to the one cell the user is actually standing in, which
 * demand prediction can lag behind after a run of solves. */
const PRACTICE_BUFFER_WATERMARK = 3;

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
