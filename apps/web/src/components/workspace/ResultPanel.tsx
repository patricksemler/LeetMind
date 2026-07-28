/**
 * The outcome of the last Submit. Run/Submit are synchronous single calls now (PLAN_BACKEND.md
 * §8.3) — there's no submission history to list, so this shows the one result currently on
 * screen rather than a scrollable log the way the old async-lifecycle app did.
 *
 * A Run's own outcome is already fully visible in the per-case `TestCasePanel` below the editor
 * (every public case, every time — §8.2: public failures never stop the stream), so this panel has
 * nothing to add for a Run and says so in one line. A Submit is where this panel earns its keep:
 * the failing *private* case (never shown anywhere else, since the public suite alone doesn't
 * cover it) and the code that produced it.
 */
import type { CodeRequest, FailingCaseView, ProblemDetail, TestOutcome } from "@shared";
import { SectionLabel } from "../ui";
import { CaseDetail } from "./CaseDetail";
import { CodeBlock } from "./CodeBlock";

export interface LastResult {
  kind: "run" | "submit";
  passed: boolean;
  solved: boolean;
  results: TestOutcome[];
  failingCase?: FailingCaseView | null;
  code: CodeRequest["code"];
}

export function ResultPanel({
  problem,
  result,
}: {
  problem: ProblemDetail;
  result: LastResult | null;
}) {
  if (!result) {
    return (
      <div className="p-4 text-sm text-text-faint sm:p-5" data-testid="results-panel">
        No submissions yet. Submit to run your code against the hidden tests as well as the
        examples.
      </div>
    );
  }

  if (result.kind === "run") {
    return (
      <div className="p-4 text-sm text-text-faint sm:p-5" data-testid="results-panel">
        That was a run against the public examples only — see the test cases below. Submit to run
        the hidden suite too.
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:p-5" data-testid="results-panel">
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={`text-sm font-medium uppercase tracking-wide ${
            result.solved ? "text-verdict-accepted" : "text-verdict-error"
          }`}
        >
          {result.solved ? "accepted" : "rejected"}
        </span>
      </div>

      {/* Only a private failure reaches here (a public one is demoted to `kind: "run"` server-side
          and never carries a failing case) — not tagged public/hidden, since that isn't a
          distinction the user can act on. */}
      {result.failingCase && (
        <CaseDetail
          signature={problem.signature}
          args={result.failingCase.input}
          expected={result.failingCase.expected}
          outcome={{
            index: -1,
            verdict: "wrong_answer",
            value: result.failingCase.actual,
            printed: "",
            duration_ms: 0,
          }}
          showOutput
        />
      )}

      <div className="space-y-1">
        <SectionLabel>Code</SectionLabel>
        <CodeBlock code={result.code} />
      </div>
    </div>
  );
}
