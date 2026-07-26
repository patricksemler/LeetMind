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

/**
 * `transcribe` (migration 007) is the teaching-mode write-it-out step: it runs the hidden tests
 * like a `submit` so the user sees their typed solution pass, but writes NO learning event. See
 * apps/api/src/routes/submissions.ts and packages/learner/src/teaching.ts for why copying out an
 * editorial you have already been scored for must not move the rating back.
 */
export const SubmissionMode = z.enum(["run", "submit", "transcribe"]);
export type SubmissionMode = z.infer<typeof SubmissionMode>;

/**
 * Safe diagnostics only — never leaks hidden expected values for a `submit`. `*_preview` fields
 * are populated only for `run` mode and example-derived tests. docs/CONTRACTS.md §4.5.
 */
/** Pass counts split by whether the user can see the test. "4/5" alone doesn't say what to fix;
 * "all 2 public examples passed, 1 hidden case failed" is a different problem from "example 2
 * failed", and only one of them means "go look at the page". */
export const TestOriginSummarySchema = z
  .object({
    public_passed: z.number().int().nonnegative(),
    public_total: z.number().int().nonnegative(),
    hidden_passed: z.number().int().nonnegative(),
    hidden_total: z.number().int().nonnegative(),
  })
  .passthrough();
export type TestOriginSummary = z.infer<typeof TestOriginSummarySchema>;

/**
 * The one test that ended the run, in the same shape the workspace renders a public case in:
 * named arguments, expected value, the user's own output.
 *
 * NOTE — this deliberately narrows docs/CONTRACTS.md §4.5's original "hidden inputs are never
 * served" rule. The rule existed so a solution couldn't be hard-coded against the hidden suite,
 * and that cost is real: a user who submits repeatedly can now enumerate failing hidden cases one
 * at a time. It is exposed anyway because a "a hidden case failed, good luck" verdict gave the user
 * nothing actionable. Only the SINGLE first failing test is ever included — never the rest of the
 * suite — so the leak is bounded to one case per submission rather than the whole hidden set.
 */
export const FailingTestSchema = z
  .object({
    /** Index within the executed suite (public tests first — see `selectTests` in apps/judge). */
    index: z.number().int().nonnegative(),
    origin: z.enum(["public", "hidden"]),
    args: z.array(z.unknown()),
    expected: z.unknown().optional(),
    actual: z.unknown().optional(),
    /** `failed`, `error`, `timeout`… — a case that crashed has no meaningful `actual`. */
    status: z.string().optional(),
  })
  .passthrough();
export type FailingTest = z.infer<typeof FailingTestSchema>;

export const SubmissionFailureSchema = z
  .object({
    kind: z.string(),
    message: z.string(),
    first_failing_test_index: z.number().int().optional(),
    stderr_tail: z.string().optional(),
    input_preview: z.unknown().optional(),
    expected_preview: z.unknown().optional(),
    actual_preview: z.unknown().optional(),
    failing_test: FailingTestSchema.optional(),
    tests: TestOriginSummarySchema.optional(),
  })
  .passthrough();
export type SubmissionFailure = z.infer<typeof SubmissionFailureSchema>;

/**
 * True when the case that ended the attempt was a PUBLIC one — an example printed on the problem
 * page, which `Run` executes.
 *
 * A `submit` that dies on one of those is treated as a run everywhere it matters: it doesn't enter
 * the attempt history (`listSubmissionsForVersion`, @leetmind/db), it applies no mastery
 * consequence (apps/judge), and it doesn't send the workspace to the Submissions tab (apps/web).
 * The reasoning is the same one that already exempts compile-only failures from `updateConcepts`
 * (docs/CONTRACTS.md §8): an example failing in front of you is not evidence about a concept, it's
 * a mistake Run would have shown for free, and recording it as an attempt only pads the history.
 *
 * Deliberately keyed on `failing_test.origin` rather than comparing `first_failing_test_index`
 * against the public/hidden split: the origin is what the judge actually resolved the case from,
 * and a failure with no case at all (a compile error) must NOT match — that keeps its own
 * behaviour and its own place in the history.
 */
// Typed structurally, not as `SubmissionFailure`: the same failure travels as three shapes that
// differ only in an index signature — this zod-`.passthrough()` type, the plain @leetmind/db
// interface the judge writes, and the SSE event's. One predicate has to accept all three.
export function failedPublicCase(failure: { failing_test?: { origin?: string } | null } | null | undefined): boolean {
  return failure?.failing_test?.origin === "public";
}

/**
 * Post-solve reveal, docs/CONTRACTS.md §4.5 — present only when the user has earned it (an
 * accepted submit, or a recorded give-up) on `GET /api/submissions/:id` and the SSE `verdict`
 * event. Never smuggled through `failure` (a verdict is not a failure).
 */
/**
 * Reference solutions handed over at reveal time, keyed by language so the UI can offer a switch.
 * `cpp` is optional — a problem version generated before the C++ reference existed has Python only,
 * and the solution view shows just the languages actually present.
 */
export const SolutionsSchema = z.object({
  python: z.string(),
  cpp: z.string().optional(),
});
export type Solutions = z.infer<typeof SolutionsSchema>;

export const RevealSchema = z
  .object({
    editorial_md: z.string(),
    solutions: SolutionsSchema,
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

/**
 * One public test's outcome. Safe to serve verbatim: the input and expected value are printed in
 * the problem statement, and `actual` is the user's own program's output. Hidden tests never
 * appear here — `publicResults` (apps/judge) filters on test origin before building the array.
 */
export const PublicTestResultSchema = z
  .object({
    index: z.number().int().nonnegative(),
    status: z.string(),
    passed: z.boolean(),
    actual: z.unknown().optional(),
  })
  .passthrough();
export type PublicTestResult = z.infer<typeof PublicTestResultSchema>;

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
    paste_detected: z.boolean().optional(),
    correlation_id: z.string().nullable().optional(),
    created_at: timestampSchema,
    completed_at: timestampSchema.nullable().optional(),
    reveal: RevealSchema.optional(),
    /** Per-test outcomes for the PUBLIC tests, in statement order. Drives the case list in the
     * workspace. Null/absent for rows judged before migration 006. */
    public_results: z.array(PublicTestResultSchema).nullable().optional(),
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
  active_ms: z.number().int().nonnegative().optional(),
  /** `transcribe` mode only: the editor observed a paste while the user was typing the solution
   * out. Recorded, never enforced — see migration 007 for why blocking paste is the wrong tool. */
  paste_detected: z.boolean().optional(),
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

// --- GET /api/problems/:versionId/submissions ----------------------------------------------

/** Attempt history for one problem version, newest first. `submit` mode only: a run is a scratch
 * execution against the printed examples, not an attempt worth keeping a record of. */
export const ListSubmissionsResponse = z.object({
  submissions: z.array(SubmissionSchema),
});
export type ListSubmissionsResponse = z.infer<typeof ListSubmissionsResponse>;

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

/**
 * `texts` carries the text of the ladder rungs already in `taken`, so a client that is only
 * re-displaying hints it has already paid for doesn't have to re-POST `/api/hints` once per rung to
 * get it back. That reconstruction was what made a revisited problem render its taken hints a beat
 * after everything else, and it put N writes on the wire for a read.
 *
 * Only the four ladder rungs ever appear in `texts` — never `editorial`. The editorial reaches the
 * client through `editorial_md`/`solutions` below, and *only* once it has genuinely been revealed
 * (give-up, or practice opening a teaching episode). The hard rule that un-taken hint text never
 * appears in a payload is unchanged: both fields are null until `taken` contains `editorial`.
 */
export const GetHintsResponse = z
  .object({
    taken: z.array(HintLevel),
    available: z.array(HintLevel),
    penalties: z.record(z.string(), z.number()).default({}),
    texts: z.record(z.string(), z.string()).default({}),
    /** Non-null only once `taken` includes `editorial`. Serving it here (and not solely in the
     * give-up response body) is what lets a reload mid-teaching-episode still show the user the
     * solution they have been asked to transcribe. */
    editorial_md: z.string().nullable().default(null),
    solutions: SolutionsSchema.nullable().default(null),
    /** Whether an accepted `transcribe` submission exists for this problem. Server-authoritative:
     * the client uses it to decide whether the write-it-out step is still owed, so a reload cannot
     * skip past it. */
    transcribed: z.boolean().default(false),
  })
  .passthrough();
export type GetHintsResponse = z.infer<typeof GetHintsResponse>;

export const TeachingModeSchema = z
  .object({
    /** Why teaching mode engaged, shown to the user verbatim. */
    reason: z.string(),
    trigger: z.enum(["editorial_revealed", "consecutive_failures"]),
    /** True once a `transcribe` submission for this problem has been accepted — the client uses
     * this to unlock "next problem". Server-authoritative so a reload cannot skip the step. */
    transcribed: z.boolean().default(false),
  })
  .passthrough();
export type TeachingMode = z.infer<typeof TeachingModeSchema>;

// --- POST /api/problems/:versionId/give-up ----------------------------------------------------

export const GiveUpRequest = z.object({
  active_ms: z.number().int().nonnegative().optional(),
});
export type GiveUpRequest = z.infer<typeof GiveUpRequest>;

export const GiveUpResponse = z
  .object({
    editorial_md: z.string(),
    solutions: SolutionsSchema,
    concepts: z.array(ConceptSchema),
    /** Giving up opens a teaching episode — the user must transcribe this solution before
     * `GET /api/practice/next` will serve anything else. */
    teaching: TeachingModeSchema.optional(),
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

// --- baseline (removed) -------------------------------------------------------------------------
//
// The baseline was a short adaptive probe the user had to complete before practice would serve
// them anything. Its endpoints, schemas, and UI are gone: the stepping rule that made it useful
// now runs invisibly over the first few practice problems (packages/learner/src/coldstart.ts), and
// a new user is served a problem on their first request instead of a form.
//
// The `baseline_sessions` / `baseline_items` tables survive as read-only history (migration 007) —
// `submissions.baseline_item_id` and historical `learning_events` still point at them — so
// `BaselineItemState` remains here for the few readers that project those old rows.

export const BaselineItemState = z.enum([
  "pending",
  "active",
  "solved",
  "skipped_inability",
  "skipped_preference",
  "gave_up",
]);
export type BaselineItemState = z.infer<typeof BaselineItemState>;

// --- GET /api/practice/next ---------------------------------------------------------------------
//
// The iterative autogenerate loop. Exactly one of `problem` / `generating` is non-null: either a
// problem is ready now, or generation for the user's current target band is in flight and the
// client should poll.
//
// There is deliberately no third "you must do X first" state. The baseline gate that used to live
// here (`needs_baseline`) is gone: a new user is served a problem on their very first request, and
// the cold-start stepping rule (packages/learner/src/coldstart.ts) calibrates them through the
// first few problems without announcing itself.

export const FollowUpContextSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["reinforce", "transfer"]),
    concept_id: z.string(),
    /** Persisted at planning time so the user is told why they got this problem. */
    rationale: z.string(),
  })
  .passthrough();
export type FollowUpContext = z.infer<typeof FollowUpContextSchema>;

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
    /** Non-null when this problem is being *taught* rather than tested: the client must open the
     * whole hint ladder including the editorial, and require a `transcribe` submission before
     * moving on. See packages/learner/src/teaching.ts. */
    teaching: TeachingModeSchema.nullable().default(null),
    /** Non-null when this problem is settling a scheduled follow-up debt (reinforce or transfer). */
    followup: FollowUpContextSchema.nullable().default(null),
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
