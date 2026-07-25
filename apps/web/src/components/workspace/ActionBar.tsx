import type { Language } from "@leetmind/shared";
import { formatMs } from "../../lib/format";
import { Button } from "../ui";

export function ActionBar({
  language,
  onLanguageChange,
  onRun,
  onSubmit,
  submitting,
  activeMs,
  timerHidden,
  onToggleTimer,
}: {
  language: Language;
  onLanguageChange: (l: Language) => void;
  onRun: () => void;
  onSubmit: () => void;
  submitting: boolean;
  activeMs: number;
  timerHidden: boolean;
  onToggleTimer: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border bg-bg px-4 py-2">
      <div className="flex items-center gap-2">
        <select
          value={language}
          onChange={(e) => onLanguageChange(e.target.value as Language)}
          className="rounded border border-border-strong bg-bg-overlay px-2 py-1.5 text-xs text-text outline-none focus:border-accent"
          aria-label="Language"
        >
          <option value="python">Python</option>
          <option value="cpp">C++</option>
        </select>
        <Button size="sm" variant="secondary" onClick={onRun} title="Cmd/Ctrl + '">
          Run
        </Button>
        <Button size="sm" variant="primary" onClick={onSubmit} disabled={submitting} title="Cmd/Ctrl + Enter">
          {submitting ? "Submitting…" : "Submit"}
        </Button>
      </div>
      <button
        onClick={onToggleTimer}
        className="rounded px-2 py-1 font-mono text-xs text-text-faint transition-colors hover:bg-bg-overlay hover:text-text-dim"
        title={timerHidden ? "Show active time" : "Hide active time (measurement keeps running)"}
        data-testid="active-timer"
      >
        {timerHidden ? "⏱ hidden" : `⏱ ${formatMs(activeMs)}`}
      </button>
    </div>
  );
}
