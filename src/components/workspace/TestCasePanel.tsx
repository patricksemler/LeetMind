import { useState } from "react";
import type { PublicTestResult, PublicProblem } from "@shared";
import { CaseDetail, StatusMark } from "./CaseDetail";

/**
 * What holds a case tab's width open before a run, in place of the ✓/✗.
 *
 * Not an empty copy of the mark's own slot: that slot sits to the LEFT of the label, so leaving it
 * standing empty is 14px of nothing on one side of the label and nothing on the other — the label
 * reads as pushed off centre, which is exactly what it is. Instead the same total width is put back
 * split across both sides, so the label centres and the tab measures the same either way.
 *
 * The arithmetic, in the row's own `gap-1.5` (6px) units: a marked tab spends `slot(14) + gap(6)`
 * = 20px beside the label, and an unmarked one spends `4 + gap(6)` on each side — also 20. Change
 * either the slot or the row gap and this has to move with it.
 */
const BLANK_SLOT = "w-1 shrink-0";

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
 * renders `problem.examples`, and `public_results` is built server-side from public tests only. A
 * failing hidden case is shown in the Submissions tab instead, where the whole attempt is in view.
 */
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
              // Whatever is on the tab is centred: the ✓/✗ and the label as one group once a run has
              // landed, the label alone before one has. The width never changes between those two
              // states — see BLANK_SLOT — so the cases stay exactly where they are and the distance
              // between them is the same before and after a run.
              //
              // `tabular-nums` alongside `StatusMark`'s fixed slot is what keeps every case tab the
              // same width as its neighbours: the slot handles ✓ vs ✗ (different widths in this
              // font), and this handles "Case 9" vs "Case 10" — proportional digits differ too, so
              // the row still shifted by a pixel or two per tab without it.
              className={`flex items-center justify-center gap-1.5 rounded px-2.5 py-1 text-xs tabular-nums transition-colors ${
                selected
                  ? "bg-bg-overlay text-text"
                  : "text-text-dim hover:bg-bg-overlay hover:text-text"
              }`}
            >
              {!r && <span className={BLANK_SLOT} aria-hidden="true" />}
              <StatusMark passed={r ? r.passed : undefined} />
              <span>Case {i + 1}</span>
              {!r && <span className={BLANK_SLOT} aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      <CaseDetail
        signature={problem.signature}
        args={example.args}
        expected={example.expected}
        actual={result?.actual}
        passed={result?.passed}
        status={result?.status}
        showOutput={!!result}
      />
    </div>
  );
}
