import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
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
  onRun,
  onSubmit,
  running,
  submitting,
  disabled = false,
  runDisabled = disabled,
  submitDisabled = disabled,
  runCoachMark,
  submitCoachMark,
  coachExitMs = 0,
}: {
  onRun: () => void;
  onSubmit: () => void;
  running: boolean;
  submitting: boolean;
  /** Once a problem is resolved, the server 409s any run/submit (§8.3 requires `active`) — greyed
   * out rather than hidden, so the corner doesn't jump when a solve lands. */
  disabled?: boolean;
  /** Optional per-action gates for guided or staged flows. */
  runDisabled?: boolean;
  submitDisabled?: boolean;
  /** Optional contextual guidance rendered beside the real control. */
  runCoachMark?: ReactNode;
  submitCoachMark?: ReactNode;
  coachExitMs?: number;
}) {
  const busy = running || submitting;
  const [leavingCoach, setLeavingCoach] = useState<"run" | "submit" | null>(null);
  const coachTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (coachTimerRef.current !== null) window.clearTimeout(coachTimerRef.current);
    },
    [],
  );

  function triggerAction(kind: "run" | "submit", coachMark: ReactNode, action: () => void) {
    if (!coachMark || coachExitMs <= 0) {
      action();
      return;
    }
    if (leavingCoach) return;
    setLeavingCoach(kind);
    coachTimerRef.current = window.setTimeout(() => {
      setLeavingCoach(null);
      action();
    }, coachExitMs);
  }

  return (
    <div className="flex items-center justify-end gap-3 border-b border-border bg-bg px-4 py-2">
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
            <div
              className={`relative ${runCoachMark ? "z-30" : ""} ${
                leavingCoach === "run" ? "coach-guide-leaving" : ""
              }`}
            >
              <Button
                size="sm"
                variant="secondary"
                className={runCoachMark ? "ring-2 ring-accent ring-offset-4 ring-offset-bg" : ""}
                onClick={() => triggerAction("run", runCoachMark, onRun)}
                disabled={runDisabled || leavingCoach === "run"}
                title="Run against the public example tests (Cmd/Ctrl + ')"
              >
                Run
              </Button>
              {runCoachMark}
            </div>
            <div
              className={`relative ${submitCoachMark ? "z-30" : ""} ${
                leavingCoach === "submit" ? "coach-guide-leaving" : ""
              }`}
            >
              <Button
                size="sm"
                variant="primary"
                className={submitCoachMark ? "ring-2 ring-accent ring-offset-4 ring-offset-bg" : ""}
                onClick={() => triggerAction("submit", submitCoachMark, onSubmit)}
                disabled={submitDisabled || leavingCoach === "submit"}
                title="Submit against the public examples AND the hidden tests (Cmd/Ctrl + Enter)"
              >
                Submit
              </Button>
              {submitCoachMark}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
