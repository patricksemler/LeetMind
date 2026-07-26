import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { BaselineRunner } from "../components/baseline/BaselineRunner";
import { Button, Panel } from "../components/ui";

/**
 * `/baseline` — the first-run experience and the only onboarding the app has.
 *
 * The whole flow is one adaptive probe at a time: answer or skip, and the next problem is chosen
 * from what that told us. Skipping is the encouraged path for anything unfamiliar, which is what
 * keeps the baseline short — a user who skips three topics is done in a few minutes with genuinely
 * useful ratings, rather than grinding through six problems they can't do.
 */
export function Baseline() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const baselineQuery = useQuery({ queryKey: ["baseline", "current"], queryFn: api.currentBaseline });

  const startBaseline = useMutation({
    mutationFn: () => api.startBaseline(),
    onSuccess: (res) => {
      queryClient.setQueryData(["baseline", "current"], { baseline: res.baseline });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });

  if (baselineQuery.isLoading) {
    return <div className="flex h-full items-center justify-center text-text-faint">Loading…</div>;
  }

  if (baselineQuery.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-text-dim">
        <p>Couldn't load the baseline.</p>
        <button className="text-accent underline" onClick={() => void baselineQuery.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const baseline = baselineQuery.data?.baseline;
  const items = baseline?.items ?? [];
  // `status` flips to 'completed' in the SAME request that resolves the last probe (GET
  // /api/baseline/current's adaptive-stepping side effect), so a 'completed' session still has to
  // render — otherwise finishing the baseline would bounce the user back to the start card with
  // no acknowledgment that they just finished.
  const isRunning = baseline && (baseline.status === "active" || baseline.status === "completed");

  if (isRunning && baseline) {
    const allDone =
      baseline.status === "completed" ||
      (items.length > 0 && items.every((i) => i.state !== "pending" && i.state !== "active"));
    const answered = items.filter((i) => i.state === "solved").length;
    const skipped = items.filter((i) => i.state === "skipped_inability" || i.state === "skipped_preference").length;

    return (
      <div className="h-full overflow-y-auto">
        <BaselineRunner baseline={baseline} />
        {allDone && (
          <div className="mx-auto max-w-2xl px-6 pb-8">
            <Panel className="p-5 text-center">
              <h2 className="font-display text-lg text-text">Baseline set</h2>
              <p className="mt-2 text-sm text-text-dim">
                {items.length === 0
                  ? "No problems were available to probe with yet — practice will generate them as you go."
                  : `${answered} solved, ${skipped} skipped. That's enough to start targeting your edge; ratings keep adjusting from here.`}
              </p>
              <Button variant="primary" className="mt-4" onClick={() => navigate("/")}>
                Start practising
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
        <h1 className="font-display text-xl text-text">Set your baseline</h1>
        <p className="mt-2 text-sm text-text-dim">
          A handful of short problems across the core pattern families. Difficulty steps up when you solve one and
          drops fast when you skip.
        </p>
        <p className="mt-3 text-sm text-text-dim">
          <strong className="text-text">Skip anything you haven't learned yet.</strong> That's the fastest way
          through, and it's real information — the result is a set of honestly-uncertain starting ratings, not a
          grade.
        </p>
        {startBaseline.isError && (
          <p className="mt-3 text-sm text-verdict-error">
            {startBaseline.error instanceof Error ? startBaseline.error.message : "Couldn't start the baseline."}
          </p>
        )}
        <Button
          variant="primary"
          className="mt-5"
          onClick={() => startBaseline.mutate()}
          disabled={startBaseline.isPending}
        >
          {startBaseline.isPending ? "Starting…" : "Start baseline"}
        </Button>
      </Panel>
    </div>
  );
}
