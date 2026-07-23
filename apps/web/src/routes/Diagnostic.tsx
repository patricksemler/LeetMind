import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { WorkoutLadder } from "../components/workout/WorkoutLadder";
import { Button, Dialog, Panel } from "../components/ui";

/** `/diagnostic` — the onboarding flow: a short adaptive baseline where skipping is prominent
 * and judgment-free (PLAN.md §8). */
export function Diagnostic() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmAbandonOpen, setConfirmAbandonOpen] = useState(false);

  const workoutQuery = useQuery({ queryKey: ["workout", "current"], queryFn: api.currentWorkout });

  const startDiagnostic = useMutation({
    mutationFn: () => api.startDiagnostic(),
    onSuccess: (res) => {
      setConfirmAbandonOpen(false);
      queryClient.setQueryData(["workout", "current"], { workout: res.workout });
    },
  });

  if (workoutQuery.isLoading) {
    return <div className="flex h-full items-center justify-center text-text-faint">Loading…</div>;
  }

  if (workoutQuery.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-text-dim">
        <p>Couldn't load the diagnostic.</p>
        <button className="text-accent underline" onClick={() => workoutQuery.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const workout = workoutQuery.data?.workout;
  // `status` flips to 'completed' in the SAME request that resolves the diagnostic's last item
  // (GET /api/workouts/current's adaptive-stepping side effect) — render the just-finished flow
  // too, not only 'active', or the completion panel below is never reachable: the user would see
  // the "Start diagnostic" onboarding card again with zero acknowledgment that they just finished.
  const isDiagnostic = workout?.kind === "diagnostic" && (workout.status === "active" || workout.status === "completed");

  if (isDiagnostic && workout) {
    const items = workout.items ?? [];
    const allDone = workout.status === "completed" || (items.length > 0 && items.every((i) => i.state !== "pending" && i.state !== "active"));
    return (
      <div className="h-full overflow-y-auto">
        <WorkoutLadder workout={workout} emphasizeSkip />
        {allDone && (
          <div className="mx-auto max-w-2xl px-6 pb-8">
            <Panel className="p-4 text-center">
              <p className="mb-3 text-sm text-text-dim">
                Baseline set. Ratings will keep adjusting as you practice — this just gets you started honestly.
              </p>
              <Button variant="primary" onClick={() => navigate("/")}>
                Go to Today
              </Button>
            </Panel>
          </div>
        )}
      </div>
    );
  }

  // Starting a diagnostic abandons any other active workout server-side (POST /api/diagnostic/start
  // unconditionally calls abandonWorkout on it) — warn first rather than silently discarding
  // in-progress standard-workout state.
  const hasActiveOtherWorkout = workout?.status === "active" && workout.kind !== "diagnostic";

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Panel className="max-w-md p-6 text-center">
        <h1 className="font-display text-xl text-text">Diagnostic baseline</h1>
        <p className="mt-2 text-sm text-text-dim">
          ~4–6 short problems, low-to-mid difficulty per concept cluster. Difficulty steps up on success and drops
          fast on a skip — skipping unfamiliar topics is exactly what keeps this short. The result is a set of
          honestly-uncertain starting ratings, not a grade.
        </p>
        <Button
          variant="primary"
          className="mt-5"
          onClick={() => (hasActiveOtherWorkout ? setConfirmAbandonOpen(true) : startDiagnostic.mutate())}
          disabled={startDiagnostic.isPending}
        >
          Start diagnostic
        </Button>
      </Panel>

      <Dialog open={confirmAbandonOpen} onClose={() => setConfirmAbandonOpen(false)} title="Abandon your current workout?">
        <div className="space-y-3 text-sm text-text-dim">
          <p>
            You have an active workout in progress. Starting the diagnostic baseline will{" "}
            <strong className="text-text">abandon it</strong> — any unfinished items are dropped, not saved for later.
          </p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmAbandonOpen(false)}>
            Keep my workout
          </Button>
          <Button variant="danger" onClick={() => startDiagnostic.mutate()} disabled={startDiagnostic.isPending}>
            {startDiagnostic.isPending ? "Starting…" : "Abandon & start diagnostic"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
