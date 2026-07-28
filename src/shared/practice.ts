import { z } from "zod";
import { PublicProblemSchema } from "./problem";

// Practice-loop DTOs — GET /api/practice/next (plus the read-only BaselineItemState left over
// from the removed baseline feature). Split out of submission.ts; see submission.ts for the
// actual submission-domain vocabulary.

// --- baseline (removed) -------------------------------------------------------------------------
//
// The baseline was a short adaptive probe the user had to complete before practice would serve
// them anything. Its endpoints, schemas, and UI are gone: the stepping rule that made it useful
// now runs invisibly over the first few practice problems (the backend’s cold-start rule), and
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
// There is deliberately no third "you must do X first" state, and this is now literally true
// rather than nearly so. Two gates have been removed from this schema: `needs_baseline`, which
// made a new user complete a probe first, and `teaching`/`followup`, which made a stuck user
// transcribe a solution and then work through a scheduled reinforce/transfer pair before practice
// would serve anything else. A user is served a problem on their very first request and on every
// request after it; the cold-start stepping rule (the backend’s cold-start rule) calibrates
// through the first few without announcing itself.

/**
 * The ordered, user-facing stages of making a problem. **Keep in lockstep with
 * the content generator’s own `GENERATION_STAGES`** — the `key`s are the wire
 * contract between the content worker (which writes them to `jobs.progress`) and this client.
 *
 * One list spanning two jobs: `writing` is the `generate` job's model call, the remaining six are
 * the verification gate (CONTRACTS.md §10) running under a separate `verify` job. The API stitches
 * the pair back together via their shared `correlation_id`, because the person waiting does not
 * care where the job boundary is.
 *
 * Labels are short on purpose — they sit under a progress bar, not in a paragraph.
 */
export const GENERATION_STAGES = [
  { key: "writing", label: "Writing" },
  { key: "schema", label: "Checking shape" },
  { key: "compile", label: "Compiling" },
  { key: "differential", label: "Differential testing" },
  { key: "boundary", label: "Boundary cases" },
  { key: "examples", label: "Examples" },
  { key: "mutation", label: "Mutation testing" },
] as const;

export type GenerationStageKey = (typeof GENERATION_STAGES)[number]["key"];

export const GenerationProgressSchema = z.object({
  /** One of `GENERATION_STAGES`' keys. Unknown values are tolerated (the worker may ship a new
   * stage before the client knows it) and rendered as position-only. */
  stage: z.string(),
  /** 1-based position in `GENERATION_STAGES`; 0 when the worker reported a stage this client
   * doesn't recognise. */
  index: z.number().int(),
  total: z.number().int(),
  updated_at: z.string().nullable().default(null),
});
export type GenerationProgress = z.infer<typeof GenerationProgressSchema>;

export const PracticeGenerationSchema = z
  .object({
    job_id: z.string().nullable(),
    concept_id: z.string(),
    target_rating: z.number().int(),
    /** Why generation was triggered rather than a problem served. No longer rendered — the
     * generating screen is a heading and a progress bar — but kept on the wire because it is the
     * only human-readable record of WHY a generation was commissioned, and it is worth having in
     * logs and in `/api/system/stats`. */
    reason: z.string(),
    /** Where this generation currently is, or null when nothing has reported yet (the job is
     * still queued, or was claimed and died before writing progress). Null must render as an
     * indeterminate bar, never as stage 1 — "queued behind other work" and "the model is writing"
     * are different answers and only one of them is true. */
    progress: GenerationProgressSchema.nullable().default(null),
    /** When the underlying generate job was enqueued (ISO 8601), so the client can show elapsed
     * time. The bar alone is a poor progress signal here: `writing` is 96-518s of a ~110-540s
     * total, so it holds segment 1 for most of the wait and elapsed time is what actually tells a
     * user their wait is progressing rather than stuck. */
    started_at: z.string().nullable().default(null),
  })
  .passthrough();
export type PracticeGeneration = z.infer<typeof PracticeGenerationSchema>;

export const NextPracticeProblemResponse = z
  .object({
    problem: PublicProblemSchema.nullable(),
    /** Non-null exactly when `problem` is null and generation is in flight. */
    generating: PracticeGenerationSchema.nullable().default(null),
    rationale: z.string().default(""),
    evidence: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();
export type NextPracticeProblemResponse = z.infer<typeof NextPracticeProblemResponse>;
