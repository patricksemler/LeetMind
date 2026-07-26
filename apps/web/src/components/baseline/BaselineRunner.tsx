import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BaselineItem, BaselineItemState, BaselineSession, MasteryChange } from "@leetmind/shared";
import { api } from "../../lib/api";
import { useConcepts } from "../../hooks/useConcepts";
import { Badge, Button, Dialog, Panel } from "../ui";
import type { BadgeTone } from "../ui/Badge";
import { buttonClassName } from "../ui/Button";
import { Plate } from "../ui/Plate";
import { MasteryDelta } from "../workspace/MasteryDelta";

/**
 * The baseline as a running list of probes: what has been answered, and the one thing to do next.
 *
 * The design constraint that shapes everything here is that **skipping must be as easy as
 * attempting** (PLAN.md §8). A baseline where skipping feels like failure produces dishonest
 * ratings, because a user who doesn't recognise a topic will guess, or grind, rather than admit
 * it — and the resulting rating is then wrong in the direction that makes practice useless. So the
 * skip button sits beside the start button at equal weight, its copy names the feeling
 * ("Haven't learned this yet") rather than the failure, and the confirm dialog explains what the
 * skip *buys* instead of warning about what it costs.
 */

const STATE_TONE: Record<BaselineItemState, BadgeTone> = {
  pending: "neutral",
  active: "accent",
  solved: "accepted",
  skipped_inability: "warn",
  skipped_preference: "neutral",
  gave_up: "error",
};

const STATE_LABEL: Record<BaselineItemState, string> = {
  pending: "up next",
  active: "in progress",
  solved: "solved",
  skipped_inability: "skipped — not learned yet",
  skipped_preference: "skipped",
  gave_up: "gave up",
};

function minutesLabel(item: BaselineItem): string {
  const range = (item.selection_evidence as { expected_active_minutes?: [number, number] }).expected_active_minutes;
  if (!range) return "";
  return `${range[0]}–${range[1]} min`;
}

function titleFor(item: BaselineItem): string {
  return (item.selection_evidence as { title?: string }).title ?? "Problem";
}

function conceptFor(item: BaselineItem): string | null {
  return (item.selection_evidence as { concept_id?: string }).concept_id ?? null;
}

function isResolved(item: BaselineItem): boolean {
  return item.state !== "pending" && item.state !== "active";
}

export function BaselineRunner({ baseline }: { baseline: BaselineSession }) {
  const queryClient = useQueryClient();
  const { namesById } = useConcepts();
  const [confirmItem, setConfirmItem] = useState<BaselineItem | null>(null);
  const [skipResult, setSkipResult] = useState<{ itemId: string; mastery: MasteryChange } | null>(null);

  const skipMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: "inability" | "preference" }) =>
      api.skipBaselineItem(id, { reason }),
    onSuccess: (res, variables) => {
      setConfirmItem(null);
      if (res.mastery_change) setSkipResult({ itemId: variables.id, mastery: res.mastery_change });
      // The next probe is appended server-side by the very next GET, so refetch rather than
      // patching the cache — the new item only exists after that round trip.
      void queryClient.invalidateQueries({ queryKey: ["baseline", "current"] });
      void queryClient.invalidateQueries({ queryKey: ["progress"] });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });

  const items = [...(baseline.items ?? [])].sort((a, b) => a.position - b.position);
  const summary = (baseline.rationale as { summary?: string }).summary;
  const resolvedCount = items.filter(isResolved).length;
  const plannedCount = Math.max(baseline.planned_count ?? 0, items.length);
  const current = items.find((i) => !isResolved(i)) ?? null;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-5">
        <h1 className="font-display text-xl text-text">Baseline</h1>
        {summary && <p className="mt-1 text-sm text-text-dim">{summary}</p>}
        <p className="mt-2 text-xs text-text-faint" aria-live="polite">
          {resolvedCount} of {plannedCount || "?"} answered
        </p>
        {plannedCount > 0 && (
          <div
            className="mt-2 h-1 w-full overflow-hidden rounded bg-bg-overlay"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={plannedCount}
            aria-valuenow={resolvedCount}
            aria-label="Baseline progress"
          >
            <div
              className="h-full bg-accent transition-[width] duration-300"
              style={{ width: `${Math.min(100, (resolvedCount / plannedCount) * 100)}%` }}
            />
          </div>
        )}
      </div>

      {skipMutation.isError && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-verdict-error bg-verdict-error-dim px-3 py-2 text-xs text-text">
          <span>
            {skipMutation.error instanceof Error ? skipMutation.error.message : "Couldn't skip that problem — try again."}
          </span>
          <button className="shrink-0 underline" onClick={() => skipMutation.reset()}>
            Dismiss
          </button>
        </div>
      )}

      <div className="space-y-2">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          const solved = item.state === "solved";
          const resolved = isResolved(item);
          const isCurrent = current?.id === item.id;
          const concept = conceptFor(item);
          return (
            <div key={item.id} className="relative flex gap-4 pb-2">
              {!isLast && <div className="absolute left-[13px] top-7 h-[calc(100%-6px)] w-px bg-border" />}
              <Plate
                size="md"
                tone={solved ? "accepted" : resolved ? "neutral" : "accent"}
                filled={solved}
                className="mt-1"
              />
              <Panel className={`flex-1 p-3.5 ${isCurrent ? "border-accent" : ""}`}>
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  {concept && <Badge tone="neutral">{namesById[concept] ?? concept}</Badge>}
                  <Badge tone={STATE_TONE[item.state]}>{STATE_LABEL[item.state]}</Badge>
                  {minutesLabel(item) && <span className="text-xs text-text-faint">{minutesLabel(item)}</span>}
                </div>
                <div className="mb-1 text-sm font-medium text-text">{titleFor(item)}</div>
                <p className="mb-3 text-xs text-text-dim">{item.rationale}</p>

                {!resolved && (
                  <div className="flex flex-wrap items-center gap-2">
                    {/* A styled Link, not a Button nested inside one — two interactive elements
                        wrapping each other is invalid HTML. */}
                    <Link
                      to={`/problem/${item.problem_version_id}?item=${item.id}`}
                      className={buttonClassName({ variant: "primary", size: "sm" })}
                    >
                      {item.state === "active" ? "Continue" : "Try it"}
                    </Link>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={skipMutation.isPending}
                      onClick={() => setConfirmItem(item)}
                    >
                      Haven't learned this yet
                    </Button>
                  </div>
                )}
                {resolved && (
                  <Link
                    to={`/problem/${item.problem_version_id}?item=${item.id}`}
                    className="text-xs text-text-faint underline hover:text-text-dim"
                  >
                    Review
                  </Link>
                )}

                {skipResult?.itemId === item.id && (
                  <div className="mt-3">
                    <MasteryDelta
                      changes={skipResult.mastery.changes}
                      outcome={skipResult.mastery.outcome}
                      explanation={skipResult.mastery.explanation}
                      conceptNames={namesById}
                    />
                  </div>
                )}
              </Panel>
            </div>
          );
        })}
      </div>

      <Dialog open={confirmItem !== null} onClose={() => setConfirmItem(null)} title="Skip this one?">
        {confirmItem && (
          <div className="space-y-3 text-sm text-text-dim">
            <p>
              That's useful information, not a failure — it tells the model to start you{" "}
              <strong className="text-text">lower</strong> on{" "}
              <strong className="text-text">
                {namesById[conceptFor(confirmItem) ?? ""] ?? conceptFor(confirmItem) ?? "this concept"}
              </strong>{" "}
              instead of guessing.
            </p>
            <p className="text-xs text-text-faint">
              It lowers the starting rating for that concept, and lowers the uncertainty around it. Practice keeps
              adjusting both from here.
            </p>
          </div>
        )}
        {skipMutation.isError && (
          <p className="mt-3 text-sm text-verdict-error">
            {skipMutation.error instanceof Error ? skipMutation.error.message : "Couldn't skip this problem."}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmItem(null)}>
            Let me try
          </Button>
          <Button
            variant="primary"
            disabled={skipMutation.isPending}
            onClick={() => {
              if (confirmItem) skipMutation.mutate({ id: confirmItem.id, reason: "inability" });
            }}
          >
            {skipMutation.isPending ? "Skipping…" : "Skip it"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
