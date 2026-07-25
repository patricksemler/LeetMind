// GET /api/system/stats — queue depth/waits, worker liveness, verdict distribution, buffer depth,
// generation pass-rate by stage, model-run latency/cost, dead jobs, plus the learner engine's
// tunable constants (docs/CONTRACTS.md §9, PLAN.md §8 "/system"). All plain SQL over existing
// tables except queue stats/dead jobs, which reuse `Queue.stats()` (@leetmind/queue already owns
// that query).
import type { FastifyInstance } from "fastify";
import { countApprovedUnattemptedByBand, query } from "@leetmind/db";
import { LEARNER_CONSTANTS } from "@leetmind/learner";
import type { Deps } from "../deps.js";

const STALE_WORKER_SECONDS = 30;

export function registerSystemRoutes(fastify: FastifyInstance, deps: Deps): void {
  const userId = deps.config.singleUserId;

  fastify.get("/api/system/stats", async (_request, reply) => {
    const [queueStats, workers, verdicts, bufferDepth, passRate, modelRuns] = await Promise.all([
      deps.queue.stats(),
      query<{ worker_id: string; kind: string; last_seen_at: Date; meta: Record<string, unknown>; stale: boolean }>(
        `select worker_id, kind, last_seen_at, meta,
                (now() - last_seen_at) > interval '${STALE_WORKER_SECONDS} seconds' as stale
           from worker_heartbeats
          order by worker_id asc`,
      ),
      query<{ verdict: string; count: number }>(
        `select verdict, count(*)::int as count
           from submissions
          where completed_at > now() - interval '24 hours' and verdict is not null
          group by verdict
          order by count desc`,
      ),
      countApprovedUnattemptedByBand(userId),
      query<{ stage: string; passed: number; total: number }>(
        `select stage_info->>'stage' as stage,
                count(*) filter (where stage_info->>'status' = 'passed')::int as passed,
                count(*)::int as total
           from verification_reports vr
           cross join lateral jsonb_array_elements(vr.stages) as stage_info
          group by stage_info->>'stage'
          order by stage`,
      ),
      query<{
        kind: string;
        invoker: string;
        runs: number;
        avg_duration_ms: number | null;
        avg_cost_usd: number | null;
        total_cost_usd: number | null;
      }>(
        `select kind, invoker, count(*)::int as runs,
                avg(duration_ms) as avg_duration_ms,
                avg(cost_usd) as avg_cost_usd,
                sum(cost_usd) as total_cost_usd
           from model_runs
          where created_at > now() - interval '7 days'
          group by kind, invoker
          order by kind, invoker`,
      ),
    ]);

    reply.send({
      queue: queueStats,
      workers,
      verdicts: { window: "24h", counts: verdicts },
      buffer_depth: { by_concept_band: bufferDepth },
      generation_pass_rate: { by_stage: passRate },
      model_runs: modelRuns,
      dead_jobs: queueStats.recent_dead,
      learner_constants: LEARNER_CONSTANTS,
    });
  });
}
