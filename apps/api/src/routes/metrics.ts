// GET /metrics — Prometheus text-exposition format (M5, PLAN.md §10 M5 / §14 "Prometheus +
// Grafana (compose profile)"; docs/CONTRACTS.md §9 already defines the rich `/api/system/stats`
// JSON endpoint for the in-app dashboard).
//
// Deliberately reuses the SAME queries/data sources `system.ts` uses (`deps.queue.stats()`,
// `worker_heartbeats`, `verification_reports`, `countApprovedUnattemptedByBand`) rather than
// building a parallel metrics pipeline — the one new query this file adds (submission end-to-end
// latency buckets) reads the same `submissions` table `system.ts`'s verdict-distribution query
// reads, just without the 24h window (a Prometheus counter is cumulative all-time by convention;
// a dashboard tile showing "last 24h" is a UI choice, not a different fact). If `/api/system/stats`
// and `/metrics` ever disagree, that is a bug to fix here, not a reason to keep two implementations.
//
// Hand-rolled formatter, not `prom-client`: every value here is a single aggregate SQL read per
// scrape (not a counter incremented in-process across requests), so `prom-client`'s registry/
// instrumentation machinery buys nothing — it's built for wrapping request handlers with
// pre-declared metric objects, not for periodically re-deriving gauges from SQL. ~40 lines of
// text-formatting is less surface area than a new dependency for this shape of exporter.
import type { FastifyInstance } from "fastify";
import { countApprovedUnattemptedByBand, query } from "@leetmind/db";
import type { Deps } from "../deps.js";

const STALE_WORKER_SECONDS = 30;

// Cumulative ("less-than-or-equal") bucket boundaries in milliseconds for the end-to-end
// submission-latency histogram. Wide range because the dominant cost (documented in
// docs/measurements.md) is per-execution container startup, not algorithm run time — a 10s bucket
// exists because that's the default SANDBOX_WALL_TIMEOUT_MS (docs/CONTRACTS.md §2), so "did this
// submission time out" is directly readable off the histogram.
const LATENCY_BUCKETS_MS = [100, 250, 500, 1000, 2000, 3000, 5000, 8000, 12000, 20000, 30000] as const;

interface MetricLine {
  name: string;
  help: string;
  type: "gauge" | "counter" | "histogram";
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatLabels(labels: Record<string, string | number>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${k}="${escapeLabelValue(String(labels[k]))}"`).join(",")}}`;
}

function formatValue(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "NaN";
  return String(value);
}

/** Small builder that accumulates `# HELP` / `# TYPE` header lines plus sample lines, in the
 * order metrics are declared — Prometheus's text format doesn't require this, but it makes the
 * `/metrics` output readable by a human scrolling through it, which is half the point. */
class MetricsWriter {
  private lines: string[] = [];
  private declared = new Set<string>();

  declare(metric: MetricLine): void {
    if (this.declared.has(metric.name)) return;
    this.declared.add(metric.name);
    this.lines.push(`# HELP ${metric.name} ${metric.help}`);
    this.lines.push(`# TYPE ${metric.name} ${metric.type}`);
  }

  sample(name: string, labels: Record<string, string | number>, value: number | null | undefined): void {
    this.lines.push(`${name}${formatLabels(labels)} ${formatValue(value)}`);
  }

  toString(): string {
    return this.lines.join("\n") + "\n";
  }
}

interface LatencyHistogramRow {
  count: string;
  sum: string | null;
  [bucketKey: string]: string | null;
}

function bucketKey(ms: number): string {
  return `le_${ms}`;
}

/** One query, dynamically built from LATENCY_BUCKETS_MS, producing cumulative bucket counts plus
 * _sum/_count — the standard Prometheus histogram shape — for created→completed submission
 * latency. Cumulative filters (`diff_ms <= X`) computed in SQL rather than in JS so a scrape never
 * has to pull one row per submission across the network. */
async function loadLatencyHistogram(): Promise<{ buckets: { le: number; count: number }[]; count: number; sumMs: number }> {
  const bucketExprs = LATENCY_BUCKETS_MS.map(
    (ms) => `count(*) filter (where diff_ms <= ${ms})::bigint as ${bucketKey(ms)}`,
  ).join(",\n      ");
  const sql = `
    select
      ${bucketExprs},
      count(*)::bigint as count,
      coalesce(sum(diff_ms), 0) as sum
    from (
      select extract(epoch from (completed_at - created_at)) * 1000 as diff_ms
      from submissions
      where status = 'completed' and completed_at is not null
    ) t;
  `;
  const rows = await query<LatencyHistogramRow>(sql);
  const row = rows[0];
  const count = Number(row?.count ?? 0);
  const sumMs = Number(row?.sum ?? 0);
  const buckets = LATENCY_BUCKETS_MS.map((le) => ({ le, count: Number(row?.[bucketKey(le)] ?? 0) }));
  return { buckets, count, sumMs };
}

export function registerMetricsRoutes(fastify: FastifyInstance, deps: Deps): void {
  // `/metrics` is a Prometheus scrape target, not an in-app view: it is reached by the scraper on
  // the compose network with no session, so it stays unauthenticated (see `PUBLIC_PATHS` in
  // src/auth.ts) and reports buffer depth for the instance owner (`SINGLE_USER_ID`) rather than
  // for whoever happens to be calling. Per-account buffer depth belongs on `/api/system/stats`,
  // which IS authenticated.
  const userId = deps.config.singleUserId;

  fastify.get("/metrics", async (_request, reply) => {
    const [queueStats, workers, verdictCounts, bufferDepth, stageRows, latency] = await Promise.all([
      // Same call `/api/system/stats` makes (@leetmind/queue already owns this query) — queue
      // depth by kind/status, oldest queued age, wait-time percentiles, lease recovery, dead jobs.
      deps.queue.stats(),
      query<{ worker_id: string; kind: string; last_seen_at: Date; stale: boolean }>(
        `select worker_id, kind, last_seen_at,
                (now() - last_seen_at) > interval '${STALE_WORKER_SECONDS} seconds' as stale
           from worker_heartbeats
          order by worker_id asc`,
      ),
      // All-time verdict counts — same `submissions` table system.ts's 24h-windowed query reads,
      // without the window: a Prometheus counter is cumulative by convention (Grafana computes
      // rate()/increase() over whatever window a panel wants), so windowing it here would be both
      // redundant with Grafana's own range queries and a second place the "last 24h" definition
      // could drift from the /system page's.
      query<{ verdict: string; count: number }>(
        `select verdict, count(*)::int as count
           from submissions
          where verdict is not null
          group by verdict
          order by verdict`,
      ),
      countApprovedUnattemptedByBand(userId),
      // Identical query to system.ts's generation-pass-rate-by-stage.
      query<{ stage: string; passed: number; total: number }>(
        `select stage_info->>'stage' as stage,
                count(*) filter (where stage_info->>'status' = 'passed')::int as passed,
                count(*)::int as total
           from verification_reports vr
           cross join lateral jsonb_array_elements(vr.stages) as stage_info
          group by stage_info->>'stage'
          order by stage`,
      ),
      loadLatencyHistogram(),
    ]);

    const w = new MetricsWriter();

    // --- queue depth by kind and status --------------------------------------------------------
    w.declare({ name: "leetmind_queue_depth", help: "Number of jobs by kind and status.", type: "gauge" });
    for (const k of queueStats.kinds) {
      for (const [status, count] of Object.entries(k.counts)) {
        w.sample("leetmind_queue_depth", { kind: k.kind, status }, count);
      }
    }

    // --- oldest queued age ----------------------------------------------------------------------
    w.declare({
      name: "leetmind_queue_oldest_queued_age_ms",
      help: "Age in ms of the oldest still-queued job, per kind (absent when nothing is queued for that kind).",
      type: "gauge",
    });
    for (const k of queueStats.kinds) {
      if (k.oldest_queued_age_ms !== null) {
        w.sample("leetmind_queue_oldest_queued_age_ms", { kind: k.kind }, k.oldest_queued_age_ms);
      }
    }

    // --- queue wait-time percentiles (Queue.stats()'s own approximation, see its doc comment) ---
    w.declare({
      name: "leetmind_queue_wait_ms",
      help: "Approximate queue wait time percentiles (enqueue -> claim) over the last hour.",
      type: "gauge",
    });
    w.sample("leetmind_queue_wait_ms", { quantile: "0.5" }, queueStats.wait_time_ms.p50);
    w.sample("leetmind_queue_wait_ms", { quantile: "0.95" }, queueStats.wait_time_ms.p95);

    // --- dead-job count ---------------------------------------------------------------------------
    w.declare({ name: "leetmind_queue_dead_jobs", help: "Total jobs currently in status=dead.", type: "gauge" });
    w.sample("leetmind_queue_dead_jobs", {}, queueStats.dead_count);

    // --- lease recovery (chaos/reliability signal, cheap to expose since Queue.stats() already
    // computes it) --------------------------------------------------------------------------------
    w.declare({
      name: "leetmind_queue_lease_recovery",
      help: "Jobs ever tagged with the lease-expired marker, bucketed by outcome (see @leetmind/queue LeaseRecoveryStats doc comment for precision caveats).",
      type: "gauge",
    });
    w.sample("leetmind_queue_lease_recovery", { outcome: "reaped_total" }, queueStats.lease_recovery.reaped_total);
    w.sample("leetmind_queue_lease_recovery", { outcome: "recovered" }, queueStats.lease_recovery.recovered);
    w.sample("leetmind_queue_lease_recovery", { outcome: "still_pending" }, queueStats.lease_recovery.still_pending);
    w.sample("leetmind_queue_lease_recovery", { outcome: "dead_after_reap" }, queueStats.lease_recovery.dead_after_reap);

    // --- worker liveness -------------------------------------------------------------------------
    w.declare({
      name: "leetmind_worker_up",
      help: "1 if the worker's last heartbeat is within the staleness window, else 0.",
      type: "gauge",
    });
    w.declare({
      name: "leetmind_worker_last_seen_seconds_ago",
      help: "Seconds since this worker's last heartbeat.",
      type: "gauge",
    });
    for (const worker of workers) {
      const labels = { worker_id: worker.worker_id, kind: worker.kind };
      w.sample("leetmind_worker_up", labels, worker.stale ? 0 : 1);
      const secondsAgo = (Date.now() - new Date(worker.last_seen_at).getTime()) / 1000;
      w.sample("leetmind_worker_last_seen_seconds_ago", labels, Math.max(0, secondsAgo));
    }

    // --- judge verdict counts by verdict (all-time counter) -------------------------------------
    w.declare({
      name: "leetmind_submissions_verdict_total",
      help: "Total completed submissions by terminal verdict (all-time; use rate()/increase() for throughput).",
      type: "counter",
    });
    for (const row of verdictCounts) {
      w.sample("leetmind_submissions_verdict_total", { verdict: row.verdict }, row.count);
    }

    // --- submission end-to-end latency histogram (created -> completed) -------------------------
    w.declare({
      name: "leetmind_submission_latency_ms",
      help: "End-to-end submission latency in ms, POST /api/submissions created_at -> completed_at.",
      type: "histogram",
    });
    for (const bucket of latency.buckets) {
      w.sample("leetmind_submission_latency_ms_bucket", { le: bucket.le }, bucket.count);
    }
    w.sample("leetmind_submission_latency_ms_bucket", { le: "+Inf" }, latency.count);
    w.sample("leetmind_submission_latency_ms_sum", {}, latency.sumMs);
    w.sample("leetmind_submission_latency_ms_count", {}, latency.count);

    // --- generation pass-rate by verification stage ----------------------------------------------
    w.declare({
      name: "leetmind_generation_stage_total",
      help: "Verification-report stage outcomes, by stage and result (passed|failed).",
      type: "counter",
    });
    for (const row of stageRows) {
      w.sample("leetmind_generation_stage_total", { stage: row.stage, result: "passed" }, row.passed);
      w.sample("leetmind_generation_stage_total", { stage: row.stage, result: "failed" }, row.total - row.passed);
    }

    // --- buffer depth per concept x rating band ---------------------------------------------------
    w.declare({
      name: "leetmind_buffer_depth",
      help: "Approved, unattempted problems per concept x rating band (the replenishment buffer, PLAN.md §5).",
      type: "gauge",
    });
    for (const row of bufferDepth) {
      w.sample("leetmind_buffer_depth", { concept: row.concept_id, band: row.band }, row.count);
    }

    reply
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .send(w.toString());
  });
}
