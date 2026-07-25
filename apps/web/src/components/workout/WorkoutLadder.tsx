import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MasteryChange, Workout, WorkoutItem, WorkoutItemRole, WorkoutItemState } from "@algolift/shared";
import { api } from "../../lib/api";
import { useConcepts } from "../../hooks/useConcepts";
import { Badge, Button, Dialog, Panel } from "../ui";
import type { BadgeTone } from "../ui/Badge";
import { buttonClassName } from "../ui/Button";
import { Plate, type PlateSize } from "../ui/Plate";
import { MasteryDelta } from "../workspace/MasteryDelta";

/**
 * Workout items as a vertical ladder (PLAN.md §8): role badges, rationale sentence, estimated
 * minutes, and state, each rung a rung on the Plate glyph (see components/ui/Plate.tsx). Shared
 * by `/` (standard workouts) and `/diagnostic` (diagnostic workouts) — the skip affordance is
 * prominent and judgment-free either way; `emphasizeSkip` just makes that more explicit in copy
 * for the diagnostic, where skipping unfamiliar material is the expected, useful path.
 */
const ROLE_PLATE_SIZE: Record<WorkoutItemRole, PlateSize> = {
  warmup: "xs",
  working: "md",
  overload: "lg",
  recovery: "sm",
  diagnostic: "md",
};

const ROLE_LABEL: Record<WorkoutItemRole, string> = {
  warmup: "Warm-up",
  working: "Working set",
  overload: "Overload",
  recovery: "Recovery",
  diagnostic: "Diagnostic",
};

const STATE_TONE: Record<WorkoutItemState, BadgeTone> = {
  pending: "neutral",
  active: "accent",
  solved: "accepted",
  skipped_inability: "warn",
  skipped_preference: "neutral",
  gave_up: "error",
};

const STATE_LABEL: Record<WorkoutItemState, string> = {
  pending: "not started",
  active: "in progress",
  solved: "solved",
  skipped_inability: "skipped — didn't know it",
  skipped_preference: "skipped — replaced",
  gave_up: "gave up",
};

function minutesLabel(item: WorkoutItem): string {
  const range = (item.selection_evidence as { expected_active_minutes?: [number, number] }).expected_active_minutes;
  if (!range) return "";
  return `${range[0]}–${range[1]} min`;
}

function titleFor(item: WorkoutItem): string {
  return (item.selection_evidence as { title?: string }).title ?? "Problem";
}

/** "Continue" is reserved for an item actually in progress — every other non-start state (solved,
 * or any of the terminal skipped-inability/skipped-preference/gave-up states) is something to
 * look back at, not resume, so it reads "Review" instead. */
function actionLabel(item: WorkoutItem): string {
  if (item.state === "pending") return "Start";
  if (item.state === "active") return "Continue";
  return "Review";
}

export function WorkoutLadder({ workout, emphasizeSkip = false }: { workout: Workout; emphasizeSkip?: boolean }) {
  const queryClient = useQueryClient();
  const { namesById } = useConcepts();
  // Which pending item's "can't solve this" confirm dialog is open, if any — reason='inability'
  // only (docs/CONTRACTS.md §8: outcome 0 at evidenceWeight 0.5, a real mastery consequence).
  // reason='preference' ("Replace") writes no learning event at all (apps/api/src/routes/
  // workouts.ts skip handler) and stays confirm-free.
  const [confirmItem, setConfirmItem] = useState<WorkoutItem | null>(null);
  const [skipResult, setSkipResult] = useState<{ itemId: string; mastery: MasteryChange } | null>(null);

  const skipMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: "inability" | "preference" }) =>
      api.skipWorkoutItem(id, { reason }),
    onSuccess: (res, variables) => {
      setConfirmItem(null);
      if (res.mastery_change) setSkipResult({ itemId: variables.id, mastery: res.mastery_change });
      void queryClient.invalidateQueries({ queryKey: ["workout", "current"] });
      void queryClient.invalidateQueries({ queryKey: ["progress"] });
    },
  });

  const items = [...(workout.items ?? [])].sort((a, b) => a.position - b.position);
  const summary = (workout.rationale as { summary?: string }).summary;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-5">
        <h1 className="font-display text-xl text-text">{workout.kind === "diagnostic" ? "Diagnostic" : "Today's workout"}</h1>
        {summary && <p className="mt-1 text-sm text-text-dim">{summary}</p>}
        <p className="mt-1 text-xs text-text-faint">
          ~{workout.estimated_minutes ?? "?"} min planned
          {workout.target_minutes ? ` · target ${workout.target_minutes} min` : ""}
        </p>
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
          const skipped =
            item.state === "skipped_inability" || item.state === "skipped_preference" || item.state === "gave_up";
          return (
            <div key={item.id} className="relative flex gap-4 pb-2">
              {!isLast && <div className="absolute left-[13px] top-7 h-[calc(100%-6px)] w-px bg-border" />}
              <Plate
                size={ROLE_PLATE_SIZE[item.role]}
                tone={solved ? "accepted" : skipped ? "neutral" : "accent"}
                filled={solved}
                className="mt-1"
              />
              <Panel className="flex-1 p-3.5">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{ROLE_LABEL[item.role]}</Badge>
                  <Badge tone={STATE_TONE[item.state]}>{STATE_LABEL[item.state]}</Badge>
                  {minutesLabel(item) && <span className="text-xs text-text-faint">{minutesLabel(item)}</span>}
                </div>
                <div className="mb-1 text-sm font-medium text-text">{titleFor(item)}</div>
                <p className="mb-3 text-xs text-text-dim">{item.rationale}</p>
                <div className="flex items-center gap-2">
                  {/* A styled Link, not a Button nested inside one — two interactive elements
                      wrapping each other is invalid HTML (confirmed live: nested <button>/<a>). */}
                  <Link
                    to={`/problem/${item.problem_version_id}?item=${item.id}`}
                    className={buttonClassName({ variant: item.state === "pending" ? "primary" : "secondary", size: "sm" })}
                  >
                    {actionLabel(item)}
                  </Link>
                  {item.state === "pending" && (
                    <>
                      <Button
                        size="sm"
                        variant={emphasizeSkip ? "secondary" : "ghost"}
                        disabled={skipMutation.isPending}
                        onClick={() => setConfirmItem(item)}
                      >
                        {emphasizeSkip ? "Skip — don't know this yet" : "Can't solve this"}
                      </Button>
                      {!emphasizeSkip && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={skipMutation.isPending}
                          onClick={() => skipMutation.mutate({ id: item.id, reason: "preference" })}
                        >
                          Replace
                        </Button>
                      )}
                    </>
                  )}
                </div>
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

      <Dialog open={confirmItem !== null} onClose={() => setConfirmItem(null)} title="Skip this problem?">
        {confirmItem && (
          <div className="space-y-3 text-sm text-text-dim">
            <p>
              This counts as a <strong className="text-verdict-error">miss</strong> and lowers the mastery rating
              for <strong className="text-text">{titleFor(confirmItem)}</strong>'s concepts. There's no undo.
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
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={skipMutation.isPending}
            onClick={() => {
              if (confirmItem) skipMutation.mutate({ id: confirmItem.id, reason: "inability" });
            }}
          >
            {skipMutation.isPending ? "Skipping…" : "Skip"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
