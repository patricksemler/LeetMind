import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GiveUpResponse, Language, SubmissionMode } from "@algolift/shared";
import { api } from "../lib/api";
import { loadDraft, saveDraft } from "../lib/draft";
import { useActiveTime } from "../hooks/useActiveTime";
import { useConcepts } from "../hooks/useConcepts";
import { useHotkeys } from "../hooks/useHotkeys";
import { useSubmissionEvents } from "../hooks/useSubmissionEvents";
import { Badge, Panel, Tabs } from "../components/ui";
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

  // Reset per-problem UI state (draft comes back via the effect below) whenever the version changes.
  useEffect(() => {
    activeTime.reset();
    setActiveSubmissionId(null);
    setActiveMode(null);
    setGaveUpResult(null);
    setLeftTab("problem");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId]);

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
      setActiveSubmissionId(res.submission_id);
      setActiveMode(variables.mode);
    },
  });

  // Global fallback for the two workspace shortcuts (docs/CONTRACTS.md §12). Neither combo has a
  // default Monaco binding, so this is the single place that handles them, whether focus is in
  // the editor, the statement pane, or anywhere else on the page — see EditorPane's doc comment.
  useHotkeys(
    [
      { key: "Enter", meta: true, allowInInputs: true, handler: () => submitMutation.mutate({ mode: "submit" }) },
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
    <div className="h-full min-h-0">
      <SplitPane
        left={
          <div className="flex h-full min-h-0 flex-col">
            <Tabs
              tabs={[
                { id: "problem", label: "Problem" },
                { id: "hints", label: "Hints" },
              ]}
              active={leftTab}
              onChange={(id) => setLeftTab(id as "problem" | "hints")}
              className="sticky top-0 z-10 bg-bg px-2"
            />
            {leftTab === "problem" ? (
              <div>
                <div className="px-5 pt-4">
                  <ConceptTags revealed={revealed} concepts={problem.concepts_revealed} />
                </div>
                <StatementPane problem={problem} />
              </div>
            ) : (
              <div className="space-y-5 p-5">
                <HintLadder versionId={versionId} />
                <GiveUpControl
                  versionId={versionId}
                  activeMs={activeTime.activeMs}
                  workoutItemId={workoutItemId}
                  disabled={!!gaveUpResult}
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
              onSubmit={() => submitMutation.mutate({ mode: "submit" })}
              submitting={submitMutation.isPending}
              activeMs={activeTime.activeMs}
              timerHidden={timerHidden}
              onToggleTimer={() => setTimerHidden((h) => !h)}
            />
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

      <CustomInputDialog
        open={customInputOpen}
        onClose={() => setCustomInputOpen(false)}
        initialArgs={problem.examples[0]?.args ?? []}
        onRun={(args) => {
          setCustomInputOpen(false);
          submitMutation.mutate({ mode: "run", customInput: args });
        }}
      />
    </div>
  );
}
