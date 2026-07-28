import { z } from "zod";
import { ConceptSchema } from "./concepts";

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
 * What a client may *create*: `run` is a scratch execution against the printed examples, `submit`
 * is the graded attempt.
 *
 * There was a third, `transcribe` — teaching mode's write-it-out step, which ran the hidden tests
 * but wrote no learning event. Teaching mode is gone and nothing may create one again.
 */
export const SubmissionMode = z.enum(["run", "submit"]);
export type SubmissionMode = z.infer<typeof SubmissionMode>;

/**
 * What the `submissions.mode` column may *contain* — a strict superset of what can be created.
 *
 * The two used to be the same enum and are deliberately not any more. Real `transcribe` rows exist
 * and migration 008 keeps them (rewriting them to `submit` would inject them into the
 * mastery-relevant queries they were designed to be excluded from), so anything that reads a
 * persisted row — the row schema, the judge job payload, a rejudge — has to be able to name the
 * value even though nothing can write it. Anything on the create path uses `SubmissionMode` above
 * and rejects it.
 */
export const PersistedSubmissionMode = z.enum(["run", "submit", "transcribe"]);
export type PersistedSubmissionMode = z.infer<typeof PersistedSubmissionMode>;

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
    /** Index within the executed suite (public tests first — see `selectTests` in the judge). */
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
 * the attempt history (`listSubmissionsForVersion`, in the API), it applies no mastery
 * consequence in the judge, and it doesn't send the workspace to the Submissions tab.
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
// differ only in an index signature — this zod-`.passthrough()` type, the plain database-layer
// interface the judge writes, and the SSE event's. One predicate has to accept all three.
export function failedPublicCase(
  failure: { failing_test?: { origin?: string } | null } | null | undefined,
): boolean {
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
 * appear here — `publicResults` (in the judge) filters on test origin before building the array.
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
    mode: PersistedSubmissionMode,
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

// --- POST /api/submissions --------------------------------------------------------------------

export const CreateSubmissionRequest = z.object({
  problem_version_id: z.string(),
  language: Language,
  source: z.string(),
  mode: SubmissionMode,
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

// --- GET /api/problems/:versionId/submissions ----------------------------------------------

/** Attempt history for one problem version, newest first. `submit` mode only: a run is a scratch
 * execution against the printed examples, not an attempt worth keeping a record of. */
export const ListSubmissionsResponse = z.object({
  submissions: z.array(SubmissionSchema),
});
export type ListSubmissionsResponse = z.infer<typeof ListSubmissionsResponse>;

// `TakeHintRequest` / `TakeHintResponse` / `GetHintsResponse` (POST /api/hints, GET
// /api/hints/:versionId) live in hints.ts. `TeachingModeSchema` used to be pinned here — both
// hints.ts and practice.ts needed it, and defining it in hints.ts would have made hints.ts and
// submission.ts import each other. Teaching mode is gone, and so is the schema and the cycle it
// was arranged to avoid.

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
    mastery_change: MasteryChangeSchema.optional(),
  })
  .passthrough();
export type GiveUpResponse = z.infer<typeof GiveUpResponse>;
