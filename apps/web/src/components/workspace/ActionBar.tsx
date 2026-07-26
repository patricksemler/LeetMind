import type { Language } from "@leetmind/shared";
import { formatMs } from "../../lib/format";
import { Button } from "../ui";

export function ActionBar({
  language,
  onLanguageChange,
  onRun,
  onSubmit,
  running,
  submitting,
  activeMs,
  timerHidden,
  onToggleTimer,
}: {
  language: Language;
  onLanguageChange: (l: Language) => void;
  onRun: () => void;
  onSubmit: () => void;
  running: boolean;
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
        {/* Run and Submit differ only in which tests they execute — Run the public examples,
            Submit those plus the hidden suite. The titles say so, because "Run" vs "Submit" on
            their own does not. */}
        <Button
          size="sm"
          variant="secondary"
          onClick={onRun}
          disabled={running || submitting}
          title="Run against the public example tests (Cmd/Ctrl + ')"
        >
          {running ? "Running…" : "Run"}
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={onSubmit}
          disabled={running || submitting}
          title="Submit against the public examples AND the hidden tests (Cmd/Ctrl + Enter)"
        >
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
