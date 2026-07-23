import type { Concept } from "@algolift/shared";
import { Badge } from "../ui";

interface ProblemConceptRef {
  id: string;
  role: "primary" | "secondary";
  weight: number;
}

/**
 * Concept/algorithm tags stay hidden until solve or give-up (PLAN.md §8, docs/CONTRACTS.md §4.2).
 * This gate is enforced here, in the component — it never renders `concepts` unless the caller
 * also asserts `revealed`, regardless of what data happens to be sitting in props. That way a
 * stray prop threaded through from elsewhere can't leak concepts early.
 */
export function ConceptTags({
  revealed,
  concepts,
  names,
}: {
  revealed: boolean;
  concepts: ProblemConceptRef[] | null | undefined;
  names?: Record<string, Concept>;
}) {
  if (!revealed || !concepts || concepts.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-text-faint">
        <span aria-hidden>🔒</span>
        <span>Concepts hidden until you solve or give up</span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="concept-tags">
      {concepts.map((c) => (
        <Badge key={c.id} tone={c.role === "primary" ? "accent" : "neutral"}>
          {names?.[c.id]?.name ?? c.id}
        </Badge>
      ))}
    </div>
  );
}
