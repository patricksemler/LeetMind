// Pure concept/target-selection helpers for the practice loop (routes/practice.ts). No I/O here —
// everything in this file is a plain function of its arguments, which is what makes it testable
// without booting Fastify or a database.
import type { ProblemVersionRow } from "@leetmind/db";
import { targetBand, type ConceptState } from "@leetmind/learner";
import { defaultConceptState } from "./candidatePool.js";

export interface PracticeTarget {
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
export function bandOf(rating: number): number {
  return Math.floor(rating / 200) * 200;
}

/** The primary concept of a problem version, which is what every teaching/follow-up decision is
 * attributed to. Falls back to the heaviest concept when no role is marked primary. */
export function primaryConceptOf(row: ProblemVersionRow): { id: string; rating: number } | null {
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
