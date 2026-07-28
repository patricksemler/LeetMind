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
  actionErrorMessage?: string | null;
  onDismissActionError?: () => void;
  storageKeyPrefix?: string;
}) {
  const tabsId = `${storageKeyPrefix}-left`;

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
                onChange={(id) => onTabChange(id as WorkspaceTab)}
                className="sticky top-0 z-10 bg-bg px-2"
                trailing={tabsTrailing}
              />
              {activeTab === "problem" ? (
                <div {...tabPanelProps(tabsId, "problem")}>
                  <div className="space-y-6 p-5">
                    <StatementPane problem={problem} />
                    {problemTools}
                  </div>
                </div>
              ) : (
                <div {...tabPanelProps(tabsId, "results")}>
                  <ResultPanel problem={problem} result={result} />
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
                onRun={onRun}
                onSubmit={onSubmit}
                running={running}
                submitting={submitting}
                runDisabled={runDisabled}
                submitDisabled={submitDisabled}
              />
              {actionErrorMessage && (
                <div className="flex items-center justify-between gap-3 border-b border-verdict-error bg-verdict-error-dim px-4 py-1.5 text-xs text-text">
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
