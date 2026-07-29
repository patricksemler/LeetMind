import { useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isResolved } from "@shared";
import type { GiveUpResponse, ProblemDetail, RatingUpdateView } from "@shared";
import { api } from "../lib/api";
import { loadDraft, saveDraft } from "../lib/draft";
import { useHotkeys } from "../hooks/useHotkeys";
import { CenteredPage, Panel, RouteLoading, SectionLabel } from "../components/ui";
import { buttonClassName } from "../components/ui/Button";
import { GiveUpControl } from "../components/workspace/GiveUpControl";
import { HintLadder } from "../components/workspace/HintLadder";
import { ProblemWorkspace, type WorkspaceTab } from "../components/workspace/ProblemWorkspace";
import type { LastResult } from "../components/workspace/ResultPanel";
import { SolutionPane } from "../components/workspace/SolutionPane";

export function Problem() {
  const { problemId } = useParams<{ problemId: string }>();
  const problemQuery = useQuery({
    queryKey: ["problem", problemId],
    // Opening is idempotent and is the only endpoint that both stamps `served_at` and returns the
    // full view. Refetching it after resolution safely returns the resolved view.
    queryFn: () => api.openProblem(problemId!),
    enabled: !!problemId,
  });

  if (!problemId) return null;
  if (problemQuery.isLoading) return <RouteLoading message="Opening problem…" />;

  if (problemQuery.isError || !problemQuery.data) {
    return (
      <CenteredPage className="flex-col gap-3 text-center text-text-dim">
        <p>Couldn't load that problem.</p>
        <Link to="/" className="text-accent underline">
          Back to practice
        </Link>
      </CenteredPage>
    );
  }

  return (
    <ProblemSession key={problemQuery.data.id} problemId={problemId} problem={problemQuery.data} />
  );
}

function ProblemSession({ problemId, problem }: { problemId: string; problem: ProblemDetail }) {
  const queryClient = useQueryClient();
  const resolved = isResolved(problem);
  const [leftTab, setLeftTab] = useState<WorkspaceTab>("problem");
  const [source, setSource] = useState(() => loadDraft(problemId) ?? problem.starter_code);
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [ratingUpdate, setRatingUpdate] = useState<RatingUpdateView | null>(null);
  const [gaveUp, setGaveUp] = useState<GiveUpResponse | null>(null);

  function handleSourceChange(next: string) {
    setSource(next);
    saveDraft(problemId, next);
  }

  const runMutation = useMutation({
    mutationFn: () => api.run(problemId, { code: source }),
    onSuccess: (res) => {
      setLastResult({
        kind: "run",
        passed: res.passed,
        solved: false,
        results: res.results,
        code: source,
      });
    },
  });

  const submitMutation = useMutation({
    mutationFn: () => api.submit(problemId, { code: source }),
    onSuccess: (res) => {
      setLastResult({
        kind: res.kind,
        passed: res.passed,
        solved: res.solved,
        results: res.results,
        failingCase: res.failing_case,
        code: source,
      });
      if (res.kind === "submit") setLeftTab("results");
      if (res.solved) {
        setRatingUpdate(res.rating_update ?? null);
        void queryClient.invalidateQueries({ queryKey: ["problem", problemId] });
        void queryClient.invalidateQueries({ queryKey: ["me"] });
      }
    },
  });

  function handleHintRevealed(rung: number, text: string) {
    queryClient.setQueryData<ProblemDetail>(["problem", problemId], (prev) => {
      if (!prev || !("revealed_hints" in prev)) return prev;
      const next = [...prev.revealed_hints];
      next[rung - 1] = text;
      return { ...prev, revealed_hints: next };
    });
  }

  function handleGaveUp(res: GiveUpResponse) {
    setGaveUp(res);
    setRatingUpdate(res.rating_update);
    void queryClient.invalidateQueries({ queryKey: ["problem", problemId] });
    void queryClient.invalidateQueries({ queryKey: ["me"] });
  }

  // Stops a click racing its keyboard shortcut before React Query updates `isPending`.
  const actionInFlightRef = useRef(false);
  const attemptOver = resolved || !!gaveUp;
  function guarded(run: () => void) {
    if (actionInFlightRef.current || attemptOver) return;
    actionInFlightRef.current = true;
    run();
  }
  function triggerRun() {
    guarded(() =>
      runMutation.mutate(undefined, { onSettled: () => (actionInFlightRef.current = false) }),
    );
  }
  function triggerSubmit() {
    guarded(() =>
      submitMutation.mutate(undefined, { onSettled: () => (actionInFlightRef.current = false) }),
    );
  }

  useHotkeys(
    [
      { key: "Enter", meta: true, allowInInputs: true, handler: triggerSubmit },
      { key: "'", meta: true, allowInInputs: true, handler: triggerRun },
    ],
    [problemId, source, attemptOver],
  );

  const revealedHints = isResolved(problem) ? problem.hints : problem.revealed_hints;
  const referenceSolution =
    gaveUp?.reference_solution ?? (isResolved(problem) ? problem.reference_solution : null);
  const actionError = runMutation.error ?? submitMutation.error;

  return (
    <ProblemWorkspace
      problem={problem}
      source={source}
      onSourceChange={handleSourceChange}
      activeTab={leftTab}
      onTabChange={setLeftTab}
      tabsTrailing={
        resolved ? (
          <Link to="/" className={buttonClassName({ variant: "primary", size: "sm" })}>
            Next problem
          </Link>
        ) : null
      }
      problemTools={
        <>
          <section className="space-y-3">
            <SectionLabel>Hints</SectionLabel>
            <HintLadder
              problemId={problemId}
              revealedHints={revealedHints}
              disabled={resolved}
              onRevealed={handleHintRevealed}
            />
          </section>
          {(!resolved || referenceSolution) && <div className="border-t border-border" />}
          {!resolved && !gaveUp && <GiveUpControl problemId={problemId} onGaveUp={handleGaveUp} />}
          {referenceSolution && (
            <Panel className="space-y-3 p-4">
              <SectionLabel>Solution</SectionLabel>
              <SolutionPane referenceSolution={referenceSolution} />
            </Panel>
          )}
        </>
      }
      result={lastResult}
      ratingUpdate={ratingUpdate}
      onRun={triggerRun}
      onSubmit={triggerSubmit}
      running={runMutation.isPending}
      submitting={submitMutation.isPending}
      runDisabled={attemptOver}
      submitDisabled={attemptOver}
      actionErrorMessage={
        actionError instanceof Error
          ? actionError.message
          : actionError
            ? "Something went wrong — try again."
            : null
      }
      onDismissActionError={() => {
        runMutation.reset();
        submitMutation.reset();
      }}
    />
  );
}
