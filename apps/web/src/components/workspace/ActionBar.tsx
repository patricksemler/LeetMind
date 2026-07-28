import type { Language } from "@shared";
import { Button } from "../ui";

/**
 * The in-flight indicator for Run/Submit, and while it is up it is the ONLY thing in that corner:
 * the buttons are removed and this takes their place. With no lifecycle text anywhere in the
 * workspace, this is also the only signal that the judge is working — so it spins for as long as
 * the submission is being judged, not just for the POST that created it.
 *
 * The `role="status"` wrapper carries the label the vanished button used to: with nothing but a
 * glyph on screen, an aria-hidden spinner alone would leave a screen reader with no way to tell
 * that anything is happening at all.
 */
function Spinner({ label }: { label: string }) {
  return (
    <span
      role="status"
      className="flex items-center px-2 text-text-dim"
      data-testid="action-spinner"
    >
      <svg
        className="size-4 animate-spin"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <circle
          cx="8"
          cy="8"
          r="6.5"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="2.5"
        />
        <path
          d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function ActionBar({
  language,
  onLanguageChange,
  onRun,
  onSubmit,
  running,
  submitting,
}: {
  language: Language;
  onLanguageChange: (l: Language) => void;
  onRun: () => void;
  onSubmit: () => void;
  running: boolean;
  submitting: boolean;
}) {
  const busy = running || submitting;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border bg-bg px-4 py-2">
      <select
        value={language}
        onChange={(e) => onLanguageChange(e.target.value as Language)}
        className="rounded border border-border-strong bg-bg-overlay px-2 py-1.5 text-xs text-text outline-none focus:border-accent"
        aria-label="Language"
      >
        <option value="python">Python</option>
        <option value="cpp">C++</option>
      </select>

      {/* Run and Submit differ only in which tests they execute — Run the public examples, Submit
          those plus the hidden suite. The titles say so, because "Run" vs "Submit" on their own
          does not.

          In flight, both are REPLACED by the spinner rather than disabled-and-relabelled: two
          greyed-out buttons next to a third state is more to read than "something is running", and
          a disabled button under the cursor invites clicking at exactly the moment nothing can be
          clicked. The hotkeys stay guarded by `submitInFlightRef` in Problem.tsx, so there is no
          way in through the keyboard either. */}
      <div className="flex min-h-[30px] items-center gap-2">
        {busy ? (
          <Spinner label={submitting ? "Submitting…" : "Running…"} />
        ) : (
          <>
            <Button
              size="sm"
              variant="secondary"
              onClick={onRun}
              title="Run against the public example tests (Cmd/Ctrl + ')"
            >
              Run
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={onSubmit}
              title="Submit against the public examples AND the hidden tests (Cmd/Ctrl + Enter)"
            >
              Submit
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
