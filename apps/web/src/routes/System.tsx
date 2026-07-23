import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { Badge, Panel, PanelBody, PanelHeader, PanelTitle } from "../components/ui";

function asNum(v: unknown, fallback = 0): number {
  return typeof v === "number" ? v : fallback;
}

/** `/system` — queue depth/waits, workers, verdict distribution, buffer depth, generation
 * pass-rate, model-run cost/latency, dead jobs. Auto-refreshes every 5s. */
export function System() {
  const query = useQuery({
    queryKey: ["system", "stats"],
    queryFn: api.systemStats,
    refetchInterval: 5000,
  });

  if (query.isLoading || !query.data) {
    return <div className="flex h-full items-center justify-center text-text-faint">Loading…</div>;
  }

  const { queue, workers, verdicts, buffer_depth, generation_pass_rate, dead_jobs } = query.data;
  const modelRuns = (query.data as { model_runs?: Record<string, unknown> }).model_runs ?? {};

  return (
    <div className="mx-auto h-full max-w-5xl space-y-6 overflow-y-auto p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-xl text-text">System</h1>
        <span className="flex items-center gap-1.5 text-xs text-text-faint">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          live · refreshes every 5s
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Panel className="p-4">
          <div className="text-xs uppercase tracking-wide text-text-faint">Queue depth</div>
          <div className="mt-1 font-display text-2xl text-text">{asNum(queue.depth)}</div>
          {!!queue.by_kind && typeof queue.by_kind === "object" && (
            <div className="mt-1 flex gap-2 text-xs text-text-faint">
              {Object.entries(queue.by_kind as Record<string, unknown>).map(([k, v]) => (
                <span key={k}>
                  {k}:{asNum(v)}
                </span>
              ))}
            </div>
          )}
        </Panel>
        <Panel className="p-4">
          <div className="text-xs uppercase tracking-wide text-text-faint">Wait time (p50 / p95 / p99)</div>
          <div className="mt-1 font-mono text-sm text-text">
            {asNum(queue.wait_p50_ms)} / {asNum(queue.wait_p95_ms)} / {asNum(queue.wait_p99_ms)} ms
          </div>
        </Panel>
        <Panel className="p-4">
          <div className="text-xs uppercase tracking-wide text-text-faint">Model-run latency (p50 / p95)</div>
          <div className="mt-1 font-mono text-sm text-text">
            {asNum(modelRuns.p50_ms)} / {asNum(modelRuns.p95_ms)} ms · ${asNum(modelRuns.avg_cost_usd).toFixed(3)}/run
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader>
          <PanelTitle>Workers</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-1.5">
          {workers.map((w, i) => (
            <div key={i} className="flex items-center justify-between text-sm">
              <span className="font-mono text-text">{String(w.worker_id)}</span>
              <span className="text-text-faint">{String(w.kind)}</span>
              <span className="text-text-faint">last seen {formatDate(w.last_seen_at as string)}</span>
            </div>
          ))}
        </PanelBody>
      </Panel>

      <div className="grid gap-4 sm:grid-cols-2">
        <Panel>
          <PanelHeader>
            <PanelTitle>Verdict distribution</PanelTitle>
          </PanelHeader>
          <PanelBody className="flex flex-wrap gap-2">
            {Object.keys(verdicts).length === 0 ? (
              <p className="text-sm text-text-faint">No submissions judged yet.</p>
            ) : (
              Object.entries(verdicts).map(([v, count]) => (
                <Badge key={v} tone={v === "accepted" ? "accepted" : "neutral"}>
                  {v.replace(/_/g, " ")} × {asNum(count)}
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
            {Object.entries(buffer_depth).map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="font-mono text-xs text-text-dim">{k}</span>
                <span className="text-text">{asNum(v)}</span>
              </div>
            ))}
          </PanelBody>
        </Panel>
      </div>

      <Panel>
        <PanelHeader>
          <PanelTitle>Generation pass rate by stage</PanelTitle>
        </PanelHeader>
        <PanelBody className="grid grid-cols-2 gap-2 sm:grid-cols-6">
          {Object.entries(generation_pass_rate).map(([stage, rate]) => (
            <div key={stage} className="text-center">
              <div className="font-mono text-lg text-text">{Math.round(asNum(rate) * 100)}%</div>
              <div className="text-[11px] text-text-faint">{stage}</div>
            </div>
          ))}
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
