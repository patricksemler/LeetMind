import { z } from "zod";
import {
  ConceptChangeSchema,
  PublicTestResultSchema,
  RevealSchema,
  SubmissionFailureSchema,
  SubmissionStatus,
  Verdict,
} from "./submission.js";

/**
 * SSE events for `GET /api/submissions/:id/events` (docs/CONTRACTS.md §4.5). Transport is
 * Postgres `LISTEN/NOTIFY` on `NOTIFY_CHANNEL`; the API fans these out in-process to connected
 * `EventSource` clients.
 */

export const StatusEventSchema = z.object({
  submission_id: z.string(),
  status: SubmissionStatus,
  at: z.string(),
});
export type StatusEvent = z.infer<typeof StatusEventSchema>;

export const ProgressEventSchema = z.object({
  submission_id: z.string(),
  passed: z.number().int(),
  total: z.number().int(),
});
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;

export const VerdictEventSchema = z.object({
  submission_id: z.string(),
  verdict: Verdict,
  passed_tests: z.number().int(),
  total_tests: z.number().int(),
  runtime_ms: z.number().int().nullable().optional(),
  memory_kb: z.number().int().nullable().optional(),
  failure: SubmissionFailureSchema.optional(),
  reveal: RevealSchema.optional(),
  practice: z.boolean().optional(),
  /** Per-test outcomes for the PUBLIC tests, in statement order (see PublicTestResultSchema). */
  public_results: z.array(PublicTestResultSchema).nullable().optional(),
});
export type VerdictEvent = z.infer<typeof VerdictEventSchema>;

export const MasteryEventSchema = z.object({
  submission_id: z.string(),
  changes: z.array(ConceptChangeSchema),
  outcome: z.number(),
  explanation: z.string(),
});
export type MasteryEvent = z.infer<typeof MasteryEventSchema>;

/** Sent every 15s to keep the SSE connection alive. */
export const PingEventSchema = z.object({
  at: z.string(),
});
export type PingEvent = z.infer<typeof PingEventSchema>;

export const SSE_EVENT_SCHEMAS = {
  status: StatusEventSchema,
  progress: ProgressEventSchema,
  verdict: VerdictEventSchema,
  mastery: MasteryEventSchema,
  ping: PingEventSchema,
} as const;

export type SSEEventName = keyof typeof SSE_EVENT_SCHEMAS;

// --- Postgres LISTEN/NOTIFY transport ----------------------------------------------------------

export const NOTIFY_CHANNEL = "leetmind_events";

/** Notify payloads must stay under this many bytes (Postgres NOTIFY payload limit headroom). */
export const NOTIFY_PAYLOAD_MAX_BYTES = 7900;

/**
 * Shape of the JSON string passed to `pg_notify('leetmind_events', $1)`. Judge/content workers
 * emit this inside the same transaction as the state write it announces; the API's dedicated
 * LISTEN client fans it out to matching SSE subscribers as one of the named events above.
 */
export const NotifyPayloadSchema = z
  .object({
    type: z.enum(["status", "progress", "verdict", "mastery", "ping"]),
    submission_id: z.string().optional(),
    user_id: z.string().optional(),
  })
  .passthrough();
export type NotifyPayload = z.infer<typeof NotifyPayloadSchema>;
