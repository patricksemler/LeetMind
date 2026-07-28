import { useState } from "react";
import type { ProblemDetail, TestOutcome } from "@shared";
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
 * Modelled on LeetCode's testcase panel: the cases are visible *before* you run anything (so you
 * can read what you're being asked for), and after a run each one carries its own verdict rather
 * than the whole submission collapsing to a single "4/5".
 *
 * Public cases only, aligned to `problem.public_tests` by index — the judge always runs every
 * public case (§8.2: public failures never stop the stream), so `results[i]` is that case's own
 * outcome whenever a run has happened at all, never a "didn't get to it" gap.
 */
export function TestCasePanel({
  problem,
  results,
}: {
  problem: ProblemDetail;
  /** Aligned to `problem.public_tests` by index. Absent until something has run. */
  results?: TestOutcome[] | null;
}) {
  const [active, setActive] = useState(0);
  const cases = problem.public_tests;

  if (cases.length === 0) {
    return (
      <div className="p-4 text-sm text-text-faint">This problem has no public example cases.</div>
    );
  }

  const index = Math.min(active, cases.length - 1);
  const testCase = cases[index]!;
  const outcome = results?.[index];

  return (
    <div className="space-y-3 p-4" data-testid="testcase-panel">
      <div role="tablist" aria-label="Test cases" className="flex flex-wrap items-center gap-1.5">
        {cases.map((_, i) => {
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
              className={`flex touch-manipulation items-center justify-center gap-1.5 rounded px-2.5 py-1 text-xs tabular-nums transition-colors duration-150 motion-reduce:transition-none ${
                selected
                  ? "bg-bg-overlay text-text"
                  : "text-text-dim hover:bg-bg-overlay hover:text-text"
              }`}
            >
              {!r && <span className={BLANK_SLOT} aria-hidden="true" />}
              <StatusMark passed={r ? r.verdict === "pass" : undefined} />
              <span>Case {i + 1}</span>
              {!r && <span className={BLANK_SLOT} aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      <CaseDetail
        signature={problem.signature}
        args={testCase.args}
        expected={testCase.expected}
        outcome={outcome}
        showOutput={!!outcome}
      />
    </div>
  );
}
