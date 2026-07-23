import type { ReactNode } from "react";

export interface TabDef {
  id: string;
  label: string;
  badge?: ReactNode;
}

interface TabsProps {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}

export function Tabs({ tabs, active, onChange, className = "" }: TabsProps) {
  return (
    <div role="tablist" className={`flex items-center gap-1 border-b border-border ${className}`}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={selected}
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
