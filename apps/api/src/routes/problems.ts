import type { FastifyInstance } from "fastify";
import {
  getApprovedProblemVersion,
  listApprovedUnattempted,
  listConceptStates,
  type ProblemVersionRow,
  type UserConceptStateRow,
} from "@leetmind/db";
import { NextProblemQuery, notFound } from "@leetmind/shared";
import { selectNext, targetBand, type CandidateProblem, type ConceptState } from "@leetmind/learner";
import type { Deps } from "../deps.js";
import { buildPublicProblem, type PublicProblemWithNames } from "../mappers/publicProblem.js";
import { requireId } from "../server.js";

const DEFAULT_RATING = 1200;
const DEFAULT_UNCERTAINTY = 350;
/** Progressive rating-band widenings tried, in order, before giving up on "the ideal band". */
const WIDEN_STEPS = [0, 200, 400, 800];
const CANDIDATE_LIMIT = 25;

function defaultConceptState(conceptId: string): ConceptState {
  return {
    concept_id: conceptId,
    rating: DEFAULT_RATING,
    uncertainty: DEFAULT_UNCERTAINTY,
    last_practiced_at: null,
    next_review_at: null,
    review_interval_days: 1,
    review_ease: 2.5,
    review_reps: 0,
  };
}

function toCandidateProblem(row: ProblemVersionRow): CandidateProblem | null {
  const content = row.content as { concepts?: Array<{ id?: unknown; weight?: unknown }> };
  const rawConcepts = Array.isArray(content?.concepts) ? content.concepts : [];
  const concepts = rawConcepts
    .filter((c): c is { id: string; weight: number } => typeof c?.id === "string" && typeof c?.weight === "number")
    .map((c) => ({ id: c.id, weight: c.weight }));
  if (concepts.length === 0) return null;
  return { problem_version_id: row.id, difficulty_rating: row.difficulty_rating, concepts };
}

function averageRating(states: UserConceptStateRow[]): number {
  if (states.length === 0) return DEFAULT_RATING;
  return states.reduce((sum, s) => sum + s.rating, 0) / states.length;
}

export function registerProblemRoutes(fastify: FastifyInstance, deps: Deps): void {
  const userId = deps.config.singleUserId;

  fastify.get("/api/problems/next", async (request, reply) => {
    const parsedQuery = NextProblemQuery.parse(request.query);

    const conceptStateRows = await listConceptStates(userId);
    const stateMap: Record<string, ConceptState> = {};
    for (const row of conceptStateRows) stateMap[row.concept_id] = row;

    const searchCenter = parsedQuery.rating ?? averageRating(conceptStateRows);
    const band = targetBand({ rating: searchCenter });

    let candidateRows: ProblemVersionRow[] = [];
    let widened = false;
    let usedWindow: { min: number; max: number } | null = null;

    for (const [i, pad] of WIDEN_STEPS.entries()) {
      const window = { min: Math.floor(band.min - pad), max: Math.ceil(band.max + pad) };
      candidateRows = await listApprovedUnattempted(userId, {
        conceptId: parsedQuery.concept,
        minRating: window.min,
        maxRating: window.max,
        limit: CANDIDATE_LIMIT,
      });
      usedWindow = window;
      if (candidateRows.length > 0) {
        widened = i > 0;
        break;
      }
    }

    // Still nothing anywhere near the band: fall back to the entire approved/unattempted pool
    // (optionally still scoped to the requested concept) rather than failing.
    if (candidateRows.length === 0) {
      candidateRows = await listApprovedUnattempted(userId, {
        conceptId: parsedQuery.concept,
        limit: CANDIDATE_LIMIT,
      });
      widened = true;
      usedWindow = null;
    }

    if (candidateRows.length === 0) {
      reply.send({
        problem: null,
        rationale:
          "No approved, unattempted problems are available yet" +
          (parsedQuery.concept ? ` for ${parsedQuery.concept}` : "") +
          ". The content pool may not be seeded or generated yet — try POST /api/generate-now, or wait for replenishment.",
        evidence: { candidate_count: 0, concept: parsedQuery.concept ?? null, band },
      });
      return;
    }

    const candidates = candidateRows
      .map(toCandidateProblem)
      .filter((c): c is CandidateProblem => c !== null);

    if (candidates.length === 0) {
      reply.send({
        problem: null,
        rationale: "Approved problems exist but none have usable concept weights to select on.",
        evidence: { candidate_count: candidateRows.length },
      });
      return;
    }

    for (const c of candidates) {
      for (const w of c.concepts) {
        if (!stateMap[w.id]) stateMap[w.id] = defaultConceptState(w.id);
      }
    }

    const picked = selectNext(candidates, stateMap, new Date());
    const versionRow = candidateRows.find((r) => r.id === picked.candidate.problem_version_id);
    if (!versionRow) {
      // Unreachable in practice (picked.candidate always comes from candidateRows), but keep the
      // response contract honest rather than throwing 500 on a selection bug.
      reply.send({ problem: null, rationale: "Selection produced no matching candidate.", evidence: {} });
      return;
    }

    const problem = await buildPublicProblem(versionRow, userId);

    const rationale = widened
      ? `${picked.rationale} (search widened past the ideal difficulty band — the nearby pool is thin.)`
      : picked.rationale;

    reply.send({
      problem,
      rationale,
      evidence: { factors: picked.factors, score: picked.score, widened, window: usedWindow, candidate_count: candidateRows.length },
    });
  });

  fastify.get<{ Params: { versionId: string } }>("/api/problems/:versionId", async (request, reply) => {
    const versionId = requireId(request.params.versionId, "versionId");
    const versionRow = await getApprovedProblemVersion(versionId);
    if (!versionRow) throw notFound("Problem version not found or not approved");

    const problem: PublicProblemWithNames = await buildPublicProblem(versionRow, userId);
    reply.send({ problem });
  });
}
