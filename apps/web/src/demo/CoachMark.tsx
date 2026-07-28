import { useLayoutEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEnterOnce } from "../lib/useEnterOnce";

type Placement = "below-center" | "below-left" | "below-right";
type VerticalSide = "above" | "below";

const CARD_WIDTH = 288;
const VIEWPORT_GUTTER = 16;
const CONTROL_GAP = 14;
const ARROW_EDGE_GUTTER = 20;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

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
  const anchorRef = useRef<HTMLSpanElement>(null);
  const positionerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const marker = anchorRef.current;
    const anchorElement = marker?.parentElement;
    const positionerElement = positionerRef.current;
    if (!anchorElement || !positionerElement) return;
    const boundaryElement = anchorElement.closest<HTMLElement>("[data-coach-boundary]");

    const updatePosition = () => {
      // The card lives in a body portal so a pane's overflow cannot crop it. Mirror the visibility
      // and leaving state that it would have inherited had it remained beside the control.
      const hidden = anchorElement.closest('[hidden], [aria-hidden="true"]') !== null;
      positionerElement.classList.toggle(
        "coach-guide-leaving",
        anchorElement.closest(".coach-guide-leaving") !== null,
      );
      if (hidden) {
        positionerElement.setAttribute("aria-hidden", "true");
        positionerElement.style.visibility = "hidden";
        return;
      }

      const visualViewport = window.visualViewport;
      const viewportLeft = visualViewport?.offsetLeft ?? 0;
      const viewportTop = visualViewport?.offsetTop ?? 0;
      const viewportWidth = visualViewport?.width ?? window.innerWidth;
      const viewportHeight = visualViewport?.height ?? window.innerHeight;
      const viewportRight = viewportLeft + viewportWidth;
      const viewportBottom = viewportTop + viewportHeight;
      const measuredBoundary = boundaryElement?.getBoundingClientRect();
      const hasMeasuredBoundary =
        measuredBoundary && (measuredBoundary.width > 0 || measuredBoundary.height > 0);
      const boundaryLeft = hasMeasuredBoundary
        ? Math.max(viewportLeft, measuredBoundary.left)
        : viewportLeft;
      const boundaryRight = hasMeasuredBoundary
        ? Math.min(viewportRight, measuredBoundary.right)
        : viewportRight;
      const boundaryTop = hasMeasuredBoundary
        ? Math.max(viewportTop, measuredBoundary.top)
        : viewportTop;
      const boundaryBottom = hasMeasuredBoundary
        ? Math.min(viewportBottom, measuredBoundary.bottom)
        : viewportBottom;
      const availableWidth = Math.max(0, boundaryRight - boundaryLeft - VIEWPORT_GUTTER * 2);
      const width = Math.min(CARD_WIDTH, availableWidth);

      positionerElement.style.width = `${width}px`;
      positionerElement.style.maxHeight = "";
      positionerElement.style.overflowY = "";

      const anchorRect = anchorElement.getBoundingClientRect();
      const hasMeasuredAnchor = anchorRect.width > 0 || anchorRect.height > 0;
      if (
        hasMeasuredAnchor &&
        (anchorRect.right <= boundaryLeft ||
          anchorRect.left >= boundaryRight ||
          anchorRect.bottom <= boundaryTop ||
          anchorRect.top >= boundaryBottom)
      ) {
        // A portaled card must not float on its own after its pane moves the control offscreen.
        // It will be positioned again as soon as the control re-enters its pane.
        positionerElement.setAttribute("aria-hidden", "true");
        positionerElement.style.visibility = "hidden";
        return;
      }

      let preferredLeft: number;
      if (placement === "below-left") preferredLeft = anchorRect.left;
      else if (placement === "below-center") {
        preferredLeft = anchorRect.left + (anchorRect.width - width) / 2;
      } else preferredLeft = anchorRect.right - width;

      const minLeft = boundaryLeft + VIEWPORT_GUTTER;
      const maxLeft = Math.max(minLeft, boundaryRight - VIEWPORT_GUTTER - width);
      const left = clamp(preferredLeft, minLeft, maxLeft);

      const unboundedHeight = positionerElement.getBoundingClientRect().height;
      const availableHeight = Math.max(0, boundaryBottom - boundaryTop - VIEWPORT_GUTTER * 2);
      const height = Math.min(unboundedHeight, availableHeight);
      if (unboundedHeight > availableHeight) {
        positionerElement.style.maxHeight = `${availableHeight}px`;
        positionerElement.style.overflowY = "auto";
      }

      const minTop = boundaryTop + VIEWPORT_GUTTER;
      const maxTop = Math.max(minTop, boundaryBottom - VIEWPORT_GUTTER - height);
      const belowTop = anchorRect.bottom + CONTROL_GAP;
      const aboveTop = anchorRect.top - CONTROL_GAP - height;
      const spaceBelow = maxTop - belowTop;
      const spaceAbove = aboveTop - minTop;
      const side: VerticalSide =
        belowTop + height <= boundaryBottom - VIEWPORT_GUTTER || spaceBelow >= spaceAbove
          ? "below"
          : "above";
      const top = clamp(side === "below" ? belowTop : aboveTop, minTop, maxTop);

      positionerElement.dataset.side = side;
      positionerElement.style.left = `${left}px`;
      positionerElement.style.top = `${top}px`;
      positionerElement.style.setProperty(
        "--coach-arrow-left",
        `${clamp(
          anchorRect.left + anchorRect.width / 2 - left,
          ARROW_EDGE_GUTTER,
          Math.max(ARROW_EDGE_GUTTER, width - ARROW_EDGE_GUTTER),
        )}px`,
      );
      positionerElement.removeAttribute("aria-hidden");
      positionerElement.style.visibility = "visible";
    };

    updatePosition();

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    resizeObserver?.observe(anchorElement);
    resizeObserver?.observe(positionerElement);
    if (boundaryElement) resizeObserver?.observe(boundaryElement);

    const mutationObserver = new MutationObserver(updatePosition);
    let ancestor: HTMLElement | null = anchorElement;
    while (ancestor && ancestor !== document.body) {
      mutationObserver.observe(ancestor, {
        attributes: true,
        attributeFilter: ["aria-hidden", "class", "hidden"],
      });
      ancestor = ancestor.parentElement;
    }

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);

    return () => {
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
    };
  }, [placement]);

  return (
    <>
      <span ref={anchorRef} className="pointer-events-none absolute inset-0" aria-hidden="true" />
      {createPortal(
        <div
          ref={positionerRef}
          className="coach-mark-positioner pointer-events-none fixed z-40"
          data-side="below"
          style={{ visibility: "hidden" }}
        >
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
            <span className="coach-mark-arrow" aria-hidden="true" />
            <p className="text-[11px] font-medium uppercase tracking-wide text-accent">Next step</p>
            <p className="mt-1 text-sm font-medium text-text">{title}</p>
            <p className="mt-1.5 text-xs leading-relaxed text-text-dim">{children}</p>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
