import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatMs, formatDate } from "../lib/format";
import { Badge, Panel, PanelBody, PanelHeader, PanelTitle, RatingMeter } from "../components/ui";

function asNum(v: unknown, fallback = 0): number {
  return typeof v === "number" ? v : fallback;
}
function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Real `GET /api/progress` (apps/api/src/routes/progress.ts) only ever emits 'up'/'flat'/'down' —
// 'down' was missing here, so a declining concept silently rendered identical to a flat one
// (confirmed live).
const TREND_ICON: Record<string, string> = { up: "↑", flat: "→", down: "↓" };

const HISTORY_KIND_LABEL: Record<string, string> = {
  submission: "Submission",
  skip: "Skipped",
  give_up: "Gave up",
  diagnostic: "Diagnostic",
  review: "Review",
  decay: "Decay",
};

function formatDaysOverdue(days: number): string {
  if (days < 1) return "due today";
  const rounded = Math.round(days);
  return `${rounded}d overdue`;
}

export function Progress() {
  const query = useQuery({ queryKey: ["progress"], queryFn: api.progress });

  if (query.isLoading || !query.data) {
    return <div className="flex h-full items-center justify-center text-text-faint">Loading…</div>;
  }

  if (query.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-text-dim">
        <p>Couldn't load progress.</p>
        <button className="text-accent underline" onClick={() => query.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const { concepts, reviews_due, stats, records, history } = query.data;
  const nameByConceptId = new Map(concepts.map((c) => [asStr(c.concept_id), asStr(c.name)]));

  // `stats.solve_bands` / `stats.error_categories` are arrays of `{band, ...}` / `{kind, count}`
  // rows (apps/api/src/routes/progress.ts), not the mock-only `solves_by_difficulty` /
  // `error_category_recurrences` keyed objects this page used to read (always empty against the
  // real API — confirmed live "No submissions yet" beside a real non-zero median active time).
  const solveBands = (stats.solve_bands ?? []) as Array<{
    band: number;
    solved_without_hints: number;
    solved_with_hints: number;
    attempts: number;
  }>;
  const errorCategories = (stats.error_categories ?? []) as Array<{ kind: string; count: number }>;
  const totalAttempts = solveBands.reduce((sum, b) => sum + asNum(b.attempts), 0);

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
              <Panel key={asStr(c.concept_id)} className="p-3.5">
                {/* items-start + min-w-0, not items-center: a long concept name wraps to two
                    lines inside this narrow card, and items-center was vertically centering the
                    single-line rating badge against the wrapped name's full height instead of
                    its first line — misaligned (confirmed live). */}
                <div className="mb-1.5 flex items-start justify-between gap-2 text-sm">
                  <span className="min-w-0 text-text">{asStr(c.name) || asStr(c.concept_id)}</span>
                  <span className="shrink-0 font-mono text-xs text-text-dim">
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
            {reviews_due.map((r) => {
              const conceptId = asStr(r.concept_id);
              return (
                <div key={conceptId} className="flex items-center justify-between rounded-md border border-border bg-bg-raised px-3 py-2 text-sm">
                  <span className="text-text">{nameByConceptId.get(conceptId) || conceptId}</span>
                  <Badge tone="warn">{formatDaysOverdue(asNum(r.days_overdue))}</Badge>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <Panel>
          <PanelHeader>
            <PanelTitle>Solves by difficulty band</PanelTitle>
          </PanelHeader>
          <PanelBody className="space-y-1.5">
            {solveBands.length === 0 ? (
              <p className="text-sm text-text-faint">No submissions yet.</p>
            ) : (
              [...solveBands]
                .sort((a, b) => a.band - b.band)
                .map((s) => (
                  <div key={s.band} className="flex items-center justify-between text-sm">
                    <span className="font-mono text-text-dim">{s.band}+</span>
                    <span className="text-text">
                      {s.solved_without_hints + s.solved_with_hints} solved{" "}
                      <span className="text-text-faint">
                        ({s.solved_without_hints} unassisted, {s.solved_with_hints} hinted)
                      </span>
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
            <p className="mt-1 text-xs text-text-faint">median active time per submission ({totalAttempts} total)</p>
          </PanelBody>
        </Panel>
      </section>

      <section>
        <h2 className="mb-3 font-display text-lg text-text">Error category recurrences</h2>
        {errorCategories.length === 0 ? (
          <p className="text-sm text-text-faint">No recurring error categories yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {errorCategories.map(({ kind, count }) => (
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
          {records.highest_unassisted_difficulty_solved ? (
            <p className="text-sm text-text">
              Highest unassisted solve: rating{" "}
              <span className="font-mono">{asNum(records.highest_unassisted_difficulty_solved)}</span>
            </p>
          ) : (
            <p className="text-sm text-text-faint">No unassisted solves recorded yet.</p>
          )}
        </Panel>
      </section>

      <section>
        <h2 className="mb-3 font-display text-lg text-text">Recent activity</h2>
        {history.length === 0 ? (
          <p className="text-sm text-text-faint">No activity yet.</p>
        ) : (
          <div className="space-y-1.5">
            {history.map((h, i) => {
              const kind = asStr(h.kind);
              return (
                <div key={asStr(h.id) || i} className="flex items-center justify-between rounded-md border border-border bg-bg-raised px-3 py-2 text-sm">
                  <span className="text-text">{HISTORY_KIND_LABEL[kind] ?? kind}</span>
                  <span className="text-text-faint">
                    outcome {asNum(h.outcome).toFixed(2)} · {formatDate(h.created_at as string)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
