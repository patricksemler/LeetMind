import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { WorkoutLadder } from "../components/workout/WorkoutLadder";
import { Button, Panel } from "../components/ui";

/** `/diagnostic` — the onboarding flow: a short adaptive baseline where skipping is prominent
 * and judgment-free (PLAN.md §8). */
export function Diagnostic() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const workoutQuery = useQuery({ queryKey: ["workout", "current"], queryFn: api.currentWorkout });

  const startDiagnostic = useMutation({
    mutationFn: () => api.startDiagnostic(),
    onSuccess: (res) => queryClient.setQueryData(["workout", "current"], { workout: res.workout }),
  });

  if (workoutQuery.isLoading) {
    return <div className="flex h-full items-center justify-center text-text-faint">Loading…</div>;
  }

  const workout = workoutQuery.data?.workout;
  const isDiagnostic = workout?.kind === "diagnostic" && workout.status === "active";

  if (isDiagnostic && workout) {
    const items = workout.items ?? [];
    const allDone = items.length > 0 && items.every((i) => i.state !== "pending" && i.state !== "active");
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

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Panel className="max-w-md p-6 text-center">
        <h1 className="font-display text-xl text-text">Diagnostic baseline</h1>
        <p className="mt-2 text-sm text-text-dim">
          ~4–6 short problems, low-to-mid difficulty per concept cluster. Difficulty steps up on success and drops
          fast on a skip — skipping unfamiliar topics is exactly what keeps this short. The result is a set of
          honestly-uncertain starting ratings, not a grade.
        </p>
        <Button variant="primary" className="mt-5" onClick={() => startDiagnostic.mutate()} disabled={startDiagnostic.isPending}>
          Start diagnostic
        </Button>
      </Panel>
    </div>
  );
}
