import type { Express } from "express";
import { toPublicProblem } from "@leetmind/shared";
import { buildMockReveal } from "../reveal.js";
import {
  conceptState,
  getProblemUserState,
  hasSolvedOrGivenUp,
  problemFixtures,
  problemsById,
} from "../state.js";
import { handle, notFound, pparam } from "./helpers.js";

export function registerProblemRoutes(app: Express): void {
  // --- GET /api/problems/next --------------------------------------------------------------------

  app.get(
    "/api/problems/next",
    handle((req, res) => {
      const concept = typeof req.query.concept === "string" ? req.query.concept : undefined;
      const ratingParam =
        typeof req.query.rating === "string" ? Number(req.query.rating) : undefined;

      let candidates = problemFixtures.filter(
        (p) => !getProblemUserState(p.problemVersionId).solved,
      );
      if (candidates.length === 0) candidates = problemFixtures;
      if (concept) {
        const withConcept = candidates.filter((p) =>
          p.content.concepts.some((c) => c.id === concept),
        );
        if (withConcept.length > 0) candidates = withConcept;
      }

      const weakest = [...conceptState.entries()].sort((a, b) => a[1].rating - b[1].rating)[0];
      const targetRating = ratingParam ?? weakest?.[1].rating ?? 1200;

      candidates.sort(
        (a, b) =>
          Math.abs(a.content.difficulty.rating - targetRating) -
          Math.abs(b.content.difficulty.rating - targetRating),
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
  // The mock's job here is to exercise both branches the real endpoint can return, since one of them
  // (generating) is otherwise only reachable against a live stack with an empty content pool.
  // `?mock=generating` forces it so the polling UI can be developed and tested without waiting on a
  // real `claude -p` run.
  //
  // There is no `needs_baseline` branch any more: the endpoint always has something to serve.

  app.get(
    "/api/practice/next",
    handle((req, res) => {
      // An open teaching episode outranks everything, exactly as it does in the real route: the user
      // was shown a solution and has not written it out yet.
      const teachingFixture = problemFixtures.find((p) => {
        const st = getProblemUserState(p.problemVersionId);
        return st.gaveUp && !st.transcribed;
      });
      if (teachingFixture) {
        const reason =
          "You needed the full solution for that one — type it out yourself before moving on.";
        res.json({
          problem: toPublicProblem({
            problemVersionId: teachingFixture.problemVersionId,
            content: teachingFixture.content,
            hintsTaken: getProblemUserState(teachingFixture.problemVersionId).hintsTaken,
            revealConcepts: true,
          }),
          generating: null,
          teaching: { reason, trigger: "editorial_revealed", transcribed: false },
          followup: null,
          rationale: reason,
          evidence: { teaching: true, trigger: "editorial_revealed" },
        });
        return;
      }

      const weakest = [...conceptState.entries()].sort((a, b) => a[1].rating - b[1].rating)[0];
      const conceptId = weakest?.[0] ?? "arrays_hashing";

      // `hasSolvedOrGivenUp`, not just `solved`: the real route excludes anything the user has ever
      // submitted against (`listApprovedUnattempted`), and a give-up plus its transcription leaves
      // submissions behind. Filtering on `solved` alone re-served a problem the user had just been
      // taught and transcribed.
      const unsolved = problemFixtures.filter((p) => !hasSolvedOrGivenUp(p.problemVersionId));
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
          teaching: null,
          followup: null,
          rationale: "Generating your next problem.",
          evidence: { concept: conceptId },
        });
        return;
      }

      const targetRating = weakest?.[1].rating ?? 1200;
      const chosen = [...unsolved].sort(
        (a, b) =>
          Math.abs(a.content.difficulty.rating - targetRating) -
          Math.abs(b.content.difficulty.rating - targetRating),
      )[0]!;

      res.json({
        problem: toPublicProblem({
          problemVersionId: chosen.problemVersionId,
          content: chosen.content,
          hintsTaken: getProblemUserState(chosen.problemVersionId).hintsTaken,
          revealConcepts: hasSolvedOrGivenUp(chosen.problemVersionId),
        }),
        generating: null,
        teaching: null,
        followup: null,
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

  // --- GET /api/problems/:versionId/reveal -----------------------------------------------------
  // The reveal already earned on this version, so the workspace can restore the solution after a
  // reload instead of relying on the one-shot give-up response. Mirrors apps/api: un-earned is a 404,
  // never an empty 200.

  app.get(
    "/api/problems/:versionId/reveal",
    handle((req, res) => {
      const fixture = problemsById.get(pparam(req.params.versionId));
      if (!fixture) return notFound(res, `no problem version ${pparam(req.params.versionId)}`);
      const reveal = buildMockReveal(fixture);
      if (!reveal) return notFound(res, `no reveal earned for ${fixture.problemVersionId}`);
      res.json(reveal);
    }),
  );
}
