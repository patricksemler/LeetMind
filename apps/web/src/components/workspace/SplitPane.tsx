import { type CSSProperties, type ReactNode, useCallback, useRef, useState } from "react";

/** A simple resizable horizontal split. No external dependency — a thin draggable divider. */
export function SplitPane({
  left,
  right,
  initialLeftPct = 42,
  minLeftPct = 25,
  maxLeftPct = 65,
}: {
  left: ReactNode;
  right: ReactNode;
  initialLeftPct?: number;
  minLeftPct?: number;
  maxLeftPct?: number;
}) {
  const [leftPct, setLeftPct] = useState(initialLeftPct);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftPct(Math.min(maxLeftPct, Math.max(minLeftPct, pct)));
    },
    [maxLeftPct, minLeftPct],
  );

  const stopDragging = useCallback(() => {
    dragging.current = false;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopDragging);
    document.body.style.cursor = "";
  }, [onPointerMove]);

  const startDragging = useCallback(() => {
    dragging.current = true;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDragging);
    document.body.style.cursor = "col-resize";
  }, [onPointerMove, stopDragging]);

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
        onPointerDown={startDragging}
        className="group relative hidden w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-accent sm:block"
      >
        <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
      </div>
      <div className="flex h-1/2 min-h-0 w-full min-w-0 flex-1 flex-col sm:h-full sm:w-[calc(100%-var(--split-left))]">
        {right}
      </div>
    </div>
  );
}
