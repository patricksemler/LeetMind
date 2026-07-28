/**
 * The post-reveal solution: the write-up, then the reference implementation in the language the
 * user picks. Reached only once a reveal has been earned (accepted submit, or give-up) — this
 * component never fetches anything, it renders what the reveal payload already handed over.
 *
 * The language toggle offers only the languages actually present. `cpp` is optional on the payload
 * (problem versions predating the C++ reference have Python alone), so a missing one collapses to a
 * single-language view rather than rendering an empty code block.
 */
import { useState } from "react";
import type { Language, Solutions } from "@shared";
import { CodeBlock } from "./CodeBlock";
import { Markdown } from "./Markdown";

const LABELS: Record<Language, string> = { python: "Python", cpp: "C++" };

export function SolutionPane({
  editorialMd,
  solutions,
  className = "",
}: {
  editorialMd: string;
  solutions: Solutions;
  className?: string;
}) {
  const available = (["python", "cpp"] as const).filter((l) => !!solutions[l]);
  const [language, setLanguage] = useState<Language>(available[0] ?? "python");
  const active = available.includes(language) ? language : (available[0] ?? "python");
  const code = solutions[active];

  return (
    <div className={`space-y-3 ${className}`} data-testid="solution-pane">
      <Markdown>{editorialMd}</Markdown>

      {code && (
        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex items-center gap-1" role="group" aria-label="Solution language">
            {available.map((l) => (
              <button
                key={l}
                onClick={() => setLanguage(l)}
                aria-pressed={l === active}
                className={`rounded px-2 py-1 text-xs transition-colors ${
                  l === active ? "bg-bg-overlay text-text" : "text-text-faint hover:text-text-dim"
                }`}
              >
                {LABELS[l]}
              </button>
            ))}
          </div>
          <CodeBlock code={code} language={active} />
        </div>
      )}
    </div>
  );
}
