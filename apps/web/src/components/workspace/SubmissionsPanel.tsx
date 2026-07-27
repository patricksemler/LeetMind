/**
 * Attempt history for one problem, and the detail of whichever attempt is selected.
 *
 * This is where a submit's outcome lives. The workspace deliberately shows nothing about lifecycle
 * inline any more — no "Queued", no "Assigned to a worker", no running pass-count. While a submit is
 * in flight the Submit button carries the only progress signal there is, and when it lands the user
 * arrives here: either it passed, or one case failed and that case is on screen.
 *
 * The failing case is rendered through the same `CaseDetail` as a public example, including when it
 * is a hidden one. See `FailingTestSchema` in @leetmind/shared for why the hidden case is served at
 * all, and for the bound on it (one case per submission, never the suite).
 */
import type { Submission, PublicProblem } from "@leetmind/shared";
import { CaseDetail } from "./CaseDetail";
import { CodeBlock } from "./CodeBlock";

/** `wrong_answer` reads as "rejected": from the user's side the distinction between failing a case
 * and being turned away is not one they act on differently. Verdicts that DO imply a different next
 * step — a compile error, a timeout — keep their own names, because "rejected" would hide the one
 * thing that makes them different. */
function verdictLabel(submission: Submission): string {
  if (submission.status !== "completed")
    return submission.status === "cancelled" ? "cancelled" : "judging";
  if (submission.verdict === "wrong_answer") return "rejected";
  return (submission.verdict ?? "pending").replace(/_/g, " ");
}

/** The attempt's date. Not a relative "3 minutes ago": within one sitting every attempt is "a few
 * minutes ago", which distinguishes nothing. */
function dateLabel(at: Submission["created_at"]): string {
  const d = at instanceof Date ? at : new Date(at);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Pass/fail is binary here even though the verdict isn't: green ✓ or red ✗, with the specific
 * verdict still spelled out in words beside it. A timed-out attempt is a failed attempt at a glance,
 * and the word is what says *how* it failed.
 *
 * `null` while a submission is still being judged — an unjudged attempt is neither.
 */
function outcomeOf(submission: Submission): "passed" | "failed" | null {
  if (submission.status !== "completed") return null;
  return submission.verdict === "accepted" ? "passed" : "failed";
}

/** How many judged attempts the tab shows. A history, not an audit log — past the last few, an
 * attempt is nothing anyone compares against. The server sends a small buffer over this
 * (`SUBMISSION_HISTORY_LIMIT`, apps/api) so unfinished attempts, which are filtered out below,
 * can't push judged ones out of the five. */
const HISTORY_SHOWN = 5;

export function SubmissionsPanel({
  problem,
  submissions,
  selectedId,
  onSelect,
  loading,
}: {
  problem: PublicProblem;
  submissions: Submission[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading?: boolean;
}) {
  // Judged attempts only. An in-flight submission has no verdict, no counts and no failing case —
  // its row would be a blank waiting to be filled, and its detail an empty panel — so it isn't
  // shown at all until the judge comes back. The list is then the last few results and nothing else.
  // (`cancelled` is filtered out by the same rule: it never produced a result.)
  const history = submissions.filter((s) => s.status === "completed").slice(0, HISTORY_SHOWN);

  if (loading && history.length === 0) {
    return <div className="p-5 text-sm text-text-faint">Loading submissions…</div>;
  }

  if (history.length === 0) {
    return (
      <div className="p-5 text-sm text-text-faint">
        No submissions yet. Submit to run your code against the hidden tests as well as the
        examples.
      </div>
    );
  }

  // `selectedId` can name a submission that isn't in `history` yet — the tab is switched to the
  // instant a verdict arrives, a beat before the refetch that adds the judged row. Falling back to
  // `history[0]` there would put a PREVIOUS attempt's verdict, failing case and code on screen under
  // the heading of the one just submitted, so the unmatched case renders the list and no detail at
  // all. Only an absent `selectedId` (the tab opened by hand) falls back to the newest.
  const selected = history.find((s) => s.id === selectedId) ?? (selectedId ? null : history[0]!);

  const failing = selected?.failure?.failing_test;
  const selectedOutcome = selected ? outcomeOf(selected) : null;

  return (
    <div className="space-y-4 p-5" data-testid="submissions-panel">
      <ol className="space-y-1">
        {history.map((s) => {
          const isSelected = s.id === selected?.id;
          const outcome = outcomeOf(s);
          return (
            <li key={s.id}>
              <button
                onClick={() => onSelect(s.id)}
                aria-current={isSelected}
                // Spelled out, because the row's visible content is a glyph and two fragments: read
                // aloud, "✗ Python 5/6" is not a sentence. Which attempt this is comes from the
                // enclosing <ol>, which screen readers announce as position in the list.
                aria-label={`${verdictLabel(s)} — ${s.language === "cpp" ? "C++" : "Python"}, ${dateLabel(s.created_at)}${
                  s.status === "completed"
                    ? `, ${s.passed_tests} of ${s.total_tests} tests passed`
                    : ""
                }`}
                // The WHOLE row carries the outcome, not a badge inside a neutral row: a list of
                // attempts is scanned, and a tinted row with a mark reads in one pass. Selection is
                // a brightness/ring change on top of that, so it never competes with pass/fail.
                className={`flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors ${
                  outcome === "passed"
                    ? "border-verdict-accepted bg-verdict-accepted-dim"
                    : outcome === "failed"
                      ? "border-verdict-error bg-verdict-error-dim"
                      : "border-border bg-bg-inset"
                } ${isSelected ? "ring-1 ring-inset ring-text-faint" : "opacity-80 hover:opacity-100"}`}
              >
                {/* A mark, not colour alone — the outcome has to survive being unable to tell red
                    from green. */}
                <span
                  aria-hidden="true"
                  className={`shrink-0 text-[13px] leading-none ${
                    outcome === "passed"
                      ? "text-verdict-accepted"
                      : outcome === "failed"
                        ? "text-verdict-error"
                        : "text-text-faint"
                  }`}
                >
                  {outcome === "passed" ? "✓" : outcome === "failed" ? "✗" : "·"}
                </span>
                {/* No verdict word in the row: the tint and the mark already say pass or fail, and
                    repeating it in text made every row lead with the same two words. The specific
                    verdict is spelled out in the detail below (and in this row's aria-label, since
                    the mark itself is aria-hidden). */}
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-faint">
                  {s.language === "cpp" ? "C++" : "Python"}
                </span>
                {/* The count lives in the detail below, where it sits beside the verdict it
                    qualifies. In the row the mark already says pass or fail, so this slot carries
                    the one thing the row can't otherwise tell you: which attempt, and when. */}
                <span className="shrink-0 font-mono text-[11px] text-text-faint">
                  {dateLabel(s.created_at)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {/* The verdict, the case that broke it (if any), and the code that produced it. No public/hidden
          split — the "hidden test" tag on the failing case already says which side it came from — and
          no timings, which say nothing a user acts on. */}
      {selected && (
        <div className="space-y-3 border-t border-border pt-4">
          {/* Plain coloured text, not a badge: at the head of its own panel the verdict is the heading,
              and a pill here read as one more chip among the tags below it. */}
          <div className="flex items-baseline justify-between gap-3">
            <span
              className={`text-sm font-medium uppercase tracking-wide ${
                selectedOutcome === "passed"
                  ? "text-verdict-accepted"
                  : selectedOutcome === "failed"
                    ? "text-verdict-error"
                    : "text-text-faint"
              }`}
            >
              {verdictLabel(selected)}
            </span>
            {selected.status === "completed" && (
              <span className="shrink-0 font-mono text-xs text-text-faint">
                {selected.passed_tests} / {selected.total_tests} test cases
              </span>
            )}
          </div>

          {/* Kept for the verdicts that have no failing case to show — a compile error's stderr is the
              only diagnostic there is, and dropping it would leave an empty panel. */}
          {selected.failure?.stderr_tail && (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-verdict-error bg-verdict-error-dim p-3 font-mono text-xs text-text">
              {selected.failure.stderr_tail}
            </pre>
          )}

          {/* No heading over it. The only case a rejected attempt shows IS the failing one, directly
              under a verdict that already says the attempt failed — and it isn't tagged public/hidden
              either, since that's a distinction the user can't act on. */}
          {failing && (
            <CaseDetail
              signature={problem.signature}
              args={failing.args}
              expected={failing.expected}
              actual={failing.actual}
              passed={false}
              status={failing.status}
              showOutput
            />
          )}

          {/* The submitted source, not the reference solution: this is a record of an attempt, and on
              an accepted one it is exactly "the code that worked". */}
          <div className="space-y-1">
            <h3 className="text-xs font-medium uppercase tracking-wide text-text-faint">Code</h3>
            <CodeBlock code={selected.source} language={selected.language} />
          </div>
        </div>
      )}
    </div>
  );
}
