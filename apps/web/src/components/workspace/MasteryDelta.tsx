import type { ConceptChange } from "@leetmind/shared";
import { RatingMeter } from "../ui";

/**
 * Inline mastery-change display, shared by the accepted-verdict SSE `mastery` event and the
 * give-up/skip responses that carry the same `{changes, outcome, explanation}` shape
 * (docs/CONTRACTS.md §4.5, §8's explainability requirement).
 */
export function MasteryDelta({
  changes,
  outcome,
  explanation,
  conceptNames,
}: {
  changes: ConceptChange[];
  outcome: number;
  explanation: string;
  conceptNames?: Record<string, string>;
}) {
  return (
    <div className="space-y-3 rounded-md border border-accent-dim bg-bg-inset p-3" data-testid="mastery-delta">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-faint">Mastery update</h3>
        <span className="font-mono text-xs text-text-dim">outcome {outcome.toFixed(2)}</span>
      </div>
      <p className="text-sm text-text-dim">{explanation}</p>
      <div className="space-y-2.5">
        {changes.map((c) => {
          const delta = c.after_rating - c.before_rating;
          const positive = delta >= 0;
          return (
            <div key={c.concept_id} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-text">{conceptNames?.[c.concept_id] ?? c.concept_id}</span>
                <span className={positive ? "text-verdict-accepted" : "text-verdict-error"}>
                  {positive ? "+" : ""}
                  {delta.toFixed(1)} ({Math.round(c.before_rating)} → {Math.round(c.after_rating)})
                </span>
              </div>
              <RatingMeter rating={c.after_rating} uncertainty={c.after_uncertainty} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
