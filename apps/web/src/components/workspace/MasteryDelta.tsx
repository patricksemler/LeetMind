import type { ConceptChange } from "@leetmind/shared";
import { withConceptNames } from "../../lib/conceptNames";
import { RatingMeter } from "../ui";

/**
 * Inline mastery-change display, shared by the accepted-verdict SSE `mastery` event and the
 * give-up/skip responses that carry the same `{changes, outcome, explanation}` shape
 * (docs/CONTRACTS.md §4.5, §8's explainability requirement).
 *
 * "Explainable" has to mean explainable *to the person practising*. The panel therefore leads with
 * the model's own reasoning as prose (built in `@leetmind/learner`'s `buildExplanation`) and shows
 * the numbers underneath it as support. It used to do the opposite — an `outcome 1.00` chip and a
 * log line reading "Expected 19% success (you 1200 vs problem 1450); scored 1. two_pointers +39
 * (1200→1239, ±350→±160)" — which restated the rows beneath it and named concepts by their
 * database slugs.
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
  void outcome; // The bounded 0..1 evidence score is model-internal; the prose says what it meant.

  return (
    <div className="space-y-3 rounded-md border border-border bg-bg-inset p-3.5" data-testid="mastery-delta">
      <h3 className="text-xs font-medium uppercase tracking-wide text-text-faint">Mastery update</h3>

      {explanation && (
        <p className="text-sm leading-relaxed text-text">
          {withConceptNames(explanation, changes.map((c) => c.concept_id), conceptNames)}
        </p>
      )}

      <div className="space-y-2.5 border-t border-border pt-3">
        {changes.map((c) => {
          const before = Math.round(c.before_rating);
          const after = Math.round(c.after_rating);
          const delta = after - before;
          const positive = delta >= 0;
          return (
            <div key={c.concept_id} className="space-y-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                <span className="text-text">{conceptNames?.[c.concept_id] ?? c.concept_id}</span>
                <span className="text-text-dim">
                  {before} <span aria-hidden="true">→</span> <span className="text-text">{after}</span>{" "}
                  {delta !== 0 && (
                    <span className={positive ? "text-verdict-accepted" : "text-verdict-error"}>
                      ({positive ? "+" : "−"}
                      {Math.abs(delta)})
                    </span>
                  )}
                </span>
              </div>
              <RatingMeter
                rating={c.after_rating}
                uncertainty={c.after_uncertainty}
                label={`${conceptNames?.[c.concept_id] ?? c.concept_id} rating`}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
