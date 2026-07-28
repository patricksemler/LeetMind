import { useMemo, useRef, useState } from "react";
import type { HintResponse } from "@shared";
import { Badge, Button } from "../components/ui";
import { HintLadder } from "../components/workspace/HintLadder";
import { ProblemWorkspace, type WorkspaceTab } from "../components/workspace/ProblemWorkspace";
import type { LastResult } from "../components/workspace/ResultPanel";
import {
  createDemoExecutor,
  DEMO_PROBLEM,
  DEMO_RATING_UPDATE,
  DEMO_SOURCE,
  type DemoExecutor,
} from "./demoScenario";

type DemoStep = "problem" | "run" | "submit" | "complete";
type BusyAction = "run" | "submit" | null;

const DEFAULT_EXECUTOR = createDemoExecutor();

const STEP_COPY: Record<DemoStep, { eyebrow: string; title: string; detail: string }> = {
  problem: {
    eyebrow: "1 of 3 · Personalized practice",
    title: "Start with one problem at the edge of your ability.",
    detail: "Read the prompt and examples. A working solution is already loaded for this demo.",
  },
  run: {
    eyebrow: "2 of 3 · Public examples",
    title: "Run the code before you commit.",
    detail:
      "Run checks the visible examples only. The code is read-only here so you can focus on the flow.",
  },
  submit: {
    eyebrow: "3 of 3 · Hidden suite",
    title: "The examples pass. Now submit.",
    detail: "Submit checks the public examples and the hidden suite, just like a real attempt.",
  },
  complete: {
    eyebrow: "Demo complete",
    title: "Accepted — and the next problem adapts to the result.",
    detail:
      "Your concept rating moved from 1035 to 1048. LeetMind uses that evidence to choose what comes next.",
  },
};

function DemoGuide({
  step,
  onBegin,
  onReset,
}: {
  step: DemoStep;
  onBegin: () => void;
  onReset: () => void;
}) {
  const copy = STEP_COPY[step];

  return (
    <section aria-live="polite" className="shrink-0 border-b border-border bg-bg-raised px-4 py-3">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <Badge tone={step === "complete" ? "accepted" : "accent"}>Interactive demo</Badge>
            <span className="text-[11px] font-medium uppercase tracking-wide text-text-faint">
              {copy.eyebrow}
            </span>
          </div>
          <p className="text-sm font-medium text-text">{copy.title}</p>
          <p className="mt-0.5 text-xs text-text-dim">{copy.detail}</p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <div className="flex gap-1" aria-label={`Demo progress: ${copy.eyebrow}`}>
            {[1, 2, 3].map((n) => {
              const activeCount =
                step === "problem" ? 1 : step === "run" ? 2 : step === "submit" ? 3 : 3;
              return (
                <span
                  key={n}
                  className={`h-1.5 w-8 rounded-full ${
                    n <= activeCount ? "bg-accent" : "bg-border-strong"
                  }`}
                  aria-hidden="true"
                />
              );
            })}
          </div>
          {step === "problem" && (
            <Button variant="primary" size="sm" onClick={onBegin}>
              Start demo
            </Button>
          )}
          {step === "complete" && (
            <Button variant="secondary" size="sm" onClick={onReset}>
              Replay
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

export function DemoExperience({ executor = DEFAULT_EXECUTOR }: { executor?: DemoExecutor }) {
  const [step, setStep] = useState<DemoStep>("problem");
  const [busy, setBusy] = useState<BusyAction>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("problem");
  const [result, setResult] = useState<LastResult | null>(null);
  const [revealedHints, setRevealedHints] = useState<string[]>([]);
  const generationRef = useRef(0);

  const problem = useMemo(
    () => ({ ...DEMO_PROBLEM, revealed_hints: revealedHints }),
    [revealedHints],
  );

  function begin() {
    setStep("run");
  }

  async function run() {
    if (busy || step === "problem" || step === "complete") return;
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
      setStep("submit");
    } finally {
      if (generation === generationRef.current) setBusy(null);
    }
  }

  async function submit() {
    if (busy || step !== "submit") return;
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
      setActiveTab("results");
      setStep("complete");
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
  }

  function reset() {
    generationRef.current += 1;
    setStep("problem");
    setBusy(null);
    setActiveTab("problem");
    setResult(null);
    setRevealedHints([]);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg text-text">
      <DemoGuide step={step} onBegin={begin} onReset={reset} />
      <div className="min-h-0 flex-1">
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
                disabled={step === "complete"}
                onRevealed={(rung, text) => revealHint({ rung, text })}
                revealHint={executor.revealHint}
              />
            </section>
          }
          result={result}
          ratingUpdate={step === "complete" ? DEMO_RATING_UPDATE : null}
          onRun={() => void run()}
          onSubmit={() => void submit()}
          running={busy === "run"}
          submitting={busy === "submit"}
          runDisabled={step === "problem" || step === "complete"}
          submitDisabled={step !== "submit"}
          storageKeyPrefix="demo-workspace"
        />
      </div>
    </div>
  );
}

export function StaticDemoApp() {
  return (
    <div className="flex h-screen flex-col bg-bg text-text">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-bg px-4">
        <span className="font-display text-[15px] tracking-tight text-text">
          Leet<span className="text-accent">Mind</span>
        </span>
        <Badge tone="neutral">Static product tour</Badge>
      </header>
      <main className="min-h-0 flex-1">
        <DemoExperience />
      </main>
    </div>
  );
}
