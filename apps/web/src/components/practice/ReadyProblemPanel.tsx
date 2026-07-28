import type { ReactNode } from "react";
import { Panel } from "../ui";

export function ReadyProblemPanel({ action }: { action: ReactNode }) {
  return (
    <Panel className="w-full max-w-lg p-6">
      <h1 className="font-display text-xl text-text">A problem is ready for you</h1>
      <p className="mt-2 text-pretty text-sm text-text-dim">
        Picked for the edge of your ability. Open it to see what it is.
      </p>
      <div className="mt-5">{action}</div>
    </Panel>
  );
}
