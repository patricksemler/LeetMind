import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, Spinner } from "../ui";

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
    <div className="flex h-12 shrink-0 items-center justify-end gap-3 border-b border-border bg-bg px-4">
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
          <Spinner
            label={submitting ? "Submitting…" : "Running…"}
            className="px-2 text-text-dim"
            data-testid="action-spinner"
          />
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
