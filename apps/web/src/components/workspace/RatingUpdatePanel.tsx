/**
 * The Elo breakdown carried on every resolution response (PLAN_BACKEND.md §9, #22): a minimal
 * panel, not a redesign — every field the server sends, laid out so the sign of the delta and the
 * before/after numbers are the first things read.
 */
import type { RatingUpdateView } from "@shared";
import { Panel, SectionLabel } from "../ui";
import { formatRating } from "../../lib/format";

function metricLabel(key: string): string {
  return key.replace(/_/g, " ");
}

export function RatingUpdatePanel({ update }: { update: RatingUpdateView }) {
  const rose = update.delta > 0;
  const flat = update.delta === 0;

  return (
    <Panel className="space-y-3 p-4" data-testid="rating-update-panel">
      <div className="flex items-baseline justify-between gap-3">
        <SectionLabel>
          {update.type_slug.replace(/_/g, " ")}
        </SectionLabel>
        <span
          className={`font-mono text-sm ${
            flat ? "text-text-dim" : rose ? "text-verdict-accepted" : "text-verdict-error"
          }`}
        >
          {rose ? "+" : ""}
          {Math.round(update.delta)}
        </span>
      </div>

      <div className="flex items-center gap-2 font-mono text-sm text-text">
        <span>{formatRating(update.rating_before)}</span>
        <span aria-hidden="true" className="text-text-faint">
          →
        </span>
        <span>{formatRating(update.rating_after)}</span>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-dim">
        <div className="flex justify-between gap-2">
          <dt>Problem rating</dt>
          <dd className="font-mono text-text">{update.problem_rating}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>K</dt>
          <dd className="font-mono text-text">{update.k_factor}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Expected</dt>
          <dd className="font-mono text-text">{update.expected_score.toFixed(2)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Performance</dt>
          <dd className="font-mono text-text">{update.performance_score.toFixed(2)}</dd>
        </div>
      </dl>

      {Object.keys(update.metrics).length > 0 && (
        <dl className="space-y-0.5 border-t border-border pt-2 text-xs text-text-faint">
          {Object.entries(update.metrics).map(([key, value]) => (
            <div key={key} className="flex justify-between gap-2">
              <dt>{metricLabel(key)}</dt>
              <dd className="font-mono text-text-dim">{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </Panel>
  );
}
