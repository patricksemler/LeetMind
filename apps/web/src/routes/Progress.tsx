import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatMs, formatRelativeDays } from "../lib/format";
import { Badge, Panel, PanelBody, PanelHeader, PanelTitle, RatingMeter } from "../components/ui";

function asNum(v: unknown, fallback = 0): number {
  return typeof v === "number" ? v : fallback;
}
function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

const TREND_ICON: Record<string, string> = { up: "↑", flat: "→", unstarted: "·" };

export function Progress() {
  const query = useQuery({ queryKey: ["progress"], queryFn: api.progress });

  if (query.isLoading || !query.data) {
    return <div className="flex h-full items-center justify-center text-text-faint">Loading…</div>;
  }

  const { concepts, reviews_due, stats, records, history } = query.data;

  const solvesByDifficulty = (stats.solves_by_difficulty ?? {}) as Record<
    string,
    { solved: number; with_hints: number; without_hints: number }
  >;
  const errorRecurrences = (stats.error_category_recurrences ?? {}) as Record<string, number>;

  return (
    <div className="mx-auto h-full max-w-5xl space-y-8 overflow-y-auto p-6">
      <section>
        <h2 className="mb-3 font-display text-lg text-text">Mastery by concept</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {concepts.map((c) => {
            const rating = asNum(c.rating, 1200);
            const uncertainty = asNum(c.uncertainty, 350);
            const trend = asStr(c.trend);
            return (
              <Panel key={asStr(c.id)} className="p-3.5">
                <div className="mb-1.5 flex items-center justify-between text-sm">
                  <span className="text-text">{asStr(c.name) || asStr(c.id)}</span>
                  <span className="font-mono text-xs text-text-dim">
                    {Math.round(rating)} ± {Math.round(uncertainty)} {TREND_ICON[trend] ?? ""}
                  </span>
                </div>
                <RatingMeter rating={rating} uncertainty={uncertainty} />
                <div className="mt-1.5 text-xs text-text-faint">
                  {asNum(c.attempts)} attempts · {asNum(c.solves)} solved · {asNum(c.unassisted_solves)} unassisted ·
                  streak {asNum(c.current_streak)} (best {asNum(c.best_streak)})
                </div>
              </Panel>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="mb-3 font-display text-lg text-text">Reviews due</h2>
        {reviews_due.length === 0 ? (
          <p className="text-sm text-text-faint">Nothing due — spaced review will surface concepts here as they age.</p>
        ) : (
          <div className="space-y-1.5">
            {reviews_due.map((r) => (
              <div key={asStr(r.concept_id)} className="flex items-center justify-between rounded-md border border-border bg-bg-raised px-3 py-2 text-sm">
                <span className="text-text">{asStr(r.name) || asStr(r.concept_id)}</span>
                <Badge tone="warn">due {formatRelativeDays(r.due_at as string)}</Badge>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <Panel>
          <PanelHeader>
            <PanelTitle>Solves by difficulty band</PanelTitle>
          </PanelHeader>
          <PanelBody className="space-y-1.5">
            {Object.keys(solvesByDifficulty).length === 0 ? (
              <p className="text-sm text-text-faint">No submissions yet.</p>
            ) : (
              Object.entries(solvesByDifficulty)
                .sort((a, b) => Number(a[0]) - Number(b[0]))
                .map(([band, s]) => (
                  <div key={band} className="flex items-center justify-between text-sm">
                    <span className="font-mono text-text-dim">{band}+</span>
                    <span className="text-text">
                      {s.solved} solved <span className="text-text-faint">({s.without_hints} unassisted, {s.with_hints} hinted)</span>
                    </span>
                  </div>
                ))
            )}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle>Active time</PanelTitle>
          </PanelHeader>
          <PanelBody>
            <div className="text-2xl font-display text-text">{formatMs(asNum(stats.median_active_ms))}</div>
            <p className="mt-1 text-xs text-text-faint">median active time per submission ({asNum(stats.total_submissions)} total)</p>
          </PanelBody>
        </Panel>
      </section>

      <section>
        <h2 className="mb-3 font-display text-lg text-text">Error category recurrences</h2>
        {Object.keys(errorRecurrences).length === 0 ? (
          <p className="text-sm text-text-faint">No recurring error categories yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {Object.entries(errorRecurrences).map(([kind, count]) => (
              <Badge key={kind} tone="error">
                {kind.replace(/_/g, " ")} × {count}
              </Badge>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 font-display text-lg text-text">Personal records</h2>
        <Panel className="p-4">
          {records.highest_unassisted_difficulty ? (
            <p className="text-sm text-text">
              Highest unassisted solve: <strong>{asStr(records.highest_unassisted_title)}</strong> at rating{" "}
              <span className="font-mono">{asNum(records.highest_unassisted_difficulty)}</span>
            </p>
          ) : (
            <p className="text-sm text-text-faint">No unassisted solves recorded yet.</p>
          )}
        </Panel>
      </section>

      <section>
        <h2 className="mb-3 font-display text-lg text-text">Workout history</h2>
        {history.length === 0 ? (
          <p className="text-sm text-text-faint">No workouts yet.</p>
        ) : (
          <div className="space-y-1.5">
            {history.map((h, i) => (
              <div key={i} className="flex items-center justify-between rounded-md border border-border bg-bg-raised px-3 py-2 text-sm">
                <span className="text-text">
                  {asStr(h.kind)} · {asStr(h.status)}
                </span>
                <span className="text-text-faint">
                  {asNum(h.items_completed)} / {asNum(h.items_total)} items
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
