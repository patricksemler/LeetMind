import { type ReactNode, useCallback, useRef, useState } from "react";

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

  return (
    <div ref={containerRef} className="flex h-full min-h-0 w-full">
      <div style={{ width: `${leftPct}%` }} className="h-full min-h-0 overflow-y-auto border-r border-border">
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={startDragging}
        className="group relative w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-accent"
      >
        <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
      </div>
      <div style={{ width: `${100 - leftPct}%` }} className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {right}
      </div>
    </div>
  );
}
