import { z } from "zod";

// Ops/system-stats DTOs — GET /api/system/stats. Split out of submission.ts alongside
// progress.ts; see submission.ts for the actual submission-domain vocabulary.

const timestampSchema = z.union([z.string(), z.date()]);

// --- GET /api/system/stats ----------------------------------------------------------------------
// Tightened to apps/api/src/routes/system.ts / @leetmind/queue's Queue.stats() actual field names
// (QA-PLAN.md "Prevent recurrence" §1 — see ProgressResponse's comment above for why the previous
// `z.record` catch-alls never would have caught this page's Phase-1 drift bugs: "0 / 0 / 0 ms",
// literal "window × 0" badges, "0% / by_stage").

const SystemQueueSchema = z
  .object({
    kinds: z
      .array(
        z
          .object({
            kind: z.string(),
            counts: z.record(z.string(), z.number()),
            oldest_queued_age_ms: z.number().nullable(),
          })
          .passthrough(),
      )
      .default([]),
    wait_time_ms: z
      .object({ p50: z.number().nullable(), p95: z.number().nullable() })
      .passthrough(),
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
    counts: z
      .array(z.object({ verdict: z.string(), count: z.number().int() }).passthrough())
      .default([]),
  })
  .passthrough();

const SystemBufferDepthSchema = z
  .object({
    by_concept_band: z
      .array(
        z
          .object({ concept_id: z.string(), band: z.number(), count: z.number().int() })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

const SystemGenerationPassRateSchema = z
  .object({
    by_stage: z
      .array(
        z
          .object({ stage: z.string(), passed: z.number().int(), total: z.number().int() })
          .passthrough(),
      )
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
