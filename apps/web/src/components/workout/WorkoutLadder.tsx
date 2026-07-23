import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Workout, WorkoutItem, WorkoutItemRole, WorkoutItemState } from "@algolift/shared";
import { api } from "../../lib/api";
import { Badge, Button, Panel } from "../ui";
import type { BadgeTone } from "../ui/Badge";
import { Plate, type PlateSize } from "../ui/Plate";

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

export function WorkoutLadder({ workout, emphasizeSkip = false }: { workout: Workout; emphasizeSkip?: boolean }) {
  const queryClient = useQueryClient();
  const skipMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: "inability" | "preference" }) =>
      api.skipWorkoutItem(id, { reason }),
    onSuccess: () => {
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
                  <Link to={`/problem/${item.problem_version_id}?item=${item.id}`}>
                    <Button size="sm" variant={item.state === "pending" ? "primary" : "secondary"}>
                      {item.state === "pending" ? "Start" : solved ? "Review" : "Continue"}
                    </Button>
                  </Link>
                  {item.state === "pending" && (
                    <>
                      <Button
                        size="sm"
                        variant={emphasizeSkip ? "secondary" : "ghost"}
                        onClick={() => skipMutation.mutate({ id: item.id, reason: "inability" })}
                      >
                        {emphasizeSkip ? "Skip — don't know this yet" : "Can't solve this"}
                      </Button>
                      {!emphasizeSkip && (
                        <Button size="sm" variant="ghost" onClick={() => skipMutation.mutate({ id: item.id, reason: "preference" })}>
                          Replace
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </Panel>
            </div>
          );
        })}
      </div>
    </div>
  );
}
