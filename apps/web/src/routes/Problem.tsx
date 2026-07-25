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
import { ActionBar } from "../components/workspace/ActionBar";
import { ConceptTags } from "../components/workspace/ConceptTags";
import { CustomInputDialog } from "../components/workspace/CustomInputDialog";
import { EditorPane } from "../components/workspace/EditorPane";
import { GiveUpControl } from "../components/workspace/GiveUpControl";
import { HintLadder } from "../components/workspace/HintLadder";
import { Markdown } from "../components/workspace/Markdown";
import { MasteryDelta } from "../components/workspace/MasteryDelta";
import { ResultsPanel } from "../components/workspace/ResultsPanel";
import { SplitPane } from "../components/workspace/SplitPane";
import { StatementPane } from "../components/workspace/StatementPane";

export function Problem() {
  const { versionId } = useParams<{ versionId: string }>();
  const [searchParams] = useSearchParams();
  const workoutItemId = searchParams.get("item") ?? undefined;
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
  const [customInputOpen, setCustomInputOpen] = useState(false);
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

  // Reaching this problem via a workout/diagnostic item (`?item=`) never itself transitioned the
  // item to 'active' — nothing downstream (the Today ladder, "workout exhausted" screen,
  // diagnostic completion) ever advanced past "NOT STARTED" (confirmed live, docs/QA-PLAN.md
  // §1.2). `startWorkoutItem` is idempotent (only flips `pending -> active`, stamps `started_at`
  // once), so firing it unconditionally on mount is safe even on a revisit.
  useEffect(() => {
    if (!workoutItemId) return;
    void api.startWorkoutItem(workoutItemId);
  }, [workoutItemId]);

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
    mutationFn: (input: { mode: SubmissionMode; customInput?: unknown }) =>
      api.createSubmission({
        problem_version_id: versionId!,
        language,
        source,
        mode: input.mode,
        custom_input: input.customInput,
        workout_item_id: workoutItemId,
        active_ms: activeTime.activeMs,
      }),
    onSuccess: (res, variables) => {
      hasLocalSubmissionRef.current = true;
      setActiveSubmissionId(res.submission_id);
      setActiveMode(variables.mode);
      // A "run" (custom input) submission closes its own dialog once it's actually in flight —
      // "submit" has no dialog to close.
      if (variables.mode === "run") setCustomInputOpen(false);
    },
    onSettled: () => {
      submitInFlightRef.current = false;
    },
  });

  // The single submitMutation backs both Submit and custom-input Run — `isPending` alone doesn't
  // say which, so a Run left Submit's button reading "Submitting…" with Run itself showing
  // nothing (confirmed live). Split by `variables.mode`, the mode of whichever call is actually
  // in flight, so each button only ever reflects its own request.
  const submitPending = submitMutation.isPending && submitMutation.variables?.mode === "submit";
  const runPending = submitMutation.isPending && submitMutation.variables?.mode === "run";

  function triggerSubmit(input: { mode: SubmissionMode; customInput?: unknown }) {
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
      { key: "'", meta: true, allowInInputs: true, handler: () => setCustomInputOpen(true) },
    ],
    [versionId, language, source],
  );

  // Once a submit-mode submission is accepted, the problem becomes "solved" server-side —
  // refetch so `concepts_revealed` (and the taken hint ladder) reflect that.
  useEffect(() => {
    if (activeMode === "submit" && events.verdict?.verdict === "accepted" && versionId) {
      void queryClient.invalidateQueries({ queryKey: ["problem", versionId] });
      void queryClient.invalidateQueries({ queryKey: ["hints", versionId] });
    }
  }, [activeMode, events.verdict, versionId, queryClient]);

  if (!versionId) return null;

  if (problemQuery.isLoading) {
    return <div className="flex h-full items-center justify-center text-text-faint">Loading problem…</div>;
  }

  if (problemQuery.isError || !problem) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-text-dim">
        <p>Couldn't load that problem.</p>
        <Link to="/" className="text-accent underline">
          Back to Today
        </Link>
      </div>
    );
  }

  const revealed = problem.concepts_revealed !== null || !!gaveUpResult;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Reaching this problem via a workout/diagnostic item is otherwise a dead end once a
          verdict lands — nothing else on this route routes back to the ladder. */}
      {workoutItemId && (
        <div className="shrink-0 border-b border-border px-4 py-1.5">
          <Link to="/" className="text-xs text-text-faint underline hover:text-text-dim">
            ← Back to workout
          </Link>
        </div>
      )}
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
                    workoutItemId={workoutItemId}
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
                onRun={() => setCustomInputOpen(true)}
                onSubmit={() => triggerSubmit({ mode: "submit" })}
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
              <div className="max-h-[45%] min-h-[180px] overflow-y-auto border-t border-border">
                <ResultsPanel
                  mode={activeMode}
                  status={events.status}
                  progress={events.progress}
                  verdict={events.verdict}
                  connectionState={events.connectionState}
                />
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

      <CustomInputDialog
        open={customInputOpen}
        onClose={() => setCustomInputOpen(false)}
        initialArgs={problem.examples[0]?.args ?? []}
        pending={runPending}
        onRun={(args) => triggerSubmit({ mode: "run", customInput: args })}
      />
    </div>
  );
}
