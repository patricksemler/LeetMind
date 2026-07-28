import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { failedPublicCase } from "@shared";
import type {
  GiveUpResponse,
  Language,
  PersistedSubmissionMode,
  SubmissionMode,
  VerdictEvent,
} from "@shared";
import { api } from "../lib/api";
import { loadDraft, saveDraft } from "../lib/draft";
import { loadPref, savePref } from "../lib/prefs";
import { useActiveTime } from "../hooks/useActiveTime";
import { useHints } from "../hooks/useHints";
import { useHotkeys } from "../hooks/useHotkeys";
import { useSubmissionEvents } from "../hooks/useSubmissionEvents";
import { Panel, RouteLoading, Tabs, tabPanelProps } from "../components/ui";
import { buttonClassName } from "../components/ui/Button";
import { ActionBar } from "../components/workspace/ActionBar";
import { EditorPane } from "../components/workspace/EditorPane";
import { GiveUpControl } from "../components/workspace/GiveUpControl";
import { HintLadder } from "../components/workspace/HintLadder";
import { SolutionPane } from "../components/workspace/SolutionPane";
import { SubmissionsPanel } from "../components/workspace/SubmissionsPanel";
import { SplitPane } from "../components/workspace/SplitPane";
import { StatementPane } from "../components/workspace/StatementPane";
import { TestCasePanel } from "../components/workspace/TestCasePanel";

/** No "hints" tab: the ladder and the give-up/solution flow live under the statement in "problem",
 * where they're read against the thing they're hints about. */
type LeftTab = "problem" | "submissions";

const LANGUAGE_PREF = "workspace-language";

/** The language the user last worked in. A choice of language is about the person, not the problem,
 * so it's remembered app-wide rather than per version — picking C++ and then having the next
 * problem open in Python meant re-picking it on every single problem. */
function initialLanguage(): Language {
  return loadPref(LANGUAGE_PREF) === "cpp" ? "cpp" : "python";
}

export function Problem() {
  const { versionId } = useParams<{ versionId: string }>();
  const queryClient = useQueryClient();

  const problemQuery = useQuery({
    queryKey: ["problem", versionId],
    queryFn: () => api.getProblem(versionId!),
    enabled: !!versionId,
  });
  const problem = problemQuery.data?.problem;

  // Fired here, alongside the problem, rather than only from inside `HintLadder`: the ladder mounts
  // after the problem has landed, so a fetch started there is a round trip that begins once the page
  // is already on screen — the taken hints then dropped in visibly late on every visit. Same query
  // key as the ladder's own `useHints`, so this is one shared request, not a second one.
  const hintsQuery = useHints(versionId);

  /** Whether the editorial is on record for this version — what survives a reload. Set by giving
   * up, which is now the only way it is ever set. */
  const gaveUpEarlier = hintsQuery.data?.taken.includes("editorial") ?? false;

  const [leftTab, setLeftTab] = useState<LeftTab>("problem");
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(null);
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const [source, setSource] = useState("");
  const [activeSubmissionId, setActiveSubmissionId] = useState<string | null>(null);
  /** The submission id this session created, as opposed to one hydrated from the server on mount.
   * State, not a ref, because `judging` below is derived from it during render. */
  const [createdSubmissionId, setCreatedSubmissionId] = useState<string | null>(null);
  /** Persisted, not create-side: this is hydrated from the latest submission row on mount, which
   * on an old install can be a legacy `transcribe`. */
  const [activeMode, setActiveMode] = useState<PersistedSubmissionMode | null>(null);
  const [gaveUpResult, setGaveUpResult] = useState<GiveUpResponse | null>(null);

  // A give-up is recorded server-side, but `POST .../give-up` hands the editorial and solutions over
  // exactly once — so a reload came back with the give-up still in force (controls disabled,
  // concepts revealed) and no solution anywhere on screen. Read it back instead.
  //
  // Gated on the editorial rung being taken, which is what a give-up records: an accepted SOLVE also
  // earns the reveal server-side, and fetching on that would drop the solution under the statement
  // of a problem the user just solved themselves — that reveal belongs to the verdict panel.
  // `!gaveUpResult` because a give-up in THIS session already returned this exact payload.
  const revealQuery = useQuery({
    queryKey: ["reveal", versionId],
    queryFn: () => api.getReveal(versionId!),
    enabled: !!versionId && gaveUpEarlier && !gaveUpResult,
    staleTime: Infinity, // Immutable once earned — nothing about it can change while the page is open.
    // A 404 here means "not earned", which no amount of retrying will change; the default 3 retries
    // just fired the same rejected request four times over.
    retry: false,
  });

  // Measurement only — nothing displays it any more. `active_ms` still rides along on every
  // submission and on a give-up, where it's what the difficulty model reads, so the hook stays.
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
    setCreatedSubmissionId(null);
    setActiveMode(null);
    setGaveUpResult(null);
    setLeftTab("problem");
    setSelectedSubmissionId(null);
    setShownResults(undefined);
    shownVerdictRef.current = null;
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
    (async () => {
      try {
        const res = await api.latestSubmission(versionId);
        if (cancelled || hasLocalSubmissionRef.current || !res.submission) return;
        setActiveSubmissionId(res.submission.id);
        setActiveMode(res.submission.mode);
      } catch {
        // Best-effort — no latest submission to hydrate from is a normal state (never submitted
        // this problem yet), and a transient fetch failure just leaves the workspace empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [versionId]);

  // Load starter code / draft once the problem and language are known.
  useEffect(() => {
    if (!problem || !versionId) return;
    const draft = loadDraft(versionId, language);
    setSource(draft ?? problem.starter_code[language]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problem?.problem_version_id, language]);

  function handleLanguageChange(next: Language) {
    setLanguage(next);
    savePref(LANGUAGE_PREF, next);
  }

  function handleSourceChange(next: string) {
    setSource(next);
    if (versionId) saveDraft(versionId, language, next);
  }

  const events = useSubmissionEvents(activeSubmissionId, { enabled: !!activeSubmissionId });

  // The verdict, but only when it belongs to the submission currently on screen. `useSubmissionEvents`
  // clears its state from an EFFECT when the id changes, which commits one render after the id
  // itself — so for that one render `events.verdict` still holds the PREVIOUS submission's outcome.
  // Everything keyed on "there is a verdict" has to ignore it, or a fresh submit reads for a frame
  // as already judged: buttons back, tab yanked to Submissions, "Next problem" flashing up.
  const verdict = events.verdict?.submission_id === activeSubmissionId ? events.verdict : null;

  // A submit that died on a public example is treated as a run: no history row (the API drops it),
  // no mastery consequence (the judge skips it), and no trip to the Submissions tab — the failing
  // case is a case, and the case list below the editor is where cases live.
  const publicFailure = failedPublicCase(verdict?.failure);

  // The case list holds the LAST completed results until the next ones land, instead of emptying
  // the moment a run/submit starts. `verdict` goes null as soon as a new submission exists, and
  // rendering straight off it blanked the panel — the cases the user was reading vanished, then
  // came back a second later. Updated on any verdict, including one with no public results at all
  // (a compile error), so the panel is never stale in the other direction.
  const [shownResults, setShownResults] = useState<VerdictEvent["public_results"]>(undefined);
  useEffect(() => {
    if (!verdict) return;
    setShownResults(verdict.public_results);
  }, [verdict]);

  // The attempt history behind the Submissions tab. Refetched when a submit lands (below) rather
  // than polled: nothing else changes it, and a poll would fight the SSE stream for the same news.
  const submissionsQuery = useQuery({
    queryKey: ["submissions", versionId],
    queryFn: () => api.listSubmissions(versionId!),
    enabled: !!versionId,
  });

  // A plain ref, not `submitMutation.isPending` — React batches the re-render that would flip
  // `isPending`, so two synchronous triggers in the same tick (a rapid double-click, or a click
  // racing the Cmd+Enter hotkey) both read `isPending: false` and both fire. Two 201s, confirmed
  // live. A ref updates immediately, before either handler returns, so the second trigger in the
  // same tick sees the gate already closed.
  const submitInFlightRef = useRef(false);

  /** The submission id whose verdict has already been surfaced, so the auto-switch to Submissions
   * fires once per submission instead of yanking the tab back on every re-render. */
  const shownVerdictRef = useRef<string | null>(null);

  const submitMutation = useMutation({
    mutationFn: (input: { mode: SubmissionMode }) =>
      api.createSubmission({
        problem_version_id: versionId!,
        language,
        source,
        mode: input.mode,
        active_ms: activeTime.activeMs,
      }),
    onSuccess: (res, variables) => {
      hasLocalSubmissionRef.current = true;
      setActiveSubmissionId(res.submission_id);
      setCreatedSubmissionId(res.submission_id);
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
  /** What the primary button posts. There used to be a third mode — `transcribe`, teaching mode's
   * write-it-out step — and this was where the button switched to it. */
  const primaryMode: SubmissionMode = "submit";
  const submitPending = submitMutation.isPending && submitMutation.variables?.mode === primaryMode;
  const runPending = submitMutation.isPending && submitMutation.variables?.mode === "run";

  // "In flight" spans creating the submission AND judging it. `submitMutation.isPending` only covers
  // the POST, which returns in milliseconds — the wait the user actually sits through is the judge's,
  // and with no lifecycle text on screen any more the spinner is the only thing left to show it.
  //
  // Two sources, because neither covers the whole wait on its own:
  //
  //  - A submission WE created is in flight from the moment it exists, stream or no stream. This is
  //    what closes the gap that made the controls blink: once the POST resolves the mutation is no
  //    longer pending, but the SSE stream isn't open yet (it awaits an auth token before it even
  //    connects), so `events.status` is still null. Keyed on the stream alone, that window read as
  //    idle — Run and Submit came back for a beat and were then replaced by the spinner again.
  //  - A submission this session DIDN'T create (a reload mid-judging, hydrated from
  //    `latestSubmission`) has no `createdSubmissionId`, so the stream is the only thing that can
  //    say it's still running.
  //
  // `verdict` rather than `events.verdict` on purpose: the previous submission's verdict must not
  // end the new one's wait. `status` is only consulted for `cancelled`, which has no verdict to
  // arrive and would otherwise spin forever.
  const createdHere = !!createdSubmissionId && createdSubmissionId === activeSubmissionId;
  const streamRunning =
    events.status !== null && events.status !== "completed" && events.status !== "cancelled";
  const judging = !verdict && events.status !== "cancelled" && (createdHere || streamRunning);
  const submitBusy = submitPending || (activeMode === primaryMode && judging);
  const runBusy = runPending || (activeMode === "run" && judging);

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
      {
        key: "Enter",
        meta: true,
        allowInInputs: true,
        handler: () => triggerSubmit({ mode: primaryMode }),
      },
      { key: "'", meta: true, allowInInputs: true, handler: () => triggerSubmit({ mode: "run" }) },
    ],
    [versionId, language, source, primaryMode],
  );

  const solved = activeMode === "submit" && verdict?.verdict === "accepted";

  // The judged row is what the Submissions tab shows — an in-flight attempt isn't listed at all —
  // so the verdict is also the moment the list has something new in it. Unconditional, unlike the
  // tab switch below: the switch happens once per submission, but the list has to be refreshed for
  // every verdict, including one for a submission the user is already looking at.
  useEffect(() => {
    if (activeMode !== "submit" || !verdict) return;
    void queryClient.invalidateQueries({ queryKey: ["submissions", versionId] });
  }, [activeMode, verdict, versionId, queryClient]);

  // A landed submit takes the user to Submissions — success or failure, that screen is where the
  // outcome is, and the verdict is the first moment there is one to show. Keyed on the submission
  // id so it fires once per submission and never fights a manual tab change afterwards.
  //
  // Except when it died on a public example: that attempt never becomes a history row, so sending
  // the user to a tab that won't list it would strand them on someone else's result. It stays on
  // the workspace with the failing case marked in the list below the editor, exactly like a run.
  useEffect(() => {
    if (activeMode !== "submit" || !verdict || !activeSubmissionId || publicFailure) return;
    if (shownVerdictRef.current === activeSubmissionId) return;
    shownVerdictRef.current = activeSubmissionId;
    setSelectedSubmissionId(activeSubmissionId);
    setLeftTab("submissions");
  }, [activeMode, verdict, activeSubmissionId, publicFailure]);

  // Once a submit-mode submission is accepted, the problem becomes "solved" server-side —
  // refetch so `concepts_revealed` (and the taken hint ladder) reflect that. And `concepts`, which
  // carries the per-concept ratings this solve just moved.
  //
  // `["practice", "next"]` is deliberately NOT invalidated here any more. Invalidating it left the
  // finished problem sitting in the cache to be rendered again the instant `/` re-mounted (React
  // Query serves cached data first and refetches behind it), which is exactly the "Next problem
  // shows the same problem, then flips to generating" bug. Practice drops its own answer when it
  // unmounts instead — see the `gcTime` comment in Practice.tsx — which covers every route off
  // this page, not just the accepted-submit one this effect can see.
  useEffect(() => {
    if (!solved || !versionId) return;
    void queryClient.invalidateQueries({ queryKey: ["problem", versionId] });
    void queryClient.invalidateQueries({ queryKey: ["hints", versionId] });
    void queryClient.invalidateQueries({ queryKey: ["concepts"] });
  }, [solved, versionId, queryClient]);

  if (!versionId) return null;

  if (problemQuery.isLoading) {
    return <RouteLoading message="Loading problem…" />;
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
  // The solution to show under the statement: this session's give-up response, or — after a reload —
  // the same payload read back from the reveal endpoint.
  const solution = gaveUpResult ?? revealQuery.data ?? null;
  // A verdict (or a give-up) turns this page into a dead end otherwise: the workspace has nothing
  // left to do and nothing on it routes onward, so the onward link appears once the attempt is
  // over. `gaveUpEarlier` covers the reload — the attempt is just as over as it was before the
  // refresh.
  //
  // There used to be an exception: a give-up owed a transcription of the revealed solution, so the
  // attempt could be over while the user still had something to do and the onward link had to stay
  // hidden. Teaching mode is gone — a finished attempt is finished.
  const finished = solved || !!gaveUpResult || gaveUpEarlier;

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
                  { id: "submissions", label: "Submissions" },
                ]}
                active={leftTab}
                onChange={(id) => setLeftTab(id as LeftTab)}
                className="sticky top-0 z-10 bg-bg px-2"
                // The onward step rides in the tab row rather than in a strip of its own above the
                // workspace. Two reasons, and the second is why it moved: a standing strip cost a
                // full row on every problem, and a strip that appears only when the attempt ends
                // shoved the entire workspace — statement, editor, test panel — down 41px at the
                // exact moment the solution arrived. The row is already there and doesn't grow.
                trailing={
                  finished ? (
                    <Link to="/" className={buttonClassName({ variant: "primary", size: "sm" })}>
                      Next problem
                    </Link>
                  ) : null
                }
              />
              {leftTab === "problem" ? (
                <div {...tabPanelProps("problem-left", "problem")}>
                  {/* Hints and the solution sit UNDER the statement rather than behind their own
                      tab: they're read against the problem, and a tab put them somewhere you had to
                      remember to go — while taking the statement off screen once you got there. The
                      rule out of docs/CONTRACTS.md §8/§12 that matters is unchanged by the move:
                      the solution is still reachable only through the give-up flow, which still
                      records the give-up and floors the score server-side.

                      One padded, evenly-spaced column holding the statement's sections AND these —
                      hence `StatementPane` contributing no padding of its own. As two padded
                      siblings, the seam between them was a section gap plus both paddings, and
                      "Hints" read as further from the statement than any section was from the
                      next. */}
                  <div className="space-y-6 p-5">
                    <StatementPane problem={problem} />
                    {/* A named section rather than the bare rule that used to sit here: the rule
                        said "something else starts below" without saying what, so the ladder read
                        as an unlabeled appendix to the statement. The heading matches the
                        statement's own section headings, which is what makes the two read as one
                        continuous document. */}
                    <section className="space-y-3">
                      <h3 className="text-xs font-medium uppercase tracking-wide text-text-faint">
                        Hints
                      </h3>
                      <HintLadder versionId={versionId} disabled={revealed} />
                    </section>
                    {/* The rule between the hints and what follows them lives here rather than on
                        the give-up button, so it sits in the column's own even rhythm — the same
                        gap above it as below — and stays put when the button is replaced by the
                        solution it produced. Drawn only when something actually follows it. */}
                    {(!revealed || solution) && <div className="border-t border-border" />}
                    {!revealed && (
                      <GiveUpControl
                        versionId={versionId}
                        activeMs={activeTime.activeMs}
                        onGaveUp={(result) => {
                          setGaveUpResult(result);
                          void queryClient.invalidateQueries({ queryKey: ["problem", versionId] });
                          void queryClient.invalidateQueries({ queryKey: ["hints", versionId] });
                        }}
                      />
                    )}
                    {solution && (
                      <Panel className="space-y-3 p-4">
                        <h3 className="text-xs font-medium uppercase tracking-wide text-text-faint">
                          Solution
                        </h3>
                        <SolutionPane
                          editorialMd={solution.editorial_md}
                          solutions={solution.solutions}
                        />
                      </Panel>
                    )}
                  </div>
                </div>
              ) : (
                <div {...tabPanelProps("problem-left", "submissions")}>
                  <SubmissionsPanel
                    problem={problem}
                    submissions={submissionsQuery.data?.submissions ?? []}
                    selectedId={selectedSubmissionId}
                    onSelect={setSelectedSubmissionId}
                    loading={submissionsQuery.isLoading}
                  />
                </div>
              )}
            </div>
          }
          second={
            <div className="flex h-full min-h-0 flex-col">
              <ActionBar
                language={language}
                onLanguageChange={handleLanguageChange}
                onRun={() => triggerSubmit({ mode: "run" })}
                onSubmit={() => triggerSubmit({ mode: primaryMode })}
                running={runBusy}
                submitting={submitBusy}
              />
              {submitMutation.isError && (
                <div className="flex items-center justify-between gap-3 border-b border-verdict-error bg-verdict-error-dim px-4 py-1.5 text-xs text-text">
                  <span>
                    {submitMutation.error instanceof Error
                      ? submitMutation.error.message
                      : "Couldn't submit — try again."}
                  </span>
                  <button className="shrink-0 underline" onClick={() => submitMutation.reset()}>
                    Dismiss
                  </button>
                </div>
              )}
              {events.connectionState === "reconnecting" && (
                <div className="border-b border-verdict-warn bg-verdict-warn-dim px-4 py-1.5 text-xs text-text">
                  Lost the connection to the judge — reconnecting. Your submission is still running.
                </div>
              )}
              {/* Editor over cases, on the same kind of divider as the one between the columns —
                  how much room the cases get is as personal as how wide the statement is, and it was
                  the one edge in the workspace that couldn't be moved.
                  Just the cases — the cases ARE the result. No lifecycle narration (queued,
                  assigned to a worker, compiling, N/M passed): the Run/Submit button carries the
                  in-flight state, and everything a finished submit has to say lives in the
                  Submissions tab, which the user is taken to as soon as one lands. */}
              <div className="min-h-0 flex-1">
                <SplitPane
                  orientation="vertical"
                  storageKey="workspace-split-cases"
                  initialFirstPct={62}
                  minFirstPct={25}
                  maxFirstPct={85}
                  first={
                    <EditorPane language={language} value={source} onChange={handleSourceChange} />
                  }
                  second={<TestCasePanel problem={problem} results={shownResults} />}
                />
              </div>
            </div>
          }
        />
      </div>
    </div>
  );
}
