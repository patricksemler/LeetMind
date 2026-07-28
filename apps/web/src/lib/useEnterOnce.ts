import { useState } from "react";

/**
 * A CSS entrance animation that plays exactly once.
 *
 * The workspace's Problem panel is display-toggled rather than unmounted (`hidden`, so the pane
 * keeps its scroll position and its DOM), and returning an element to `display` restarts every
 * animation still attached to it. That replayed the entrance of everything inside the panel — coach
 * marks, revealed hint text — on every single tab switch. Dropping the class once it has run leaves
 * the element sitting exactly where the animation left it, and a later show is a no-op.
 *
 * Spread `className` alongside the element's own classes and wire `onAnimationEnd` to the same
 * element; `entered` is there for anything else that should stop applying once the entrance is done
 * (an `animation-delay` custom property, say).
 */
export function useEnterOnce(enterClassName: string): {
  entered: boolean;
  className: string;
  onAnimationEnd: () => void;
} {
  const [entered, setEntered] = useState(false);

  return {
    entered,
    className: entered ? "" : enterClassName,
    onAnimationEnd: () => setEntered(true),
  };
}
