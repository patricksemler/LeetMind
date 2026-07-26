import { useState } from "react";
import type { PublicTestResult, PublicProblem } from "@leetmind/shared";

/**
 * The public test cases, one tab per case, each turning green or red once a run lands.
 *
 * Modelled on LeetCode's testcase panel because the shape is genuinely the right one: the cases
 * are visible *before* you run anything (so you can read what you're being asked for), and after a
 * run each one carries its own verdict rather than the whole submission collapsing to a single
 * "4/5". Naming only the first failure — which is all `failure.first_failing_test_index` can do —
 * leaves you re-reading the statement to work out which case that even was.
 *
 * Public cases only. The hidden suite has no representation here at all, by construction: this
 * renders `problem.examples`, and `public_results` is built server-side from public tests only.
 */

function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  return JSON.stringify(value);
}

/** Names each argument from the signature, so a case reads `nums = [2,7,11,15]` rather than a
 * bare positional list the reader has to map back onto the parameters themselves. */
function argLines(problem: PublicProblem, args: unknown[]): { name: string; value: string }[] {
  return args.map((arg, i) => ({
    name: problem.signature.params[i]?.name ?? `arg${i + 1}`,
    value: formatValue(arg),
  }));
}

/** A checkmark or a cross, not a coloured dot: the mark reads at a glance and, unlike colour
 * alone, still carries the pass/fail distinction for anyone who can't separate red from green. */
function StatusMark({ result }: { result: PublicTestResult | undefined }) {
  if (!result) return null;
  return (
    <span
      className={`shrink-0 text-[13px] leading-none ${result.passed ? "text-verdict-accepted" : "text-verdict-error"}`}
      aria-label={result.passed ? "passed" : "failed"}
      role="img"
    >
      {result.passed ? "✓" : "✗"}
    </span>
  );
}

export function TestCasePanel({
  problem,
  results,
}: {
  problem: PublicProblem;
  /** Aligned to `problem.examples` by index. Absent until something has run. */
  results?: PublicTestResult[] | null;
}) {
  const [active, setActive] = useState(0);
  const examples = problem.examples;

  if (examples.length === 0) {
    return (
      <div className="p-4 text-sm text-text-faint">This problem has no public example cases.</div>
    );
  }

  // The example's own prose explanation is deliberately NOT rendered here — it is already on the
  // problem statement two panes to the left, and repeating it under every case turns a compact
  // pass/fail readout back into a wall of text.
  const index = Math.min(active, examples.length - 1);
  const example = examples[index]!;
  const result = results?.[index];

  return (
    <div className="space-y-3 p-4" data-testid="testcase-panel">
      <div role="tablist" aria-label="Test cases" className="flex flex-wrap items-center gap-1.5">
        {examples.map((_, i) => {
          const selected = i === index;
          const r = results?.[i];
          return (
            <button
              key={i}
              role="tab"
              aria-selected={selected}
              onClick={() => setActive(i)}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors ${
                selected ? "bg-bg-overlay text-text" : "text-text-dim hover:bg-bg-overlay hover:text-text"
              }`}
            >
              <StatusMark result={r} />
              <span>Case {i + 1}</span>
            </button>
          );
        })}
      </div>

      <div className="space-y-2.5 font-mono text-xs">
        <div>
          <div className="mb-1 font-sans text-[11px] uppercase tracking-wide text-text-faint">Input</div>
          <div className="space-y-1 rounded-md border border-border bg-bg-inset p-2.5">
            {argLines(problem, example.args).map((line) => (
              <div key={line.name}>
                <span className="text-text-faint">{line.name} = </span>
                <span className="text-text">{line.value}</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1 font-sans text-[11px] uppercase tracking-wide text-text-faint">Expected</div>
          <div className="rounded-md border border-border bg-bg-inset p-2.5 text-text">
            {formatValue(example.expected)}
          </div>
        </div>

        {result && (
          <div>
            <div className="mb-1 font-sans text-[11px] uppercase tracking-wide text-text-faint">Your output</div>
            <div
              className={`rounded-md border p-2.5 ${
                result.passed
                  ? "border-verdict-accepted bg-verdict-accepted-dim text-text"
                  : "border-verdict-error bg-verdict-error-dim text-text"
              }`}
            >
              {/* A case that errored or timed out has no output to show — say which, rather than
                  rendering an empty box that reads like "returned nothing". */}
              {result.status === "passed" || result.status === "failed"
                ? formatValue(result.actual)
                : result.status === "not_run"
                  ? "not run — an earlier case ended the run"
                  : result.status}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
