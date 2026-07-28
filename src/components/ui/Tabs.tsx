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
  /** Optional control parked at the right end of the tab row. Anything shorter than a tab button
   * (a `size="sm"` button, say) rides along without changing the row's height — which is the point:
   * a control that comes and goes here costs no layout, where its own row would move the whole
   * workspace down the moment it appeared. Outside the `tablist`'s children, so it is not announced
   * as a tab. */
  trailing?: ReactNode;
}

function tabButtonId(tabsId: string, tabId: string): string {
  return `${tabsId}-tab-${tabId}`;
}

function tabPanelId(tabsId: string, tabId: string): string {
  return `${tabsId}-panel-${tabId}`;
}

/** Props to spread onto the panel element a given tab controls — keeps the id/aria-controls/
 * aria-labelledby triad in one place instead of every consumer hand-rolling matching strings. */
export function tabPanelProps(
  tabsId: string,
  tabId: string,
): { id: string; role: "tabpanel"; "aria-labelledby": string } {
  return {
    id: tabPanelId(tabsId, tabId),
    role: "tabpanel",
    "aria-labelledby": tabButtonId(tabsId, tabId),
  };
}

export function Tabs({ id, tabs, active, onChange, className = "", trailing }: TabsProps) {
  return (
    <div className={`flex items-center border-b border-border ${className}`}>
      <div role="tablist" className="flex items-center gap-1">
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
      {trailing && <div className="ml-auto pl-2">{trailing}</div>}
    </div>
  );
}
