import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { Badge, Panel, PanelBody, PanelHeader, PanelTitle } from "../components/ui";

function asNum(v: unknown, fallback = 0): number {
  return typeof v === "number" ? v : fallback;
}
function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** `/system` — queue depth/waits, workers, verdict distribution, buffer depth, generation
 * pass-rate, model-run cost/latency, dead jobs. Auto-refreshes every 5s.
 *
 * Rewritten against the real `GET /api/system/stats` shape (apps/api/src/routes/system.ts) —
 * every panel here used to read mock-only field names and rendered garbage against the real API
 * with real data present (confirmed live): queue depth/wait always "0 / 0 / 0 ms" (real shape is
 * `queue.kinds[]` + `queue.wait_time_ms.{p50,p95}`, no top-level `depth`/`by_kind`, no p99);
 * verdict mix rendered literal "window × 0" / "counts × 0" badges (`verdicts` is
 * `{window, counts: [...]}`, not a flat map); buffer depth showed one bogus "by_concept_band" row
 * (`buffer_depth` is `{by_concept_band: [...]}`); generation pass-rate showed "0% / by_stage"
 * (`generation_pass_rate` is `{by_stage: [...]}`); model-runs is an array of per-kind rows, not a
 * single `{p50_ms, p95_ms, avg_cost_usd}` object.
 */
export function System() {
  const query = useQuery({
    queryKey: ["system", "stats"],
    queryFn: api.systemStats,
    refetchInterval: 5000,
  });

  if (query.isLoading || !query.data) {
    return <div className="flex h-full items-center justify-center text-text-faint">Loading…</div>;
  }

  if (query.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-text-dim">
        <p>Couldn't load system stats.</p>
        <button className="text-accent underline" onClick={() => query.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const { queue, workers, verdicts, buffer_depth, generation_pass_rate, model_runs, dead_jobs } = query.data;
  const kinds = (queue?.kinds ?? []) as Array<{ kind: string; counts: Record<string, number>; oldest_queued_age_ms: number | null }>;
  const totalDepth = kinds.reduce((sum, k) => sum + Object.values(k.counts ?? {}).reduce((s, n) => s + asNum(n), 0), 0);
  const waitTimeMs = (queue?.wait_time_ms ?? {}) as { p50: number | null; p95: number | null };
  const verdictCounts = (verdicts?.counts ?? []) as Array<{ verdict: string; count: number }>;
  const bufferByBand = (buffer_depth?.by_concept_band ?? []) as Array<{ concept_id: string; band: number; count: number }>;
  const passRateByStage = (generation_pass_rate?.by_stage ?? []) as Array<{ stage: string; passed: number; total: number }>;
  const modelRunRows = (Array.isArray(model_runs) ? model_runs : []) as Array<{
    kind: string;
    invoker: string;
    runs: number;
    avg_duration_ms: number | null;
    avg_cost_usd: number | null;
    total_cost_usd: number | null;
  }>;
  const workerRows = (workers ?? []) as Array<{ worker_id: string; kind: string; last_seen_at: string; stale?: boolean }>;

  return (
    <div className="mx-auto h-full max-w-5xl space-y-6 overflow-y-auto p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-xl text-text">System</h1>
        <span className="flex items-center gap-1.5 text-xs text-text-faint">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          live · refreshes every 5s
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Panel className="p-4">
          <div className="text-xs uppercase tracking-wide text-text-faint">Queue depth</div>
          <div className="mt-1 font-display text-2xl text-text">{totalDepth}</div>
          {kinds.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-2 text-xs text-text-faint">
              {kinds.map((k) => (
                <span key={k.kind}>
                  {k.kind}: {Object.values(k.counts ?? {}).reduce((s, n) => s + asNum(n), 0)}
                </span>
              ))}
            </div>
          )}
        </Panel>
        <Panel className="p-4">
          <div className="text-xs uppercase tracking-wide text-text-faint">Wait time (p50 / p95)</div>
          <div className="mt-1 font-mono text-sm text-text">
            {Math.round(asNum(waitTimeMs.p50))} / {Math.round(asNum(waitTimeMs.p95))} ms
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader>
          <PanelTitle>Workers</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-1.5">
          {workerRows.length === 0 ? (
            <p className="text-sm text-text-faint">No workers have reported a heartbeat.</p>
          ) : (
            workerRows.map((w, i) => (
              <div key={w.worker_id || i} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 text-sm">
                <span className="truncate font-mono text-text">{w.worker_id}</span>
                <Badge tone="neutral">{w.kind}</Badge>
                <span className={`whitespace-nowrap text-xs ${w.stale ? "text-verdict-error" : "text-text-faint"}`}>
                  {w.stale ? "stale · " : ""}
                  last seen {formatDateTime(w.last_seen_at)}
                </span>
              </div>
            ))
          )}
        </PanelBody>
      </Panel>

      <div className="grid gap-4 sm:grid-cols-2">
        <Panel>
          <PanelHeader>
            <PanelTitle>Verdict distribution (24h)</PanelTitle>
          </PanelHeader>
          <PanelBody className="flex flex-wrap gap-2">
            {verdictCounts.length === 0 ? (
              <p className="text-sm text-text-faint">No submissions judged yet.</p>
            ) : (
              verdictCounts.map(({ verdict, count }) => (
                <Badge key={verdict} tone={verdict === "accepted" ? "accepted" : "neutral"}>
                  {asStr(verdict).replace(/_/g, " ")} × {asNum(count)}
                </Badge>
              ))
            )}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle>Buffer depth (concept × band)</PanelTitle>
          </PanelHeader>
          <PanelBody className="space-y-1 text-sm">
            {bufferByBand.length === 0 ? (
              <p className="text-sm text-text-faint">No approved unattempted problems.</p>
            ) : (
              bufferByBand.map((row) => (
                <div key={`${row.concept_id}:${row.band}`} className="flex justify-between">
                  <span className="font-mono text-xs text-text-dim">
                    {row.concept_id} · {row.band}+
                  </span>
                  <span className="text-text">{asNum(row.count)}</span>
                </div>
              ))
            )}
          </PanelBody>
        </Panel>
      </div>

      <Panel>
        <PanelHeader>
          <PanelTitle>Generation pass rate by stage</PanelTitle>
        </PanelHeader>
        <PanelBody className="grid grid-cols-2 gap-2 sm:grid-cols-6">
          {passRateByStage.length === 0 ? (
            <p className="text-sm text-text-faint">No verification reports yet.</p>
          ) : (
            passRateByStage.map(({ stage, passed, total }) => (
              <div key={stage} className="text-center">
                <div className="font-mono text-lg text-text">{total > 0 ? Math.round((passed / total) * 100) : 0}%</div>
                <div className="text-[11px] text-text-faint">{stage}</div>
              </div>
            ))
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Model runs (7d)</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-1.5">
          {modelRunRows.length === 0 ? (
            <p className="text-sm text-text-faint">No model runs recorded.</p>
          ) : (
            modelRunRows.map((r) => (
              <div key={`${r.kind}:${r.invoker}`} className="flex items-center justify-between text-sm">
                <span className="text-text">
                  {r.kind} <span className="text-text-faint">({r.invoker})</span>
                </span>
                <span className="font-mono text-xs text-text-faint">
                  {r.runs} runs · avg {Math.round(asNum(r.avg_duration_ms))} ms · ${asNum(r.avg_cost_usd).toFixed(3)}/run
                </span>
              </div>
            ))
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Dead jobs</PanelTitle>
        </PanelHeader>
        <PanelBody>
          {dead_jobs.length === 0 ? (
            <p className="text-sm text-text-faint">None — nothing has exhausted its retries.</p>
          ) : (
            <div className="space-y-1 text-sm">
              {dead_jobs.map((j, i) => (
                <div key={i} className="text-verdict-error">
                  {JSON.stringify(j)}
                </div>
              ))}
            </div>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}
