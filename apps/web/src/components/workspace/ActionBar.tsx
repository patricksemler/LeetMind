import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, LoadingSwap, Toolbar } from "../ui";

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
    setLeavingCoach(kind);
    action();
    coachTimerRef.current = window.setTimeout(() => {
      setLeavingCoach(null);
    }, coachExitMs);
  }

  return (
    <Toolbar className="justify-end px-4">
      {/* No `title` on either button. The browser's own tooltip is the only thing that renders it,
          it arrives a second late and unstyled, and here it opened directly over the test cases and
          the coach mark below — a lot of chrome for a sentence nobody asked to read.

          In flight, both are REPLACED by the spinner rather than disabled-and-relabelled: two
          greyed-out buttons next to a third state is more to read than "something is running", and
          a disabled button under the cursor invites clicking at exactly the moment nothing can be
          clicked. The hotkeys stay guarded by `submitInFlightRef` in Problem.tsx, so there is no
          way in through the keyboard either. */}
      <LoadingSwap
        loading={busy}
        label={submitting ? "Submitting…" : "Running…"}
        className="min-h-[30px]"
        spinnerClassName="justify-self-end text-text-dim"
        spinnerTestId="action-spinner"
      >
        <div className="flex items-center gap-2">
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
              disabled={busy || runDisabled}
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
              disabled={busy || submitDisabled}
            >
              Submit
            </Button>
            {submitCoachMark}
          </div>
        </div>
      </LoadingSwap>
    </Toolbar>
  );
}
