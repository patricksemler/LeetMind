import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isResolved } from "@shared";
import type { GiveUpResponse, ProblemDetail, RatingUpdateView } from "@shared";
import { api } from "../lib/api";
import { loadDraft, saveDraft } from "../lib/draft";
import { useHotkeys } from "../hooks/useHotkeys";
import { Panel, RouteLoading, Tabs, tabPanelProps } from "../components/ui";
import { buttonClassName } from "../components/ui/Button";
import { ActionBar } from "../components/workspace/ActionBar";
import { EditorPane } from "../components/workspace/EditorPane";
import { GiveUpControl } from "../components/workspace/GiveUpControl";
import { HintLadder } from "../components/workspace/HintLadder";
import { RatingUpdatePanel } from "../components/workspace/RatingUpdatePanel";
import { ResultPanel, type LastResult } from "../components/workspace/ResultPanel";
import { SolutionPane } from "../components/workspace/SolutionPane";
import { SplitPane } from "../components/workspace/SplitPane";
import { StatementPane } from "../components/workspace/StatementPane";
import { TestCasePanel } from "../components/workspace/TestCasePanel";

/** No "hints" tab: the ladder and the give-up/solution flow live under the statement in "problem",
 * where they're read against the thing they're hints about. */
type LeftTab = "problem" | "results";

export function Problem() {
  const { problemId } = useParams<{ problemId: string }>();
  const queryClient = useQueryClient();

  // `POST .../open` rather than a GET (PLAN_BACKEND.md amendment 41): `next` only ever supplies a
  // stub id, and `open` is the one call that both stamps `served_at` (starting the timer) and
  // returns the full view — idempotent afterwards, so refetching through the same call after a
  // solve or give-up is exactly as safe as a GET and comes back as the resolved view once the
  // server says so.
  const problemQuery = useQuery({
    queryKey: ["problem", problemId],
    queryFn: () => api.openProblem(problemId!),
    enabled: !!problemId,
  });
  const problem = problemQuery.data;
  const resolved = problem ? isResolved(problem) : false;

  const [leftTab, setLeftTab] = useState<LeftTab>("problem");
  const [source, setSource] = useState("");
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [ratingUpdate, setRatingUpdate] = useState<RatingUpdateView | null>(null);
  const [gaveUp, setGaveUp] = useState<GiveUpResponse | null>(null);

  // Reset per-problem UI state whenever the route moves to another problem (the draft comes back
  // via the effect below, from storage rather than from here).
  useEffect(() => {
    setLeftTab("problem");
    setLastResult(null);
    setRatingUpdate(null);
    setGaveUp(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemId]);

  // Load starter code / draft once the problem is known.
  useEffect(() => {
    if (!problem || !problemId) return;
    const draft = loadDraft(problemId);
    setSource(draft ?? problem.starter_code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problem?.id]);

  function handleSourceChange(next: string) {
    setSource(next);
    if (problemId) saveDraft(problemId, next);
  }

  const runMutation = useMutation({
    mutationFn: () => api.run(problemId!, { code: source }),
    onSuccess: (res) => {
      setLastResult({ kind: "run", passed: res.passed, solved: false, results: res.results, code: source });
    },
  });

  const submitMutation = useMutation({
    mutationFn: () => api.submit(problemId!, { code: source }),
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

  // Guards a rapid double-click (or the click racing the Cmd+Enter hotkey) from firing two
  // requests in the same tick — the server's own per-user in-flight guard would just 409 the
  // second one, but there's no reason to round-trip for that.
  const actionInFlightRef = useRef(false);
  const attemptOver = resolved || !!gaveUp;
  function guarded(run: () => void) {
    if (actionInFlightRef.current || attemptOver) return;
    actionInFlightRef.current = true;
    run();
  }
  function triggerRun() {
    guarded(() => runMutation.mutate(undefined, { onSettled: () => (actionInFlightRef.current = false) }));
  }
  function triggerSubmit() {
    guarded(() => submitMutation.mutate(undefined, { onSettled: () => (actionInFlightRef.current = false) }));
  }

  useHotkeys(
    [
      { key: "Enter", meta: true, allowInInputs: true, handler: triggerSubmit },
      { key: "'", meta: true, allowInInputs: true, handler: triggerRun },
    ],
    [problemId, source, attemptOver],
  );

  if (!problemId) return null;

  if (problemQuery.isLoading) {
    return <RouteLoading message="Opening problem…" />;
  }

  if (problemQuery.isError || !problem) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-text-dim">
        <p>Couldn't load that problem.</p>
        <Link to="/" className="text-accent underline">
          Back to practice
        </Link>
      </div>
    );
  }

  const revealedHints = isResolved(problem) ? problem.hints : problem.revealed_hints;
  const referenceSolution = gaveUp?.reference_solution ?? (isResolved(problem) ? problem.reference_solution : null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <SplitPane
          storageKey="workspace-split"
          first={
            <div className="flex h-full min-h-0 flex-col">
              <Tabs
                id="problem-left"
                tabs={[
                  { id: "problem", label: "Problem" },
                  { id: "results", label: "Result" },
                ]}
                active={leftTab}
                onChange={(id) => setLeftTab(id as LeftTab)}
                className="sticky top-0 z-10 bg-bg px-2"
                trailing={
                  resolved ? (
                    <Link to="/" className={buttonClassName({ variant: "primary", size: "sm" })}>
                      Next problem
                    </Link>
                  ) : null
                }
              />
              {leftTab === "problem" ? (
                <div {...tabPanelProps("problem-left", "problem")}>
                  <div className="space-y-6 p-5">
                    <StatementPane problem={problem} />
                    <section className="space-y-3">
                      <h3 className="text-xs font-medium uppercase tracking-wide text-text-faint">
                        Hints
                      </h3>
                      <HintLadder
                        problemId={problemId}
                        revealedHints={revealedHints}
                        disabled={resolved}
                        onRevealed={handleHintRevealed}
                      />
                    </section>
                    {(!resolved || referenceSolution) && <div className="border-t border-border" />}
                    {!resolved && !gaveUp && (
                      <GiveUpControl problemId={problemId} onGaveUp={handleGaveUp} />
                    )}
                    {referenceSolution && (
                      <Panel className="space-y-3 p-4">
                        <h3 className="text-xs font-medium uppercase tracking-wide text-text-faint">
                          Solution
                        </h3>
                        <SolutionPane referenceSolution={referenceSolution} />
                      </Panel>
                    )}
                  </div>
                </div>
              ) : (
                <div {...tabPanelProps("problem-left", "results")}>
                  <ResultPanel problem={problem} result={lastResult} />
                  {/* Lives beside the verdict it explains, not under the statement two tabs away
                      — the Result tab is exactly where a "why did my rating move" question gets
                      asked. */}
                  {ratingUpdate && (
                    <div className="px-5 pb-5">
                      <RatingUpdatePanel update={ratingUpdate} />
                    </div>
                  )}
                </div>
              )}
            </div>
          }
          second={
            <div className="flex h-full min-h-0 flex-col">
              <ActionBar
                onRun={triggerRun}
                onSubmit={triggerSubmit}
                running={runMutation.isPending}
                submitting={submitMutation.isPending}
                disabled={attemptOver}
              />
              {(runMutation.isError || submitMutation.isError) && (
                <div className="flex items-center justify-between gap-3 border-b border-verdict-error bg-verdict-error-dim px-4 py-1.5 text-xs text-text">
                  <span>
                    {(runMutation.error ?? submitMutation.error) instanceof Error
                      ? (runMutation.error ?? submitMutation.error)?.message
                      : "Something went wrong — try again."}
                  </span>
                  <button
                    className="shrink-0 underline"
                    onClick={() => {
                      runMutation.reset();
                      submitMutation.reset();
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              )}
              <div className="min-h-0 flex-1">
                <SplitPane
                  orientation="vertical"
                  storageKey="workspace-split-cases"
                  initialFirstPct={62}
                  minFirstPct={25}
                  maxFirstPct={85}
                  first={<EditorPane value={source} onChange={handleSourceChange} />}
                  second={<TestCasePanel problem={problem} results={lastResult?.results} />}
                />
              </div>
            </div>
          }
        />
      </div>
    </div>
  );
}
