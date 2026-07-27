import type React from "react";
import { useCallback, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { loadNumberPref, savePref } from "../../lib/prefs";

/** Arrow-key step, in percentage points of the container's size along the split axis. */
const KEY_STEP_PCT = 2;

export type SplitOrientation = "horizontal" | "vertical";

/**
 * A simple resizable split — no external dependency, just a thin draggable divider. `horizontal`
 * puts the panes side by side (divider is a vertical line, dragged left/right); `vertical` stacks
 * them (divider is a horizontal line, dragged up/down). `first` is the left or top pane
 * accordingly, and the percentage that's stored and dragged is always that pane's share.
 */
export function SplitPane({
  first,
  second,
  orientation = "horizontal",
  initialFirstPct = 42,
  minFirstPct = 25,
  maxFirstPct = 65,
  storageKey,
}: {
  first: ReactNode;
  second: ReactNode;
  orientation?: SplitOrientation;
  initialFirstPct?: number;
  minFirstPct?: number;
  maxFirstPct?: number;
  /** When set, the size the user drags to is remembered under this key across visits and reloads. */
  storageKey?: string;
}) {
  const vertical = orientation === "vertical";

  // Read straight out of storage during the initial state, not from an effect: restoring in an
  // effect renders the default size first and then snaps to the stored one, so every load of every
  // problem started with the panes visibly jumping.
  const [firstPct, setFirstPct] = useState(() =>
    storageKey
      ? loadNumberPref(storageKey, initialFirstPct, minFirstPct, maxFirstPct)
      : initialFirstPct,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  /** The same fact as `dragging`, in state — the divider has to STAY highlighted for the whole drag,
   * including the frames where the pointer has run ahead of the divider and is no longer over it.
   * `:hover` alone dropped the highlight the moment that happened, which read as the drag letting go
   * while it was still very much in progress. */
  const [isDragging, setIsDragging] = useState(false);
  /** Mirrors `firstPct` for the release handler, which can't see the state set during the drag. */
  const latestPct = useRef(firstPct);

  // Persisted from here rather than from an effect on `firstPct`: a drag fires this on every pointer
  // move, and a synchronous `localStorage` write per frame is the one thing in the gesture that
  // could actually make it stutter. The commit happens once, when the pointer is released.
  const clampAndSet = useCallback(
    (pct: number) => {
      const next = Math.min(maxFirstPct, Math.max(minFirstPct, pct));
      setFirstPct(next);
      latestPct.current = next;
      return next;
    },
    [maxFirstPct, minFirstPct],
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
      clampAndSet(
        vertical
          ? ((e.clientY - rect.top) / rect.height) * 100
          : ((e.clientX - rect.left) / rect.width) * 100,
      );
    },
    [clampAndSet, vertical],
  );

  const stopDragging = useCallback(() => {
    dragging.current = false;
    setIsDragging(false);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopDragging);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    persist(latestPct.current);
  }, [onPointerMove, persist]);

  // `userSelect: none` for the duration of the drag, plus `preventDefault` on the pointerdown that
  // starts it. A drag across the divider is a sweep over the statement and the editor, which the
  // browser reads as a text selection: the panes filled with highlight as the divider moved, and the
  // selection was still sitting there afterwards. The two are both needed — `preventDefault` stops
  // the selection this gesture would begin, `userSelect` stops one the pointer picks up as it
  // travels — and both are undone on release rather than left on the body.
  const startDragging = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = true;
      setIsDragging(true);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", stopDragging);
      document.body.style.cursor = vertical ? "row-resize" : "col-resize";
      document.body.style.userSelect = "none";
    },
    [onPointerMove, stopDragging, vertical],
  );

  // The divider is a real control, so it takes focus and moves under the arrow keys — a pointer
  // drag was the only way to resize, which left the split unreachable by keyboard entirely. Home
  // and End go to the two extremes; the ARIA value attributes below let a screen reader read the
  // current size out.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const deltas: Record<string, number> = vertical
        ? { ArrowUp: -KEY_STEP_PCT, ArrowDown: KEY_STEP_PCT }
        : { ArrowLeft: -KEY_STEP_PCT, ArrowRight: KEY_STEP_PCT };
      let next: number | null = null;
      // Stepped off the ref rather than off `firstPct`: a held arrow key can deliver several repeats
      // before React re-renders, and every one of those handlers would read the same stale size and
      // land on the same single step. The ref is current the moment the previous step is applied.
      if (e.key in deltas) next = latestPct.current + deltas[e.key]!;
      else if (e.key === "Home") next = minFirstPct;
      else if (e.key === "End") next = maxFirstPct;
      if (next === null) return;
      e.preventDefault();
      persist(clampAndSet(next));
    },
    [clampAndSet, maxFirstPct, minFirstPct, persist, vertical],
  );

  // The pane's own scrollbar, suppressed for the length of the drag. Resizing changes the content
  // height on every frame, which is exactly what makes a scrollbar flash into view — so dragging the
  // divider drew a scrollbar that had nothing to do with the gesture and left again when it ended.
  // Hiding the bar (rather than switching the pane to `overflow: hidden`) leaves the scroll position
  // and the scrollability itself untouched.
  const scrollbarDuringDrag = isDragging
    ? "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    : "";

  // Below `sm` (640px — narrower than the tablet layout, which already works fine and is left
  // untouched here), a percentage-based side-by-side split never fit: the panes' own content has
  // a real minimum width (the editor, the statement pane), so a ~40/60 split of a 375px viewport
  // clipped both sides instead of shrinking (confirmed live). Stack full-width instead; the
  // draggable divider only makes sense once there's a horizontal split to drag, so it's hidden
  // below `sm` too. A vertical split is already a stack, so none of that applies to it.
  return (
    <div
      ref={containerRef}
      className={`flex h-full min-h-0 w-full flex-col ${vertical ? "" : "sm:flex-row"}`}
      style={{ "--split-first": `${firstPct}%` } as CSSProperties}
    >
      <div
        className={
          vertical
            ? `h-[var(--split-first)] min-h-0 w-full overflow-y-auto ${scrollbarDuringDrag}`
            : // `border-b` only while stacked (below `sm`), where the divider is hidden and the two
              // panes would otherwise run together. Once the divider is on screen it IS the edge —
              // keeping a `border-r` here as well drew a 1px grey line immediately left of the 3px
              // divider, making this seam 4px and visibly fatter than the one under the editor.
              `h-1/2 min-h-0 w-full overflow-y-auto border-b border-border sm:h-full sm:w-[var(--split-first)] sm:border-b-0 ${scrollbarDuringDrag}`
        }
      >
        {first}
      </div>
      <div
        role="separator"
        aria-orientation={vertical ? "horizontal" : "vertical"}
        aria-label="Resize panels"
        aria-valuenow={Math.round(firstPct)}
        aria-valuemin={minFirstPct}
        aria-valuemax={maxFirstPct}
        tabIndex={0}
        onPointerDown={startDragging}
        onKeyDown={onKeyDown}
        // `z-10`: the grab area below overflows the divider on BOTH sides, but the pane that follows
        // it in the DOM painted over the half that reaches into it — so the divider could only be
        // caught from the side of the pane that comes first. Raising the divider puts its (entirely
        // transparent) grab area above both neighbours, which is what makes the leeway symmetric.
        className={`group relative z-10 shrink-0 select-none transition-colors focus-visible:bg-accent focus-visible:outline-none ${
          isDragging ? "bg-accent" : "bg-border hover:bg-accent"
        } ${vertical ? "h-[3px] w-full cursor-row-resize" : "hidden w-[3px] cursor-col-resize sm:block"}`}
      >
        {/* The grab area is wider than the line, so a 3px divider is still easy to catch. */}
        <div
          className={
            vertical
              ? "absolute inset-x-0 -top-1.5 -bottom-1.5"
              : "absolute inset-y-0 -left-1.5 -right-1.5"
          }
        />
      </div>
      <div
        className={
          vertical
            ? // The second pane of a vertical split is the one that gets squeezed, so it owns its
              // own scrolling — unlike a horizontal split, whose second pane is a column that
              // arranges its own scrollers.
              `flex min-h-0 w-full flex-1 flex-col overflow-y-auto ${scrollbarDuringDrag}`
            : `flex h-1/2 min-h-0 w-full min-w-0 flex-1 flex-col sm:h-full sm:w-[calc(100%-var(--split-first))] ${scrollbarDuringDrag}`
        }
      >
        {second}
      </div>
    </div>
  );
}
