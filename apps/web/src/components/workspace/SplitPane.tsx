import type React from "react";
import { type CSSProperties, type ReactNode, useCallback, useRef, useState } from "react";
import { loadNumberPref, savePref } from "../../lib/prefs";

/** Arrow-key step, in percentage points of the container's width. */
const KEY_STEP_PCT = 2;

/** A simple resizable horizontal split. No external dependency — a thin draggable divider. */
export function SplitPane({
  left,
  right,
  initialLeftPct = 42,
  minLeftPct = 25,
  maxLeftPct = 65,
  storageKey,
}: {
  left: ReactNode;
  right: ReactNode;
  initialLeftPct?: number;
  minLeftPct?: number;
  maxLeftPct?: number;
  /** When set, the width the user drags to is remembered under this key across visits and reloads. */
  storageKey?: string;
}) {
  // Read straight out of storage during the initial state, not from an effect: restoring in an
  // effect renders the default width first and then snaps to the stored one, so every load of every
  // problem started with the panes visibly jumping.
  const [leftPct, setLeftPct] = useState(() =>
    storageKey ? loadNumberPref(storageKey, initialLeftPct, minLeftPct, maxLeftPct) : initialLeftPct,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  /** Mirrors `leftPct` for the release handler, which can't see the state set during the drag. */
  const latestPct = useRef(leftPct);

  // Persisted from here rather than from an effect on `leftPct`: a drag fires this on every pointer
  // move, and a synchronous `localStorage` write per frame is the one thing in the gesture that
  // could actually make it stutter. The commit happens once, when the pointer is released.
  const clampAndSet = useCallback(
    (pct: number) => {
      const next = Math.min(maxLeftPct, Math.max(minLeftPct, pct));
      setLeftPct(next);
      latestPct.current = next;
      return next;
    },
    [maxLeftPct, minLeftPct],
  );

  const persist = useCallback(
    (pct: number) => {
      if (storageKey) savePref(storageKey, String(Math.round(pct * 100) / 100));
    },
    [storageKey],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      clampAndSet(((e.clientX - rect.left) / rect.width) * 100);
    },
    [clampAndSet],
  );

  const stopDragging = useCallback(() => {
    dragging.current = false;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopDragging);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    persist(latestPct.current);
  }, [onPointerMove, persist]);

  // `userSelect: none` for the duration of the drag, plus `preventDefault` on the pointerdown that
  // starts it. A drag across the divider is a horizontal sweep over the statement and the editor,
  // which the browser reads as a text selection: the panes filled with highlight as the divider
  // moved, and the selection was still sitting there afterwards. The two are both needed —
  // `preventDefault` stops the selection this gesture would begin, `userSelect` stops one the
  // pointer picks up as it travels — and both are undone on release rather than left on the body.
  const startDragging = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = true;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", stopDragging);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [onPointerMove, stopDragging],
  );

  // The divider is a real control, so it takes focus and moves under the arrow keys — a pointer
  // drag was the only way to resize, which left the split unreachable by keyboard entirely. Home
  // and End go to the two extremes; the ARIA value attributes below let a screen reader read the
  // current width out.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const deltas: Record<string, number> = { ArrowLeft: -KEY_STEP_PCT, ArrowRight: KEY_STEP_PCT };
      let next: number | null = null;
      // Stepped off the ref rather than off `leftPct`: a held arrow key can deliver several repeats
      // before React re-renders, and every one of those handlers would read the same stale width and
      // land on the same single step. The ref is current the moment the previous step is applied.
      if (e.key in deltas) next = latestPct.current + deltas[e.key]!;
      else if (e.key === "Home") next = minLeftPct;
      else if (e.key === "End") next = maxLeftPct;
      if (next === null) return;
      e.preventDefault();
      persist(clampAndSet(next));
    },
    [clampAndSet, maxLeftPct, minLeftPct, persist],
  );

  // Below `sm` (640px — narrower than the tablet layout, which already works fine and is left
  // untouched here), a percentage-based side-by-side split never fit: the panes' own content has
  // a real minimum width (the editor, the statement pane), so a ~40/60 split of a 375px viewport
  // clipped both sides instead of shrinking (confirmed live). Stack full-width instead; the
  // draggable divider only makes sense once there's a horizontal split to drag, so it's hidden
  // below `sm` too.
  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 w-full flex-col sm:flex-row"
      style={{ "--split-left": `${leftPct}%` } as CSSProperties}
    >
      <div className="h-1/2 min-h-0 w-full overflow-y-auto border-b border-border sm:h-full sm:w-[var(--split-left)] sm:border-b-0 sm:border-r">
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panels"
        aria-valuenow={Math.round(leftPct)}
        aria-valuemin={minLeftPct}
        aria-valuemax={maxLeftPct}
        tabIndex={0}
        onPointerDown={startDragging}
        onKeyDown={onKeyDown}
        className="group relative hidden w-1 shrink-0 cursor-col-resize select-none bg-border transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none sm:block"
      >
        <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
      </div>
      <div className="flex h-1/2 min-h-0 w-full min-w-0 flex-1 flex-col sm:h-full sm:w-[calc(100%-var(--split-left))]">
        {right}
      </div>
    </div>
  );
}
