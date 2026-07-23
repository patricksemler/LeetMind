import { z } from "zod";

/** Accepts either an ISO string (typical over JSON) or a `Date` (typical from `pg`). */
const timestampSchema = z.union([z.string(), z.date()]);

/** Mirrors the `concepts` table (docs/CONTRACTS.md §3). */
export const ConceptSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  misconceptions: z.array(z.string()).default([]),
  min_rating: z.number().int().default(800),
  max_rating: z.number().int().default(2400),
  sort_order: z.number().int().default(0),
});
export type Concept = z.infer<typeof ConceptSchema>;

/** Mirrors the `concept_edges` table. */
export const ConceptEdgeSchema = z.object({
  parent_id: z.string(),
  child_id: z.string(),
});
export type ConceptEdge = z.infer<typeof ConceptEdgeSchema>;

/** Mirrors the `user_concept_state` table. */
export const ConceptStateSchema = z.object({
  user_id: z.string(),
  concept_id: z.string(),
  rating: z.number().default(1200),
  uncertainty: z.number().default(350),
  attempts: z.number().int().default(0),
  solves: z.number().int().default(0),
  unassisted_solves: z.number().int().default(0),
  skips: z.number().int().default(0),
  current_streak: z.number().int().default(0),
  best_streak: z.number().int().default(0),
  total_active_ms: z.number().int().default(0),
  hint_counts: z.record(z.string(), z.number()).default({}),
  error_counts: z.record(z.string(), z.number()).default({}),
  last_practiced_at: timestampSchema.nullable().optional(),
  next_review_at: timestampSchema.nullable().optional(),
  review_interval_days: z.number().default(1),
  review_ease: z.number().default(2.5),
  review_reps: z.number().int().default(0),
  updated_at: timestampSchema.optional(),
});
export type ConceptState = z.infer<typeof ConceptStateSchema>;

/** Mirrors `hint_events.level` / the hint ladder keys on `problem_versions.content.hints`. */
export const HintLevel = z.enum([
  "l1_orientation",
  "l2_conceptual",
  "l3_structural",
  "outline",
  "editorial",
]);
export type HintLevel = z.infer<typeof HintLevel>;

/** Outcome-score cap once a hint of this level has been taken. docs/CONTRACTS.md §8. */
export const HINT_PENALTY_CAPS: Record<HintLevel, number> = {
  l1_orientation: 0.9,
  l2_conceptual: 0.75,
  l3_structural: 0.6,
  outline: 0.4,
  editorial: 0.0,
};
