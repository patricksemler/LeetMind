import { useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { ProblemDetail, RatingUpdateView } from "@shared";
import { Tabs, tabPanelProps } from "../ui";
import { ActionBar } from "./ActionBar";
import { EditorPane } from "./EditorPane";
import { RatingUpdatePanel } from "./RatingUpdatePanel";
import { ResultPanel, type LastResult } from "./ResultPanel";
import { SplitPane } from "./SplitPane";
import { StatementPane } from "./StatementPane";
import { TestCasePanel } from "./TestCasePanel";

export type WorkspaceTab = "problem" | "results";

/**
 * The problem workspace's shared visual shell.
 *
 * Live routes own networking and attempt state; static demos own deterministic local responses.
 * Keeping both behind this component means layout changes, accessibility fixes, and component
 * upgrades automatically land in both experiences without teaching the demo about the API.
 */
export function ProblemWorkspace({
  problem,
  source,
  onSourceChange,
  editorReadOnly = false,
  activeTab,
  onTabChange,
  problemTools,
  tabsTrailing,
  result,
  ratingUpdate,
  onRun,
  onSubmit,
  running,
  submitting,
  runDisabled = false,
  submitDisabled = false,
  runCoachMark,
  submitCoachMark,
  coachExitMs,
  actionErrorMessage,
  onDismissActionError,
  storageKeyPrefix = "workspace",
}: {
  problem: ProblemDetail;
  source: string;
  onSourceChange: (source: string) => void;
  editorReadOnly?: boolean;
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  problemTools?: ReactNode;
  tabsTrailing?: ReactNode;
  result: LastResult | null;
  ratingUpdate?: RatingUpdateView | null;
  onRun: () => void;
  onSubmit: () => void;
  running: boolean;
  submitting: boolean;
  runDisabled?: boolean;
  submitDisabled?: boolean;
  runCoachMark?: ReactNode;
  submitCoachMark?: ReactNode;
  coachExitMs?: number;
  actionErrorMessage?: string | null;
  onDismissActionError?: () => void;
  storageKeyPrefix?: string;
}) {
  const tabsId = `${storageKeyPrefix}-left`;

  // Problem and Result share one scroller, so switching tabs swapped the content under a single
  // scroll position: Result is far shorter than a statement, the browser clamped the offset to fit
  // it, and coming back landed at the top of a statement the reader was halfway down. Each tab's
  // offset is stashed on the way out and put back on the way in, before paint.
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTopByTab = useRef<Partial<Record<WorkspaceTab, number>>>({});

  function changeTab(next: WorkspaceTab) {
    if (next === activeTab) return;
    if (scrollRef.current) scrollTopByTab.current[activeTab] = scrollRef.current.scrollTop;
    onTabChange(next);
  }

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollTopByTab.current[activeTab] ?? 0;
  }, [activeTab]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <SplitPane
          storageKey={`${storageKeyPrefix}-split`}
          first={
            <div className="flex h-full min-h-0 flex-col">
              <Tabs
                id={tabsId}
                tabs={[
                  { id: "problem", label: "Problem" },
                  { id: "results", label: "Result" },
                ]}
                active={activeTab}
                onChange={(id) => changeTab(id as WorkspaceTab)}
                className="shrink-0 bg-bg px-2"
                trailing={tabsTrailing}
              />
              {/* The scroller lives here rather than on the SplitPane wrapper, so there is one
                  element to read and restore an offset on — and the tab row sits outside it
                  instead of being stuck to the top of it. */}
              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
                <div hidden={activeTab !== "problem"} {...tabPanelProps(tabsId, "problem")}>
                  <div className="space-y-6 p-4 sm:p-5">
                    <StatementPane problem={problem} />
                    {problemTools}
                  </div>
                </div>
                {activeTab === "results" && (
                  <div {...tabPanelProps(tabsId, "results")}>
                    <ResultPanel problem={problem} result={result} />
                    {ratingUpdate && (
                      <div className="px-4 pb-4 sm:px-5 sm:pb-5">
                        <RatingUpdatePanel update={ratingUpdate} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          }
          second={
            <div className="flex h-full min-h-0 flex-col">
              <ActionBar
                onRun={onRun}
                onSubmit={onSubmit}
                running={running}
                submitting={submitting}
                runDisabled={runDisabled}
                submitDisabled={submitDisabled}
                runCoachMark={runCoachMark}
                submitCoachMark={submitCoachMark}
                coachExitMs={coachExitMs}
              />
              {actionErrorMessage && (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-3 border-b border-verdict-error bg-verdict-error-dim px-4 py-1.5 text-xs text-text"
                >
                  <span>{actionErrorMessage}</span>
                  {onDismissActionError && (
                    <button className="shrink-0 underline" onClick={onDismissActionError}>
                      Dismiss
                    </button>
                  )}
                </div>
              )}
              <div className="min-h-0 flex-1">
                <SplitPane
                  orientation="vertical"
                  storageKey={`${storageKeyPrefix}-split-cases`}
                  initialFirstPct={62}
                  minFirstPct={25}
                  maxFirstPct={85}
                  first={
                    <EditorPane
                      value={source}
                      onChange={onSourceChange}
                      readOnly={editorReadOnly}
                    />
                  }
                  second={<TestCasePanel problem={problem} results={result?.results} />}
                />
              </div>
            </div>
          }
        />
      </div>
    </div>
  );
}
