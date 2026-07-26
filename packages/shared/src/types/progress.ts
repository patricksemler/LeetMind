import { z } from "zod";

// Progress / dashboard DTOs — GET /api/progress. Split out of submission.ts, which used to hold
// every /api/* response shape; see submission.ts for the actual submission-domain vocabulary.

const timestampSchema = z.union([z.string(), z.date()]);

// --- GET /api/progress -------------------------------------------------------------------------
// Tightened to apps/api/src/routes/progress.ts's actual field names (QA-PLAN.md "Prevent
// recurrence" §1: a `z.record(string, unknown)` catch-all "validates" against almost any shape,
// including the wrong one — it never would have caught `solves_by_difficulty` vs the real
// `solve_bands`, `id` vs the real `concept_id`, or any of Phase 1's other mock/real drift bugs.
// `.passthrough()` at every level so a genuinely new field is still forward-compatible; only the
// fields the web app actually reads are required.

const ProgressConceptSchema = z
  .object({
    concept_id: z.string(),
    name: z.string(),
    rating: z.number(),
    uncertainty: z.number(),
    attempts: z.number().int(),
    solves: z.number().int(),
    unassisted_solves: z.number().int(),
    trend: z.string(),
    /** When all five mastery clauses first held (packages/learner/src/mastery.ts). Null until
     * then, and never cleared once set — a later bad day is already reflected in the rating. */
    mastered_at: z.union([z.string(), z.date()]).nullable().default(null),
  })
  .passthrough();

const ProgressReviewDueSchema = z
  .object({
    concept_id: z.string(),
    days_overdue: z.number(),
  })
  .passthrough();

const ProgressSolveBandSchema = z
  .object({
    band: z.number(),
    solved_without_hints: z.number().int(),
    solved_with_hints: z.number().int(),
    attempts: z.number().int(),
  })
  .passthrough();

const ProgressErrorCategorySchema = z
  .object({
    kind: z.string(),
    count: z.number().int(),
  })
  .passthrough();

const ProgressHistoryEntrySchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    outcome: z.number(),
    created_at: timestampSchema,
  })
  .passthrough();

export const ProgressResponse = z
  .object({
    concepts: z.array(ProgressConceptSchema).default([]),
    reviews_due: z.array(ProgressReviewDueSchema).default([]),
    stats: z
      .object({
        solve_bands: z.array(ProgressSolveBandSchema).default([]),
        error_categories: z.array(ProgressErrorCategorySchema).default([]),
        median_active_ms: z.number().nullable().default(null),
      })
      .passthrough()
      .default({}),
    records: z
      .object({
        highest_unassisted_difficulty_solved: z.number().nullable().default(null),
      })
      .passthrough()
      .default({}),
    history: z.array(ProgressHistoryEntrySchema).default([]),
  })
  .passthrough();
export type ProgressResponse = z.infer<typeof ProgressResponse>;
