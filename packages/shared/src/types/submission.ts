import { z } from "zod";
import { PublicProblemSchema } from "./problem.js";
import { ConceptEdgeSchema, ConceptSchema, HintLevel } from "./concepts.js";

const timestampSchema = z.union([z.string(), z.date()]);

// --- core enums (docs/CONTRACTS.md §4.3) --------------------------------------------------

export const Verdict = z.enum([
  "accepted",
  "wrong_answer",
  "compilation_error",
  "runtime_error",
  "time_limit",
  "memory_limit",
  "output_limit",
  "internal_error",
  "cancelled",
]);
export type Verdict = z.infer<typeof Verdict>;

export const SubmissionStatus = z.enum([
  "created",
  "queued",
  "assigned",
  "compiling",
  "running",
  "completed",
  "cancelled",
]);
export type SubmissionStatus = z.infer<typeof SubmissionStatus>;

export const Language = z.enum(["python", "cpp"]);
export type Language = z.infer<typeof Language>;

export const SubmissionMode = z.enum(["run", "submit"]);
export type SubmissionMode = z.infer<typeof SubmissionMode>;

/**
 * Safe diagnostics only — never leaks hidden expected values for a `submit`. `*_preview` fields
 * are populated only for `run` mode and example-derived tests. docs/CONTRACTS.md §4.5.
 */
export const SubmissionFailureSchema = z
  .object({
    kind: z.string(),
    message: z.string(),
    first_failing_test_index: z.number().int().optional(),
    stderr_tail: z.string().optional(),
    input_preview: z.unknown().optional(),
    expected_preview: z.unknown().optional(),
    actual_preview: z.unknown().optional(),
  })
  .passthrough();
export type SubmissionFailure = z.infer<typeof SubmissionFailureSchema>;

/**
 * Post-solve reveal, docs/CONTRACTS.md §4.5 — present only when the user has earned it (an
 * accepted submit, or a recorded give-up) on `GET /api/submissions/:id` and the SSE `verdict`
 * event. Never smuggled through `failure` (a verdict is not a failure).
 */
export const RevealSchema = z
  .object({
    editorial_md: z.string(),
    target_complexity: z.object({ time: z.string(), space: z.string() }),
    concepts: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        role: z.string(),
        weight: z.number(),
      }),
    ),
  })
  .passthrough();
export type Reveal = z.infer<typeof RevealSchema>;

/** Safe projection of a `submissions` row — what `GET /api/submissions/:id` returns. */
export const SubmissionSchema = z
  .object({
    id: z.string(),
    user_id: z.string(),
    problem_version_id: z.string(),
    baseline_item_id: z.string().nullable().optional(),
    mode: SubmissionMode,
    language: Language,
    source: z.string(),
    status: SubmissionStatus,
    verdict: Verdict.nullable().optional(),
    passed_tests: z.number().int().default(0),
    total_tests: z.number().int().default(0),
    runtime_ms: z.number().int().nullable().optional(),
    memory_kb: z.number().int().nullable().optional(),
    failure: SubmissionFailureSchema.nullable().optional(),
    active_ms: z.number().int().nullable().optional(),
    correlation_id: z.string().nullable().optional(),
    created_at: timestampSchema,
    completed_at: timestampSchema.nullable().optional(),
    reveal: RevealSchema.optional(),
    /** True when this submit-mode submission was judged after a recorded give-up on this problem
     * version — judged and streamed like any other, but never applies a mastery consequence. */
    practice: z.boolean().optional(),
  })
  .passthrough();
export type Submission = z.infer<typeof SubmissionSchema>;

// --- mastery change shape, shared by give-up / skip / SSE `mastery` responses -------------

export const ConceptChangeSchema = z
  .object({
    concept_id: z.string(),
    before_rating: z.number(),
    after_rating: z.number(),
    before_uncertainty: z.number(),
    after_uncertainty: z.number(),
  })
  .passthrough();
export type ConceptChange = z.infer<typeof ConceptChangeSchema>;

export const MasteryChangeSchema = z
  .object({
    changes: z.array(ConceptChangeSchema),
    outcome: z.number(),
    explanation: z.string(),
  })
  .passthrough();
export type MasteryChange = z.infer<typeof MasteryChangeSchema>;

// --- GET /health ----------------------------------------------------------------------------

export const HealthResponse = z.object({
  ok: z.boolean(),
  version: z.string(),
  db: z.enum(["up", "down"]),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

// --- GET /api/problems/next -----------------------------------------------------------------

export const NextProblemQuery = z.object({
  concept: z.string().optional(),
  rating: z.coerce.number().optional(),
});
export type NextProblemQuery = z.infer<typeof NextProblemQuery>;

// `problem` is nullable: an empty approved pool is a normal state (the replenishment buffer may
// not have caught up yet), not an error. The API returns 200 with `problem: null` and an
// actionable `rationale` rather than a 500 — see CONTRACTS §9.
export const NextProblemResponse = z
  .object({
    problem: PublicProblemSchema.nullable(),
    rationale: z.string(),
    evidence: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();
export type NextProblemResponse = z.infer<typeof NextProblemResponse>;

// --- GET /api/problems/:versionId -----------------------------------------------------------

export const GetProblemResponse = z.object({
  problem: PublicProblemSchema,
});
export type GetProblemResponse = z.infer<typeof GetProblemResponse>;

// --- POST /api/submissions --------------------------------------------------------------------

export const CreateSubmissionRequest = z.object({
  problem_version_id: z.string(),
  language: Language,
  source: z.string(),
  mode: SubmissionMode,
  custom_input: z.unknown().optional(),
  baseline_item_id: z.string().optional(),
  active_ms: z.number().int().nonnegative().optional(),
});
export type CreateSubmissionRequest = z.infer<typeof CreateSubmissionRequest>;

export const CreateSubmissionResponse = z.object({
  submission_id: z.string(),
  status: SubmissionStatus,
});
export type CreateSubmissionResponse = z.infer<typeof CreateSubmissionResponse>;

// --- GET /api/submissions/:id -----------------------------------------------------------------

export const GetSubmissionResponse = z.object({
  submission: SubmissionSchema,
});
export type GetSubmissionResponse = z.infer<typeof GetSubmissionResponse>;

// --- GET /api/problems/:versionId/submissions/latest ---------------------------------------

export const GetLatestSubmissionResponse = z.object({
  submission: SubmissionSchema.nullable(),
});
export type GetLatestSubmissionResponse = z.infer<typeof GetLatestSubmissionResponse>;

// --- POST /api/hints -----------------------------------------------------------------------

export const TakeHintRequest = z.object({
  problem_version_id: z.string(),
  level: HintLevel,
});
export type TakeHintRequest = z.infer<typeof TakeHintRequest>;

export const TakeHintResponse = z.object({
  level: HintLevel,
  text: z.string(),
  penalty_cap: z.number(),
  next_level_penalty: z.number().nullable(),
});
export type TakeHintResponse = z.infer<typeof TakeHintResponse>;

// --- GET /api/hints/:versionId ---------------------------------------------------------------

export const GetHintsResponse = z
  .object({
    taken: z.array(HintLevel),
    available: z.array(HintLevel),
    penalties: z.record(z.string(), z.number()).default({}),
  })
  .passthrough();
export type GetHintsResponse = z.infer<typeof GetHintsResponse>;

// --- POST /api/problems/:versionId/give-up ----------------------------------------------------

export const GiveUpRequest = z.object({
  baseline_item_id: z.string().optional(),
  active_ms: z.number().int().nonnegative().optional(),
});
export type GiveUpRequest = z.infer<typeof GiveUpRequest>;

export const GiveUpResponse = z
  .object({
    editorial_md: z.string(),
    concepts: z.array(ConceptSchema),
    mastery_change: MasteryChangeSchema.optional(),
  })
  .passthrough();
export type GiveUpResponse = z.infer<typeof GiveUpResponse>;

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

// --- GET /api/system/stats ----------------------------------------------------------------------
// Tightened to apps/api/src/routes/system.ts / @leetmind/queue's Queue.stats() actual field names
// (QA-PLAN.md "Prevent recurrence" §1 — see ProgressResponse's comment above for why the previous
// `z.record` catch-alls never would have caught this page's Phase-1 drift bugs: "0 / 0 / 0 ms",
// literal "window × 0" badges, "0% / by_stage").

const SystemQueueSchema = z
  .object({
    kinds: z
      .array(z.object({ kind: z.string(), counts: z.record(z.string(), z.number()), oldest_queued_age_ms: z.number().nullable() }).passthrough())
      .default([]),
    wait_time_ms: z.object({ p50: z.number().nullable(), p95: z.number().nullable() }).passthrough(),
    dead_count: z.number().int(),
  })
  .passthrough();

const SystemWorkerSchema = z
  .object({
    worker_id: z.string(),
    kind: z.string(),
    last_seen_at: timestampSchema,
    stale: z.boolean(),
  })
  .passthrough();

const SystemVerdictsSchema = z
  .object({
    window: z.string(),
    counts: z.array(z.object({ verdict: z.string(), count: z.number().int() }).passthrough()).default([]),
  })
  .passthrough();

const SystemBufferDepthSchema = z
  .object({
    by_concept_band: z
      .array(z.object({ concept_id: z.string(), band: z.number(), count: z.number().int() }).passthrough())
      .default([]),
  })
  .passthrough();

const SystemGenerationPassRateSchema = z
  .object({
    by_stage: z
      .array(z.object({ stage: z.string(), passed: z.number().int(), total: z.number().int() }).passthrough())
      .default([]),
  })
  .passthrough();

export const SystemStatsResponse = z
  .object({
    queue: SystemQueueSchema,
    workers: z.array(SystemWorkerSchema).default([]),
    verdicts: SystemVerdictsSchema,
    buffer_depth: SystemBufferDepthSchema,
    generation_pass_rate: SystemGenerationPassRateSchema,
    model_runs: z.array(z.record(z.string(), z.unknown())).default([]),
    dead_jobs: z.array(z.record(z.string(), z.unknown())).default([]),
  })
  .passthrough();
export type SystemStatsResponse = z.infer<typeof SystemStatsResponse>;

// --- baseline (POST /api/baseline/start, GET /api/baseline/current) -----------------------------
//
// The baseline replaces the removed workout ladder. It is a short adaptive probe whose whole
// purpose is to seed honest per-concept ratings before the practice loop takes over — so a skip is
// a first-class outcome here, not a failure.

export const BaselineSessionStatus = z.enum(["active", "completed", "abandoned"]);
export type BaselineSessionStatus = z.infer<typeof BaselineSessionStatus>;

export const BaselineItemState = z.enum([
  "pending",
  "active",
  "solved",
  "skipped_inability",
  "skipped_preference",
  "gave_up",
]);
export type BaselineItemState = z.infer<typeof BaselineItemState>;

export const BaselineItemSchema = z
  .object({
    id: z.string(),
    baseline_session_id: z.string(),
    position: z.number().int(),
    problem_version_id: z.string(),
    rationale: z.string().default(""),
    selection_evidence: z.record(z.string(), z.unknown()).default({}),
    state: BaselineItemState,
    active_ms: z.number().int().default(0),
    started_at: timestampSchema.nullable().optional(),
    completed_at: timestampSchema.nullable().optional(),
  })
  .passthrough();
export type BaselineItem = z.infer<typeof BaselineItemSchema>;

export const BaselineSessionSchema = z
  .object({
    id: z.string(),
    user_id: z.string(),
    status: BaselineSessionStatus.default("active"),
    rationale: z.record(z.string(), z.unknown()).default({}),
    created_at: timestampSchema,
    completed_at: timestampSchema.nullable().optional(),
    items: z.array(BaselineItemSchema).optional(),
    /** How many probes the plan holds in total, so the UI can render "3 of 6" without having to
     * reverse-engineer it out of `rationale.plan`. */
    planned_count: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type BaselineSession = z.infer<typeof BaselineSessionSchema>;

export const StartBaselineResponse = z.object({
  baseline: BaselineSessionSchema,
});
export type StartBaselineResponse = z.infer<typeof StartBaselineResponse>;

export const GetCurrentBaselineResponse = z.object({
  baseline: BaselineSessionSchema.nullable(),
});
export type GetCurrentBaselineResponse = z.infer<typeof GetCurrentBaselineResponse>;

// --- POST /api/baseline-items/:id/skip ----------------------------------------------------------

export const SkipBaselineItemRequest = z.object({
  reason: z.enum(["inability", "preference"]),
  active_ms: z.number().int().nonnegative().optional(),
});
export type SkipBaselineItemRequest = z.infer<typeof SkipBaselineItemRequest>;

export const SkipBaselineItemResponse = z
  .object({
    item: BaselineItemSchema,
    mastery_change: MasteryChangeSchema.optional(),
  })
  .passthrough();
export type SkipBaselineItemResponse = z.infer<typeof SkipBaselineItemResponse>;

// --- POST /api/baseline-items/:id/start ---------------------------------------------------------

export const StartBaselineItemResponse = z.object({
  item: BaselineItemSchema,
});
export type StartBaselineItemResponse = z.infer<typeof StartBaselineItemResponse>;

// --- GET /api/practice/next ---------------------------------------------------------------------
//
// The iterative autogenerate loop. Exactly one of `problem` / `generating` is non-null: either a
// problem is ready now, or generation for the user's current target band is in flight and the
// client should poll. `needs_baseline` short-circuits both for a user who hasn't been probed yet.

export const PracticeGenerationSchema = z
  .object({
    job_id: z.string().nullable(),
    concept_id: z.string(),
    target_rating: z.number().int(),
    /** Why generation was triggered rather than a problem served — surfaced verbatim in the UI so
     * a waiting user always knows what is being made for them. */
    reason: z.string(),
  })
  .passthrough();
export type PracticeGeneration = z.infer<typeof PracticeGenerationSchema>;

export const NextPracticeProblemResponse = z
  .object({
    problem: PublicProblemSchema.nullable(),
    /** Non-null exactly when `problem` is null and generation is in flight. */
    generating: PracticeGenerationSchema.nullable().default(null),
    /** True when no baseline has been taken yet — the client should route to /baseline. */
    needs_baseline: z.boolean().default(false),
    rationale: z.string().default(""),
    evidence: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();
export type NextPracticeProblemResponse = z.infer<typeof NextPracticeProblemResponse>;

// --- GET /api/me --------------------------------------------------------------------------------

export const MeResponse = z.object({
  user: z.object({
    id: z.string(),
    handle: z.string(),
    email: z.string().nullable(),
  }),
  has_baseline: z.boolean(),
});
export type MeResponse = z.infer<typeof MeResponse>;

// --- POST /api/generate-now (M3 escape hatch) -------------------------------------------------

export const GenerateNowRequest = z.object({
  concepts: z.array(z.object({ id: z.string(), weight: z.number().min(0).max(1) })).min(1),
  target_rating: z.number().int(),
});
export type GenerateNowRequest = z.infer<typeof GenerateNowRequest>;

export const GenerateNowResponse = z.object({
  job_id: z.string(),
});
export type GenerateNowResponse = z.infer<typeof GenerateNowResponse>;

// --- GET /api/concepts -------------------------------------------------------------------------

export const GetConceptsResponse = z.object({
  concepts: z.array(ConceptSchema),
  edges: z.array(ConceptEdgeSchema),
});
export type GetConceptsResponse = z.infer<typeof GetConceptsResponse>;
