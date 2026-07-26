import { z } from "zod";
import { PublicProblemSchema } from "./problem.js";
import { TeachingModeSchema } from "./submission.js";

// Practice-loop DTOs — GET /api/practice/next (plus the read-only BaselineItemState left over
// from the removed baseline feature). Split out of submission.ts; see submission.ts for the
// actual submission-domain vocabulary.

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
