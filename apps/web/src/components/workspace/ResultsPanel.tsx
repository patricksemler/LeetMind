/**
 * Live submission results: connection/lifecycle status + per-test progress while running, then
 * the verdict once it lands. Mode-gated diagnostics per docs/CONTRACTS.md §4.5 — a `submit`-mode
 * `wrong_answer` shows only the failing test index, never `expected`/`actual`/`input` previews;
 * `run`-mode shows them (it's a scratch execution against user-supplied input, not the hidden
 * suite). That gate is enforced here unconditionally, not just trusted from the server payload.
 */
import type { SubmissionMode, SubmissionStatus, VerdictEvent } from "@leetmind/shared";
import { Badge, Meter } from "../ui";
import type { BadgeTone } from "../ui/Badge";
import type { MeterTone } from "../ui/Meter";
import { Markdown } from "./Markdown";

const VERDICT_TONE: Record<string, { badge: BadgeTone; meter: MeterTone }> = {
  accepted: { badge: "accepted", meter: "accepted" },
  wrong_answer: { badge: "error", meter: "error" },
  compilation_error: { badge: "error", meter: "error" },
  runtime_error: { badge: "error", meter: "error" },
  internal_error: { badge: "error", meter: "error" },
  cancelled: { badge: "neutral", meter: "neutral" },
  time_limit: { badge: "warn", meter: "warn" },
  memory_limit: { badge: "warn", meter: "warn" },
  output_limit: { badge: "warn", meter: "warn" },
};

const STATUS_LABEL: Record<SubmissionStatus, string> = {
  created: "Created",
  queued: "Queued",
  assigned: "Assigned to a worker",
  compiling: "Compiling",
  running: "Running tests",
  completed: "Completed",
  cancelled: "Cancelled",
};

function friendlyVerdict(v: string): string {
  return v.replace(/_/g, " ");
}

export function ResultsPanel({
  mode,
  status,
  progress,
  verdict,
  connectionState,
}: {
  mode: SubmissionMode | null;
  status: SubmissionStatus | null;
  progress: { passed: number; total: number } | null;
  verdict: VerdictEvent | null;
  connectionState: string;
}) {
  if (!status && !verdict) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-text-faint">
        Run against custom input or submit to see results here.
      </div>
    );
  }

  if (!verdict) {
    return (
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-text">{status ? STATUS_LABEL[status] : "Connecting…"}</span>
          {connectionState === "reconnecting" && <Badge tone="warn">reconnecting…</Badge>}
        </div>
        {progress && (
          <Meter
            value={progress.passed}
            max={progress.total}
            tone="accent"
            label={
              <>
                <span>Tests passed</span>
                <span>
                  {progress.passed} / {progress.total}
                </span>
              </>
            }
          />
        )}
      </div>
    );
  }

  const tone = VERDICT_TONE[verdict.verdict] ?? { badge: "neutral" as const, meter: "neutral" as const };
  const failure = verdict.failure as
    | (Record<string, unknown> & {
        kind?: string;
        message?: string;
        first_failing_test_index?: number;
        stderr_tail?: string;
        input_preview?: unknown;
        expected_preview?: unknown;
        actual_preview?: unknown;
      })
    | undefined;

  const showPreviews = mode === "run";

  return (
    <div className="space-y-4 p-4" data-testid="verdict-panel" data-mode={mode ?? undefined}>
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={tone.badge} className="text-sm normal-case">
          {/* Run mode never grades anything (CONTRACTS §4.5) — "accepted" implies a pass/fail
              judgment that didn't happen; "ran" says what actually occurred. */}
          {mode === "run" && verdict.verdict === "accepted" ? "ran" : friendlyVerdict(verdict.verdict)}
        </Badge>
        {!(mode === "run" && verdict.verdict === "accepted") && (
          <span className="font-mono text-xs text-text-dim">
            {verdict.passed_tests}/{verdict.total_tests} passed
          </span>
        )}
        {verdict.runtime_ms != null && <span className="font-mono text-xs text-text-faint">{verdict.runtime_ms} ms</span>}
        {verdict.memory_kb != null && (
          <span className="font-mono text-xs text-text-faint">{(verdict.memory_kb / 1024).toFixed(1)} MB</span>
        )}
      </div>

      <Meter value={verdict.passed_tests} max={Math.max(1, verdict.total_tests)} tone={tone.meter} />

      {mode === "run" && (
        <p className="text-xs text-text-faint">Run mode — checked against custom input only. This does not affect mastery.</p>
      )}

      {mode === "submit" && verdict.practice && (
        <p className="text-xs text-text-faint">
          Practice — not scored. You already gave up on this problem, so this attempt doesn't affect mastery.
        </p>
      )}

      {failure?.message && verdict.verdict !== "accepted" && <p className="text-sm text-text-dim">{failure.message}</p>}

      {verdict.verdict === "wrong_answer" && mode === "submit" && failure?.first_failing_test_index !== undefined && (
        <p className="text-sm text-text-dim">
          Failed on hidden test <span className="font-mono">#{failure.first_failing_test_index + 1}</span>. Expected
          output for hidden tests is never shown.
        </p>
      )}

      {showPreviews && failure && (failure.input_preview !== undefined || failure.expected_preview !== undefined) && (
        <div className="space-y-1.5 rounded-md border border-border bg-bg-inset p-3 font-mono text-xs">
          {failure.input_preview !== undefined && (
            <div>
              <span className="text-text-faint">input: </span>
              {JSON.stringify(failure.input_preview)}
            </div>
          )}
          {failure.expected_preview !== undefined && (
            <div>
              <span className="text-text-faint">expected: </span>
              {JSON.stringify(failure.expected_preview)}
            </div>
          )}
          {failure.actual_preview !== undefined && (
            <div>
              <span className="text-text-faint">actual: </span>
              {JSON.stringify(failure.actual_preview)}
            </div>
          )}
        </div>
      )}

      {failure?.stderr_tail && (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-verdict-error bg-verdict-error-dim p-3 font-mono text-xs text-text">
          {failure.stderr_tail}
        </pre>
      )}

      {verdict.verdict === "accepted" && mode === "submit" && verdict.reveal && (
        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-text-faint">Editorial</h3>
            <span className="font-mono text-[11px] text-text-faint">
              time {verdict.reveal.target_complexity.time} · space {verdict.reveal.target_complexity.space}
            </span>
          </div>
          <Markdown>{verdict.reveal.editorial_md}</Markdown>
        </div>
      )}
    </div>
  );
}
