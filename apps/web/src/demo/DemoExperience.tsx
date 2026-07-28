import { useEffect, useMemo, useRef, useState } from "react";
import type { HintResponse, RatingUpdateView } from "@shared";
import { Button, Dialog, Panel } from "../components/ui";
import { buttonClassName } from "../components/ui/Button";
import { HintLadder } from "../components/workspace/HintLadder";
import { ProblemWorkspace, type WorkspaceTab } from "../components/workspace/ProblemWorkspace";
import type { LastResult } from "../components/workspace/ResultPanel";
import { CoachMark } from "./CoachMark";
import { createDemoExecutor, DEMO_PROBLEM, DEMO_SOURCE, type DemoExecutor } from "./demoScenario";

type DemoScreen = "welcome" | "ready" | "workspace";
type WorkspaceStep = "hint" | "run" | "submit" | "complete";
type BusyAction = "run" | "submit" | null;

const DEFAULT_EXECUTOR = createDemoExecutor();
const REPOSITORY_URL = "https://github.com/patricksemler/LeetMind";

function Welcome({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Panel className="w-full max-w-2xl overflow-hidden">
        <div className="border-b border-border p-7 sm:p-9">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-text-faint">
            Guided preview
          </p>
          <h1
            aria-label="Welcome to LeetMind"
            className="mt-4 font-display text-3xl tracking-tight text-text sm:text-4xl"
          >
            Welcome to Leet<span className="text-accent">Mind</span>
          </h1>
          <p className="mt-3 max-w-xl text-base leading-relaxed text-text-dim">
            Progressive overload for problem solving. LeetMind chooses one verified algorithm
            problem at the edge of your ability, then uses the result to shape what comes next.
          </p>
        </div>
        <div className="flex justify-end p-7 sm:p-9">
          <Button variant="primary" className="shrink-0" onClick={onContinue}>
            Begin demo
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function ReadyProblem({ onOpen }: { onOpen: () => void }) {
  const [coachLeaving, setCoachLeaving] = useState(false);
  const openTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
    },
    [],
  );

  function openProblem() {
    if (coachLeaving) return;
    setCoachLeaving(true);
    openTimerRef.current = window.setTimeout(onOpen, 160);
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Panel className="w-full max-w-lg p-6">
        <h1 className="font-display text-xl text-text">A problem is ready for you</h1>
        <p className="mt-2 text-sm text-text-dim">
          Picked for the edge of your ability. Open it to see what it is.
        </p>
        <div className="mt-5">
          <div className={`relative z-30 inline-flex ${coachLeaving ? "coach-guide-leaving" : ""}`}>
            <Button
              variant="primary"
              className="ring-2 ring-accent ring-offset-4 ring-offset-bg-raised"
              onClick={openProblem}
            >
              Start
            </Button>
            <CoachMark title="Open your next challenge" placement="below-left">
              The practice loop always begins with one problem selected from your current mastery.
            </CoachMark>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function CompletionDialog({
  open,
  onClose,
  onReplay,
}: {
  open: boolean;
  onClose: () => void;
  onReplay: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="That’s the LeetMind loop"
      footer={
        <>
          <Button variant="secondary" onClick={onReplay}>
            Replay
          </Button>
          <a
            href={REPOSITORY_URL}
            target="_blank"
            rel="noreferrer"
            className={buttonClassName({ variant: "primary" })}
          >
            View repository <span aria-hidden="true">↗</span>
          </a>
        </>
      }
    >
      <div className="space-y-3 text-sm leading-relaxed text-text-dim">
        <p>
          You opened a challenge chosen for your current ability, used a progressive hint, checked
          the public examples, and passed the hidden suite.
        </p>
        <p>
          That result updated your Arrays &amp; Hashing rating. The production app uses the same
          loop—with generated problems, sandboxed execution, authentication, and persisted
          mastery—to choose your next challenge.
        </p>
        <p className="font-medium text-text">The demo has concluded. Thanks for taking a look.</p>
      </div>
    </Dialog>
  );
}

export function DemoExperience({
  executor = DEFAULT_EXECUTOR,
  conclusionDelayMs = 850,
}: {
  executor?: DemoExecutor;
  conclusionDelayMs?: number;
}) {
  const [screen, setScreen] = useState<DemoScreen>("welcome");
  const [workspaceStep, setWorkspaceStep] = useState<WorkspaceStep>("hint");
  const [busy, setBusy] = useState<BusyAction>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("problem");
  const [result, setResult] = useState<LastResult | null>(null);
  const [ratingUpdate, setRatingUpdate] = useState<RatingUpdateView | null>(null);
  const [revealedHints, setRevealedHints] = useState<string[]>([]);
  const [conclusionOpen, setConclusionOpen] = useState(false);
  const generationRef = useRef(0);
  const conclusionTimerRef = useRef<number | null>(null);

  const problem = useMemo(
    () => ({ ...DEMO_PROBLEM, revealed_hints: revealedHints }),
    [revealedHints],
  );

  useEffect(
    () => () => {
      if (conclusionTimerRef.current !== null) window.clearTimeout(conclusionTimerRef.current);
    },
    [],
  );

  async function run() {
    if (busy || workspaceStep === "hint" || workspaceStep === "complete") return;
    const generation = generationRef.current;
    setBusy("run");
    try {
      const response = await executor.run();
      if (generation !== generationRef.current) return;
      setResult({
        kind: "run",
        passed: response.passed,
        solved: false,
        results: response.results,
        code: DEMO_SOURCE,
      });
      setWorkspaceStep("submit");
    } finally {
      if (generation === generationRef.current) setBusy(null);
    }
  }

  async function submit() {
    if (busy || workspaceStep !== "submit") return;
    const generation = generationRef.current;
    setBusy("submit");
    try {
      const response = await executor.submit();
      if (generation !== generationRef.current) return;
      setResult({
        kind: response.kind,
        passed: response.passed,
        solved: response.solved,
        results: response.results,
        failingCase: response.failing_case,
        code: DEMO_SOURCE,
      });
      setRatingUpdate(response.rating_update ?? null);
      setActiveTab("results");
      setWorkspaceStep("complete");
      conclusionTimerRef.current = window.setTimeout(
        () => setConclusionOpen(true),
        conclusionDelayMs,
      );
    } finally {
      if (generation === generationRef.current) setBusy(null);
    }
  }

  function revealHint(response: HintResponse) {
    setRevealedHints((current) => {
      const next = [...current];
      next[response.rung - 1] = response.text;
      return next;
    });
    if (workspaceStep === "hint") setWorkspaceStep("run");
  }

  function reset() {
    generationRef.current += 1;
    if (conclusionTimerRef.current !== null) window.clearTimeout(conclusionTimerRef.current);
    conclusionTimerRef.current = null;
    setScreen("welcome");
    setWorkspaceStep("hint");
    setBusy(null);
    setActiveTab("problem");
    setResult(null);
    setRatingUpdate(null);
    setRevealedHints([]);
    setConclusionOpen(false);
  }

  if (screen === "welcome") {
    return (
      <div className="h-full bg-bg text-text">
        <Welcome onContinue={() => setScreen("ready")} />
      </div>
    );
  }

  if (screen === "ready") {
    return (
      <div className="h-full bg-bg text-text">
        <ReadyProblem onOpen={() => setScreen("workspace")} />
      </div>
    );
  }

  return (
    <div className="h-full bg-bg text-text">
      <ProblemWorkspace
        problem={problem}
        source={DEMO_SOURCE}
        onSourceChange={() => {}}
        editorReadOnly
        activeTab={activeTab}
        onTabChange={setActiveTab}
        problemTools={
          <section className="space-y-3">
            <h3 className="text-xs font-medium uppercase tracking-wide text-text-faint">Hints</h3>
            <HintLadder
              problemId={problem.id}
              revealedHints={revealedHints}
              disabled={workspaceStep === "complete"}
              onRevealed={(rung, text) => revealHint({ rung, text })}
              revealHint={executor.revealHint}
              coachExitMs={160}
              revealCoachMark={
                workspaceStep === "hint" ? (
                  <CoachMark title="Explore, then reveal a hint">
                    Look around the prompt and test cases. When you’re ready, reveal the first
                    progressive hint to continue.
                  </CoachMark>
                ) : null
              }
            />
          </section>
        }
        result={result}
        ratingUpdate={ratingUpdate}
        onRun={() => void run()}
        onSubmit={() => void submit()}
        running={busy === "run"}
        submitting={busy === "submit"}
        runDisabled={workspaceStep === "hint" || workspaceStep === "complete"}
        submitDisabled={workspaceStep !== "submit"}
        runCoachMark={
          workspaceStep === "run" ? (
            <CoachMark title="Check the public examples">
              The solution is preloaded and read-only for this demo. Run it to see each visible test
              case execute.
            </CoachMark>
          ) : null
        }
        submitCoachMark={
          workspaceStep === "submit" ? (
            <CoachMark title="Submit against the hidden suite">
              Both examples pass. Submit runs the remaining tests and concludes the demo.
            </CoachMark>
          ) : null
        }
        coachExitMs={160}
        storageKeyPrefix="demo-workspace"
      />
      <CompletionDialog
        open={conclusionOpen}
        onClose={() => setConclusionOpen(false)}
        onReplay={reset}
      />
    </div>
  );
}

export function StaticDemoApp() {
  return (
    <div className="flex h-screen flex-col bg-bg text-text">
      <header className="flex h-12 shrink-0 items-center border-b border-border bg-bg px-4">
        <span className="font-display text-[15px] tracking-tight text-text">
          Leet<span className="text-accent">Mind</span>
        </span>
      </header>
      <main className="min-h-0 flex-1">
        <DemoExperience />
      </main>
    </div>
  );
}
