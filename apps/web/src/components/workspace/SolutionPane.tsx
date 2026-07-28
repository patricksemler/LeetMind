/**
 * The post-reveal solution: the reference implementation, in Python (v1 is Python-only —
 * PLAN_BACKEND.md decision 14). Reached only once a reveal has been earned (accepted submit, or
 * give-up) — this component never fetches anything, it renders what the response already handed
 * over.
 */
import { CodeBlock } from "./CodeBlock";

export function SolutionPane({
  referenceSolution,
  className = "",
}: {
  referenceSolution: string;
  className?: string;
}) {
  return (
    <div className={`space-y-2 ${className}`} data-testid="solution-pane">
      <CodeBlock code={referenceSolution} />
    </div>
  );
}
