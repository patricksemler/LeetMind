import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useConcepts } from "../hooks/useConcepts";
import { WorkoutLadder } from "../components/workout/WorkoutLadder";
import { Button, Panel } from "../components/ui";

/**
 * `/` — Today. Shows the active workout as a ladder; if none is active but the user has some
 * concept history, offers to start one; if the user has no concept state at all yet, prompts the
 * diagnostic instead (PLAN.md §8 / docs/CONTRACTS.md §12).
 */
export function Today() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { namesById } = useConcepts();

  const workoutQuery = useQuery({ queryKey: ["workout", "current"], queryFn: api.currentWorkout });
  const progressQuery = useQuery({ queryKey: ["progress"], queryFn: api.progress });

  const createWorkout = useMutation({
    mutationFn: () => api.createWorkout({}),
    onSuccess: (res) => queryClient.setQueryData(["workout", "current"], { workout: res.workout }),
  });

  const startDiagnostic = useMutation({
    mutationFn: () => api.startDiagnostic(),
    onSuccess: (res) => {
      queryClient.setQueryData(["workout", "current"], { workout: res.workout });
      navigate("/diagnostic");
    },
  });

  if (workoutQuery.isLoading || progressQuery.isLoading) {
    return <div className="flex h-full items-center justify-center text-text-faint">Loading…</div>;
  }

  // A fetch failure used to fall straight through to "no progress yet" below (an empty
  // `concepts` array reads identically to a genuinely new user) — a returning user hitting a
  // transient network error saw the onboarding diagnostic prompt instead of their actual workout.
  if (workoutQuery.isError || progressQuery.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-text-dim">
        <p>Couldn't load today's workout.</p>
        <button
          className="text-accent underline"
          onClick={() => {
            void workoutQuery.refetch();
            void progressQuery.refetch();
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  const workout = workoutQuery.data?.workout;
  if (workout && workout.status === "active") {
    return (
      <div className="h-full overflow-y-auto">
        <WorkoutLadder workout={workout} />
      </div>
    );
  }

  const concepts = progressQuery.data?.concepts ?? [];
  const hasAnyProgress = concepts.some((c) => Number(c.attempts ?? 0) > 0);

  if (!hasAnyProgress) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Panel className="max-w-md p-6 text-center">
          <h1 className="font-display text-xl text-text">Let's find your baseline</h1>
          <p className="mt-2 text-sm text-text-dim">
            A short adaptive diagnostic (~4–6 problems) seeds honest starting ratings per concept. Skip anything
            unfamiliar — that's useful signal, not a failure.
          </p>
          <Button variant="primary" className="mt-5" onClick={() => startDiagnostic.mutate()} disabled={startDiagnostic.isPending}>
            Start diagnostic
          </Button>
        </Panel>
      </div>
    );
  }

  const weakest = [...concepts].sort((a, b) => Number(a.rating ?? 1200) - Number(b.rating ?? 1200))[0];

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Panel className="max-w-md p-6 text-center">
        <h1 className="font-display text-xl text-text">Ready for today's workout</h1>
        <p className="mt-2 text-sm text-text-dim">
          {weakest
            ? `A warm-up, two working-set problems on ${weakest.name ?? namesById[String(weakest.concept_id)] ?? weakest.concept_id}, and an overload rep.`
            : "A warm-up, a couple of working-set problems, and an overload rep."}
        </p>
        <Button variant="primary" className="mt-5" onClick={() => createWorkout.mutate()} disabled={createWorkout.isPending}>
          Start workout
        </Button>
      </Panel>
    </div>
  );
}
