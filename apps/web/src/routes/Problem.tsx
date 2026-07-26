import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GiveUpResponse, Language, SubmissionMode } from "@leetmind/shared";
import { api } from "../lib/api";
import { loadDraft, saveDraft } from "../lib/draft";
import { useActiveTime } from "../hooks/useActiveTime";
import { useConcepts } from "../hooks/useConcepts";
import { useHotkeys } from "../hooks/useHotkeys";
import { useSubmissionEvents } from "../hooks/useSubmissionEvents";
import { Badge, Panel, Tabs, tabPanelProps } from "../components/ui";
import { buttonClassName } from "../components/ui/Button";
import { ActionBar } from "../components/workspace/ActionBar";
import { ConceptTags } from "../components/workspace/ConceptTags";
import { EditorPane } from "../components/workspace/EditorPane";
import { GiveUpControl } from "../components/workspace/GiveUpControl";
import { HintLadder } from "../components/workspace/HintLadder";
import { Markdown } from "../components/workspace/Markdown";
import { MasteryDelta } from "../components/workspace/MasteryDelta";
import { ResultsPanel } from "../components/workspace/ResultsPanel";
import { SplitPane } from "../components/workspace/SplitPane";
import { StatementPane } from "../components/workspace/StatementPane";
import { TestCasePanel } from "../components/workspace/TestCasePanel";

export function Problem() {
  const { versionId } = useParams<{ versionId: string }>();
  const [searchParams] = useSearchParams();
  const baselineItemId = searchParams.get("item") ?? undefined;
  const queryClient = useQueryClient();
  const { namesById } = useConcepts();

  const problemQuery = useQuery({
    queryKey: ["problem", versionId],
    queryFn: () => api.getProblem(versionId!),
    enabled: !!versionId,
  });
  const problem = problemQuery.data?.problem;

  const [leftTab, setLeftTab] = useState<"problem" | "hints">("problem");
  const [language, setLanguage] = useState<Language>("python");
  const [source, setSource] = useState("");
  const [timerHidden, setTimerHidden] = useState(false);
  const [activeSubmissionId, setActiveSubmissionId] = useState<string | null>(null);
  const [activeMode, setActiveMode] = useState<SubmissionMode | null>(null);
  const [gaveUpResult, setGaveUpResult] = useState<GiveUpResponse | null>(null);

  const activeTime = useActiveTime();

  // Flips true the instant a submission is created locally (submitMutation.onSuccess, before the
  // hydration GET below could possibly resolve). Guards that GET from clobbering it: without this,
  // a slow `latestSubmission` fetch resolving with an OLDER submission after the user has already
  // hit Cmd+Enter would overwrite `activeSubmissionId` back to the stale one, silently swapping the
  // just-submitted attempt's live verdict for a previous result. `cancelled` alone doesn't catch
  // this — it only trips on unmount/versionId change, not on "a newer local submission now exists".
  const hasLocalSubmissionRef = useRef(false);

  // Reset per-problem UI state (draft comes back via the effect below) whenever the version changes.
  useEffect(() => {
    activeTime.reset();
    setActiveSubmissionId(null);
    setActiveMode(null);
    setGaveUpResult(null);
    setLeftTab("problem");
    hasLocalSubmissionRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId]);

  // Hydrate from the latest submission on this version (mount, or a reload mid-submission) — the
  // backend already has the verdict; without this the client only ever tracked the active
  // submission id in local, non-persisted React state, so a refresh lost it with no recovery
  // (confirmed live). A stale response from a since-changed `versionId` is dropped rather than
  // clobbering newer local state (the effect's own cleanup flips `cancelled`), and so is a stale
  // response racing a submission the user just created locally (`hasLocalSubmissionRef`).
  useEffect(() => {
    if (!versionId) return;
    let cancelled = false;
    api
      .latestSubmission(versionId)
      .then((res) => {
        if (cancelled || hasLocalSubmissionRef.current || !res.submission) return;
        setActiveSubmissionId(res.submission.id);
        setActiveMode(res.submission.mode);
      })
      .catch(() => {
        // Best-effort — no latest submission to hydrate from is a normal state (never submitted
        // this problem yet), and a transient fetch failure just leaves the workspace empty.
      });
    return () => {
      cancelled = true;
    };
  }, [versionId]);

  // Reaching this problem via a baseline item (`?item=`) never itself transitioned the item to
  // 'active' — nothing downstream (the baseline list, its completion panel) ever advanced past
  // "not started" (confirmed live, docs/QA-PLAN.md §1.2). `startBaselineItem` is idempotent (only
  // flips `pending -> active`, stamps `started_at` once), so firing it unconditionally on mount is
  // safe even on a revisit.
  useEffect(() => {
    if (!baselineItemId) return;
    void api.startBaselineItem(baselineItemId);
  }, [baselineItemId]);

  // Load starter code / draft once the problem and language are known.
  useEffect(() => {
    if (!problem || !versionId) return;
    const draft = loadDraft(versionId, language);
    setSource(draft ?? problem.starter_code[language]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problem?.problem_version_id, language]);

  function handleSourceChange(next: string) {
    setSource(next);
    if (versionId) saveDraft(versionId, language, next);
  }

  const events = useSubmissionEvents(activeSubmissionId, { enabled: !!activeSubmissionId });

  // A plain ref, not `submitMutation.isPending` — React batches the re-render that would flip
  // `isPending`, so two synchronous triggers in the same tick (a rapid double-click, or a click
  // racing the Cmd+Enter hotkey) both read `isPending: false` and both fire. Two 201s, confirmed
  // live. A ref updates immediately, before either handler returns, so the second trigger in the
  // same tick sees the gate already closed.
  const submitInFlightRef = useRef(false);

  const submitMutation = useMutation({
    mutationFn: (input: { mode: SubmissionMode }) =>
      api.createSubmission({
        problem_version_id: versionId!,
        language,
        source,
        mode: input.mode,
        baseline_item_id: baselineItemId,
        active_ms: activeTime.activeMs,
      }),
    onSuccess: (res, variables) => {
      hasLocalSubmissionRef.current = true;
      setActiveSubmissionId(res.submission_id);
      setActiveMode(variables.mode);
    },
    onSettled: () => {
      submitInFlightRef.current = false;
    },
  });

  // The single submitMutation backs both Run and Submit — `isPending` alone doesn't say which, so
  // a Run left Submit's button reading "Submitting…" with Run itself showing nothing (confirmed
  // live). Split by `variables.mode`, the mode of whichever call is actually in flight, so each
  // button only ever reflects its own request.
  const submitPending = submitMutation.isPending && submitMutation.variables?.mode === "submit";
  const runPending = submitMutation.isPending && submitMutation.variables?.mode === "run";

  function triggerSubmit(input: { mode: SubmissionMode }) {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    submitMutation.mutate(input);
  }

  // Global fallback for the two workspace shortcuts (docs/CONTRACTS.md §12). Neither combo has a
  // default Monaco binding, so this is the single place that handles them, whether focus is in
  // the editor, the statement pane, or anywhere else on the page — see EditorPane's doc comment.
  useHotkeys(
    [
      { key: "Enter", meta: true, allowInInputs: true, handler: () => triggerSubmit({ mode: "submit" }) },
      { key: "'", meta: true, allowInInputs: true, handler: () => triggerSubmit({ mode: "run" }) },
    ],
    [versionId, language, source],
  );

  const solved = activeMode === "submit" && events.verdict?.verdict === "accepted";

  // Once a submit-mode submission is accepted, the problem becomes "solved" server-side —
  // refetch so `concepts_revealed` (and the taken hint ladder) reflect that. The practice and
  // baseline queries are invalidated too: this problem is now attempted, so "what's next" has a
  // different answer, and the baseline's next probe is only appended on its next fetch.
  useEffect(() => {
    if (!solved || !versionId) return;
    void queryClient.invalidateQueries({ queryKey: ["problem", versionId] });
    void queryClient.invalidateQueries({ queryKey: ["hints", versionId] });
    void queryClient.invalidateQueries({ queryKey: ["practice", "next"] });
    void queryClient.invalidateQueries({ queryKey: ["baseline", "current"] });
    void queryClient.invalidateQueries({ queryKey: ["progress"] });
  }, [solved, versionId, queryClient]);

  if (!versionId) return null;

  if (problemQuery.isLoading) {
    return <div className="flex h-full items-center justify-center text-text-faint">Loading problem…</div>;
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

  const revealed = problem.concepts_revealed !== null || !!gaveUpResult;
  // A verdict (or a give-up) turns this page into a dead end otherwise: the workspace has nothing
  // left to do and nothing on it routes onward. In the baseline that means back to the remaining
  // probes; in practice it means straight to the next problem, which is the loop.
  const finished = solved || !!gaveUpResult;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-1.5">
        <Link to={baselineItemId ? "/baseline" : "/"} className="text-xs text-text-faint underline hover:text-text-dim">
          {baselineItemId ? "← Back to baseline" : "← Back to practice"}
        </Link>
        {finished && (
          <Link
            to={baselineItemId ? "/baseline" : "/"}
            className={buttonClassName({ variant: "primary", size: "sm" })}
          >
            {baselineItemId ? "Next baseline question" : "Next problem"}
          </Link>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <SplitPane
          left={
            <div className="flex h-full min-h-0 flex-col">
              <Tabs
                id="problem-left"
                tabs={[
                  { id: "problem", label: "Problem" },
                  { id: "hints", label: "Hints" },
                ]}
                active={leftTab}
                onChange={(id) => setLeftTab(id as "problem" | "hints")}
                className="sticky top-0 z-10 bg-bg px-2"
              />
              {leftTab === "problem" ? (
                <div {...tabPanelProps("problem-left", "problem")}>
                  <div className="px-5 pt-4">
                    <ConceptTags revealed={revealed} concepts={problem.concepts_revealed} />
                  </div>
                  <StatementPane problem={problem} />
                </div>
              ) : (
                <div {...tabPanelProps("problem-left", "hints")} className="space-y-5 p-5">
                  <HintLadder versionId={versionId} disabled={revealed} />
                  <GiveUpControl
                    versionId={versionId}
                    activeMs={activeTime.activeMs}
                    baselineItemId={baselineItemId}
                    disabled={revealed}
                    onGaveUp={(result) => {
                      setGaveUpResult(result);
                      void queryClient.invalidateQueries({ queryKey: ["problem", versionId] });
                      void queryClient.invalidateQueries({ queryKey: ["hints", versionId] });
                    }}
                  />
                  {gaveUpResult && (
                    <Panel className="space-y-3 p-4">
                      <div className="flex items-center gap-2">
                        <Badge tone="error">gave up</Badge>
                        <h3 className="text-xs font-medium uppercase tracking-wide text-text-faint">Editorial</h3>
                      </div>
                      <Markdown>{gaveUpResult.editorial_md}</Markdown>
                      {gaveUpResult.mastery_change && (
                        <MasteryDelta
                          changes={gaveUpResult.mastery_change.changes}
                          outcome={gaveUpResult.mastery_change.outcome}
                          explanation={gaveUpResult.mastery_change.explanation}
                          conceptNames={namesById}
                        />
                      )}
                    </Panel>
                  )}
                </div>
              )}
            </div>
          }
          right={
            <div className="flex h-full min-h-0 flex-col">
              <ActionBar
                language={language}
                onLanguageChange={setLanguage}
                onRun={() => triggerSubmit({ mode: "run" })}
                onSubmit={() => triggerSubmit({ mode: "submit" })}
                running={runPending}
                submitting={submitPending}
                activeMs={activeTime.activeMs}
                timerHidden={timerHidden}
                onToggleTimer={() => setTimerHidden((h) => !h)}
              />
              {submitMutation.isError && (
                <div className="flex items-center justify-between gap-3 border-b border-verdict-error bg-verdict-error-dim px-4 py-1.5 text-xs text-text">
                  <span>
                    {submitMutation.error instanceof Error ? submitMutation.error.message : "Couldn't submit — try again."}
                  </span>
                  <button className="shrink-0 underline" onClick={() => submitMutation.reset()}>
                    Dismiss
                  </button>
                </div>
              )}
              <div className="min-h-0 flex-1">
                <EditorPane language={language} value={source} onChange={handleSourceChange} />
              </div>
              {/* One panel, not a Result tab beside a Testcase tab: the cases ARE the result.
                  Each one carries its own mark once a run lands, and the summary above it only
                  adds what a per-case mark cannot say — the verdict, the timings, and how the
                  hidden suite went. */}
              <div className="max-h-[45%] min-h-[180px] overflow-y-auto border-t border-border">
                <ResultsPanel
                  mode={activeMode}
                  status={events.status}
                  progress={events.progress}
                  verdict={events.verdict}
                  connectionState={events.connectionState}
                />
                <TestCasePanel problem={problem} results={events.verdict?.public_results} />
                {events.mastery && (
                  <div className="px-4 pb-4">
                    <MasteryDelta
                      changes={events.mastery.changes}
                      outcome={events.mastery.outcome}
                      explanation={events.mastery.explanation}
                      conceptNames={namesById}
                    />
                  </div>
                )}
              </div>
            </div>
          }
        />
      </div>
    </div>
  );
}
