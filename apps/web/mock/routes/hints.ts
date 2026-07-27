import type { Express } from "express";
import {
  ConceptSchema,
  GiveUpRequest,
  HINT_PENALTY_CAPS,
  type HintLevel,
  TakeHintRequest,
} from "@leetmind/shared";
import { CONCEPTS } from "../fixtures/concepts.js";
import { outcomeScore, updateConcepts } from "../mastery.js";
import {
  conceptState,
  getProblemUserState,
  learningEvents,
  problemsById,
  submissions,
} from "../state.js";
import { badRequest, handle, notFound, pparam } from "./helpers.js";

const HINT_LADDER = [
  "l1_orientation",
  "l2_conceptual",
  "l3_structural",
  "outline",
] as const satisfies readonly HintLevel[];

export function registerHintRoutes(app: Express): void {
  // --- POST /api/hints -----------------------------------------------------------------------

  app.post(
    "/api/hints",
    handle((req, res) => {
      const parsed = TakeHintRequest.safeParse(req.body);
      if (!parsed.success) return badRequest(res, "invalid hint request", parsed.error.flatten());
      const { problem_version_id, level } = parsed.data;

      if (level === "editorial") {
        return badRequest(
          res,
          "editorial is only reached via POST /api/problems/:versionId/give-up",
        );
      }

      const fixture = problemsById.get(problem_version_id);
      if (!fixture) return notFound(res, `no problem version ${problem_version_id}`);

      const userState = getProblemUserState(problem_version_id);
      if (!userState.hintsTaken.includes(level)) userState.hintsTaken.push(level);

      const idx = HINT_LADDER.indexOf(level);
      const nextLevel =
        idx >= 0 && idx + 1 < HINT_LADDER.length ? HINT_LADDER[idx + 1]! : "editorial";

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
      const taken: HintLevel[] = userState.gaveUp
        ? [...userState.hintsTaken, "editorial"]
        : [...userState.hintsTaken];
      const available = HINT_LADDER.filter((l) => !userState.hintsTaken.includes(l));
      // Ladder rungs only, and only ones already taken — the editorial stays behind the give-up flow.
      const texts: Record<string, string> = {};
      for (const level of HINT_LADDER) {
        if (userState.hintsTaken.includes(level)) texts[level] = fixture.content.hints[level];
      }
      // Once the editorial is genuinely revealed this endpoint serves it too, so a reload
      // mid-teaching-episode still shows the user the solution they were asked to transcribe.
      const editorialTaken = taken.includes("editorial");
      res.json({
        taken,
        available,
        penalties: HINT_PENALTY_CAPS,
        texts,
        editorial_md: editorialTaken ? fixture.content.hints.editorial_md : null,
        solutions: editorialTaken
          ? {
              python: fixture.content.reference_solution_py,
              cpp: fixture.content.reference_solution_cpp,
            }
          : null,
        transcribed: userState.transcribed,
      });
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
        (s) =>
          s.mode === "submit" &&
          s.problemVersionId === versionId &&
          s.row.status !== "completed" &&
          s.row.status !== "cancelled",
      );
      if (inFlight) {
        res.status(409).json({
          error: {
            code: "conflict",
            message:
              "A submission for this problem is still being judged — wait for it to finish before giving up.",
          },
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

      const concepts = fixture.content.concepts
        .map((c) => CONCEPTS.find((full) => full.id === c.id))
        .filter((c): c is NonNullable<typeof c> => !!c)
        .map((c) => ConceptSchema.parse(c));

      res.json({
        editorial_md: fixture.content.hints.editorial_md,
        solutions: {
          python: fixture.content.reference_solution_py,
          cpp: fixture.content.reference_solution_cpp,
        },
        concepts,
        teaching: {
          reason:
            "You needed the full solution for that one — type it out yourself before moving on.",
          trigger: "editorial_revealed",
          transcribed: false,
        },
        mastery_change: { changes, outcome, explanation },
      });
    }),
  );
}
