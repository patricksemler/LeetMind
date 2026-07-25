import type { ReactNode } from "react";

export interface TabDef {
  id: string;
  label: string;
  badge?: ReactNode;
}

interface TabsProps {
  /** Base id for this tablist — combined with each tab's own id to produce the
   * tab-button/tabpanel id pair (see `tabPanelProps`). Must be unique on the page. */
  id: string;
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}

function tabButtonId(tabsId: string, tabId: string): string {
  return `${tabsId}-tab-${tabId}`;
}

function tabPanelId(tabsId: string, tabId: string): string {
  return `${tabsId}-panel-${tabId}`;
}

/** Props to spread onto the panel element a given tab controls — keeps the id/aria-controls/
 * aria-labelledby triad in one place instead of every consumer hand-rolling matching strings. */
export function tabPanelProps(tabsId: string, tabId: string): { id: string; role: "tabpanel"; "aria-labelledby": string } {
  return { id: tabPanelId(tabsId, tabId), role: "tabpanel", "aria-labelledby": tabButtonId(tabsId, tabId) };
}

export function Tabs({ id, tabs, active, onChange, className = "" }: TabsProps) {
  return (
    <div role="tablist" className={`flex items-center gap-1 border-b border-border ${className}`}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            id={tabButtonId(id, tab.id)}
            role="tab"
            aria-selected={selected}
            aria-controls={tabPanelId(id, tab.id)}
            onClick={() => onChange(tab.id)}
            className={`relative px-3 py-2 text-sm transition-colors ${
              selected ? "text-text" : "text-text-faint hover:text-text-dim"
            }`}
          >
            {tab.label}
            {tab.badge}
            {selected && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-accent" />}
          </button>
        );
      })}
    </div>
  );
}
