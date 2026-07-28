/**
 * One test case's Input / Expected / Your output blocks.
 *
 * Extracted so the failing case shown in the results panel is formatted *identically* to a public
 * case in the testcase panel — same argument naming, same value formatting, same pass/fail colours.
 * A hidden case that rendered differently would read as a different kind of thing, when the only
 * difference is that its input wasn't printed on the problem page.
 */
import type { Signature, TestOutcome } from "@shared";

export function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  return JSON.stringify(value);
}

/** Names each argument from the signature, so a case reads `nums = [2,7,11,15]` rather than a
 * bare positional list the reader has to map back onto the parameters themselves. */
function argLines(signature: Signature, args: unknown[]): { name: string; value: string }[] {
  return args.map((arg, i) => ({
    name: signature.params[i]?.name ?? `arg${i + 1}`,
    value: formatValue(arg),
  }));
}

/** A checkmark or a cross, not a coloured dot: the mark reads at a glance and, unlike colour
 * alone, still carries the pass/fail distinction for anyone who can't separate red from green.
 *
 * Fixed-width: ✓ and ✗ are different widths in this font, so a self-sizing mark made every case tab
 * a slightly different size. The slot is the same width whichever mark sits in it.
 *
 * `undefined` renders nothing at all — see `BLANK_SLOT` in TestCasePanel for what stands in for the
 * mark before a run, and why it isn't this slot. */
const MARK_SLOT = "inline-flex w-3.5 shrink-0 justify-start text-[13px] leading-none";

export function StatusMark({ passed }: { passed: boolean | undefined }) {
  if (passed === undefined) return null;
  return (
    <span
      className={`${MARK_SLOT} ${passed ? "text-verdict-accepted" : "text-verdict-error"}`}
      aria-label={passed ? "passed" : "failed"}
      role="img"
    >
      {passed ? "✓" : "✗"}
    </span>
  );
}

/** What the "Your output" block says for a case that didn't come back with a usable value. */
function outputText(outcome: TestOutcome): string {
  if (outcome.verdict === "pass" || outcome.verdict === "wrong_answer") {
    return formatValue(outcome.value);
  }
  if (outcome.verdict === "timeout") return "timed out";
  return outcome.error ?? "error";
}

export function CaseDetail({
  signature,
  args,
  expected,
  outcome,
  showOutput,
}: {
  signature: Signature;
  args: unknown[];
  expected: unknown;
  /** Absent before anything has run, or for a case that hasn't been reached yet. */
  outcome?: TestOutcome;
  /** False before anything has run: the case is still worth reading, there is just no output yet. */
  showOutput: boolean;
}) {
  const passed = outcome ? outcome.verdict === "pass" : undefined;

  return (
    <div className="space-y-2.5 font-mono text-xs">
      <div>
        <div className="mb-1 font-sans text-[11px] uppercase tracking-wide text-text-faint">
          Input
        </div>
        <div className="space-y-1 rounded-md border border-border bg-bg-inset p-2.5">
          {argLines(signature, args).map((line) => (
            <div key={line.name}>
              <span className="text-text-faint">{line.name} = </span>
              <span className="text-text">{line.value}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 font-sans text-[11px] uppercase tracking-wide text-text-faint">
          Expected
        </div>
        <div className="rounded-md border border-border bg-bg-inset p-2.5 text-text">
          {formatValue(expected)}
        </div>
      </div>

      {showOutput && outcome && (
        <div>
          <div className="mb-1 font-sans text-[11px] uppercase tracking-wide text-text-faint">
            Your output
          </div>
          <div
            className={`rounded-md border p-2.5 ${
              passed
                ? "border-verdict-accepted bg-verdict-accepted-dim text-text"
                : "border-verdict-error bg-verdict-error-dim text-text"
            }`}
          >
            {outputText(outcome)}
          </div>
        </div>
      )}
    </div>
  );
}
