import { z } from "zod";
import { Language, SubmissionMode } from "./submission.js";

const timestampSchema = z.union([z.string(), z.date()]);

// --- job kinds & priority (docs/CONTRACTS.md §4.4) ------------------------------------------

export const JobKind = z.enum(["judge", "verify", "generate"]);
export type JobKind = z.infer<typeof JobKind>;

/** Lower runs sooner. */
export const JOB_PRIORITY = { judge: 10, verify: 50, generate: 100 } as const satisfies Record<
  JobKind,
  number
>;

export const JobStatus = z.enum(["queued", "leased", "done", "failed", "dead", "cancelled"]);
export type JobStatus = z.infer<typeof JobStatus>;

// --- payloads ---------------------------------------------------------------------------------

export const JudgeJobPayloadSchema = z.object({
  submission_id: z.string(),
  mode: SubmissionMode,
  language: Language,
  problem_version_id: z.string(),
  user_id: z.string(),
});
export type JudgeJobPayload = z.infer<typeof JudgeJobPayloadSchema>;

export const VerifyJobPayloadSchema = z.object({
  problem_version_id: z.string(),
  correlation_id: z.string(),
});
export type VerifyJobPayload = z.infer<typeof VerifyJobPayloadSchema>;

export const GenerationRequestSchema = z.object({
  concepts: z.array(z.object({ id: z.string(), weight: z.number().min(0).max(1) })).min(1),
  target_rating: z.number().int(),
  rating_tolerance: z.number().int().nonnegative(),
  expected_minutes: z.tuple([z.number().int(), z.number().int()]),
  target_complexity: z.object({ time: z.string(), space: z.string() }).optional(),
  required_patterns: z.array(z.string()).default([]),
  forbidden_patterns: z.array(z.string()).default([]),
  /** Recent titles / mechanic summaries to steer generation away from repeats. */
  similarity_exclusions: z.array(z.string()).default([]),
  comparator_hint: z.string().optional(),
  allow_types: z.array(z.string()).default([]),
  prompt_version: z.string(),
});
export type GenerationRequest = z.infer<typeof GenerationRequestSchema>;

export const GenerateJobPayloadSchema = z.object({
  request: GenerationRequestSchema,
  correlation_id: z.string(),
});
export type GenerateJobPayload = z.infer<typeof GenerateJobPayloadSchema>;

// --- jobs table row (docs/CONTRACTS.md §3) ------------------------------------------------------

export const JobSchema = z
  .object({
    id: z.string(),
    kind: JobKind,
    priority: z.number().int().default(100),
    payload: z.record(z.string(), z.unknown()),
    status: JobStatus.default("queued"),
    attempts: z.number().int().default(0),
    max_attempts: z.number().int().default(3),
    run_at: timestampSchema,
    lease_expires_at: timestampSchema.nullable().optional(),
    leased_by: z.string().nullable().optional(),
    last_error: z.string().nullable().optional(),
    idempotency_key: z.string().nullable().optional(),
    correlation_id: z.string().nullable().optional(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .passthrough();
export type Job = z.infer<typeof JobSchema>;

// --- idempotency-key builders (docs/CONTRACTS.md §4.4) -------------------------------------------

export function judgeJobKey(submissionId: string): string {
  return `judge:${submissionId}`;
}

export function verifyJobKey(problemVersionId: string): string {
  return `verify:${problemVersionId}`;
}

export function generateJobKey(conceptKey: string, ratingBand: number, slotIndex: number): string {
  return `generate:${conceptKey}:${ratingBand}:${slotIndex}`;
}

// Covers every `learning_events.kind` that is written idempotently. `decay` is deliberately
// absent: uncertainty decay is a recurring recomputation, not a one-shot evidence event, so it
// has no natural single-use key.
export type LearningEventKeyInput =
  | { kind: "submission"; submissionId: string }
  | { kind: "skip"; workoutItemId: string }
  | { kind: "diagnostic"; workoutItemId: string }
  | { kind: "give_up"; userId: string; problemVersionId: string }
  | { kind: "review"; userId: string; conceptId: string; dueAt: string };

export function learningEventKey(input: LearningEventKeyInput): string {
  switch (input.kind) {
    case "submission":
      return `le:${input.submissionId}`;
    case "skip":
      return `le:skip:${input.workoutItemId}`;
    case "diagnostic":
      return `le:diag:${input.workoutItemId}`;
    case "give_up":
      // one give-up per user per problem version, ever
      return `le:give_up:${input.userId}:${input.problemVersionId}`;
    case "review":
      return `le:review:${input.userId}:${input.conceptId}:${input.dueAt}`;
  }
}
