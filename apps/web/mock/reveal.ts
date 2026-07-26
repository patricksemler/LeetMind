/**
 * Post-solve reveal (docs/CONTRACTS.md §4.5) for the mock server — mirrors `buildReveal` in
 * `apps/api/src/mappers/submission.ts`: present only once the user has earned it (an accepted
 * submit, or a recorded give-up) on `GET /api/submissions/:id` and the SSE `verdict` event. Built
 * from an explicit allowlist, never by spreading the raw fixture content.
 */
import type { Reveal } from "@leetmind/shared";
import { CONCEPTS } from "./fixtures/concepts.js";
import type { ProblemFixture } from "./fixtures/problems.js";
import { hasSolvedOrGivenUp } from "./state.js";

const nameById = new Map(CONCEPTS.map((c) => [c.id, c.name]));

/** `earned` defaults to the persisted per-problem solved/gave-up flag; pass `true` explicitly
 * from the lifecycle that's setting that flag in the same tick the reveal-bearing event fires. */
export function buildMockReveal(problem: ProblemFixture, earned = hasSolvedOrGivenUp(problem.problemVersionId)): Reveal | undefined {
  if (!earned) return undefined;
  return {
    editorial_md: problem.content.hints.editorial_md,
    solutions: { python: problem.content.reference_solution_py, cpp: problem.content.reference_solution_cpp },
    target_complexity: problem.content.target_complexity,
    concepts: problem.content.concepts.map((c) => ({
      id: c.id,
      name: nameById.get(c.id) ?? c.id,
      role: c.role,
      weight: c.weight,
    })),
  };
}
