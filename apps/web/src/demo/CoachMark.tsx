import type { CSSProperties, ReactNode } from "react";
import { useEnterOnce } from "../lib/useEnterOnce";

type Placement = "below-center" | "below-left" | "below-right";

const position: Record<Placement, string> = {
  "below-center": "left-1/2 top-[calc(100%+14px)] -translate-x-1/2",
  "below-left": "left-0 top-[calc(100%+14px)]",
  "below-right": "right-0 top-[calc(100%+14px)]",
};

const arrow: Record<Placement, string> = {
  "below-center": "left-1/2 -translate-x-1/2",
  "below-left": "left-5",
  "below-right": "right-5",
};

/**
 * A lightweight contextual prompt. It spotlights the real control rather than replacing the
 * product with tutorial chrome, and the non-intercepting backdrop leaves the rest of the UI free
 * to explore.
 */
export function CoachMark({
  title,
  children,
  placement = "below-right",
  enterDelayMs = 0,
}: {
  title: string;
  children: ReactNode;
  placement?: Placement;
  /** Hold the card back until an enclosing control has finished transitioning into view, so the
   * guidance lands with its target rather than ahead of it. */
  enterDelayMs?: number;
}) {
  const enter = useEnterOnce("coach-mark-enter");

  return (
    <div className={`pointer-events-none absolute z-40 w-72 ${position[placement]}`}>
      <div
        role="status"
        className={`coach-mark relative w-full rounded-lg border border-border-strong bg-bg-overlay p-4 text-left ${enter.className}`}
        style={
          enter.entered || !enterDelayMs
            ? undefined
            : ({ "--coach-mark-delay": `${enterDelayMs}ms` } as CSSProperties)
        }
        onAnimationEnd={enter.onAnimationEnd}
      >
        <span
          className={`absolute -top-[5px] h-2.5 w-2.5 rotate-45 border-l border-t border-border-strong bg-bg-overlay ${arrow[placement]}`}
          aria-hidden="true"
        />
        <p className="text-[11px] font-medium uppercase tracking-wide text-accent">Next step</p>
        <p className="mt-1 text-sm font-medium text-text">{title}</p>
        <p className="mt-1.5 text-xs leading-relaxed text-text-dim">{children}</p>
      </div>
    </div>
  );
}
