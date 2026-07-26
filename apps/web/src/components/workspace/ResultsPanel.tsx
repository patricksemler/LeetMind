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
  // Nothing has run: render nothing at all. The test-case list below is the panel's content in
  // that state, and an empty-state card stacked on top of it would just push the cases off-screen
  // to say "no results yet" — which the absence of any marks already says.
  if (!status && !verdict) return null;

  // A graded run says everything it has to say through the per-case marks. A verdict badge, a
  // pass count, a restatement of which example failed and a paragraph about what Run means are
  // all noise stacked on top of a ✓ and an ✗ that already carry it.
  const gradedRun = mode === "run" && verdict !== null && (verdict.verdict === "accepted" || verdict.verdict === "wrong_answer");
  if (gradedRun) return null;

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
        tests?: { public_passed: number; public_total: number; hidden_passed: number; hidden_total: number };
      })
    | undefined;

  const split = failure?.tests;
  // Public tests are listed first by `selectTests`, so an index inside the public range names an
  // example the user can read on this very page.
  const failedIndex = failure?.first_failing_test_index;
  const failedPublic =
    failedIndex !== undefined && split !== undefined && failedIndex < split.public_total;

  return (
    <div className="space-y-4 p-4" data-testid="verdict-panel" data-mode={mode ?? undefined}>
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={tone.badge} className="text-sm normal-case">
          {/* A run grades the public examples, but it must never read as "solved": the problem is
              only finished when the hidden tests pass too. "ran" says what happened without
              implying completion; the pass count beside it carries the actual result. */}
          {mode === "run" && verdict.verdict === "accepted" ? "ran" : friendlyVerdict(verdict.verdict)}
        </Badge>
        {/* Gated on there being something graded, not on the mode: a run now grades the public
            examples, so hiding its count would be hiding real information. Only a submission that
            graded nothing at all has no count to report. */}
        {verdict.total_tests > 0 && (
          <span className="font-mono text-xs text-text-dim">
            {verdict.passed_tests}/{verdict.total_tests} passed
          </span>
        )}
        {split && split.hidden_total > 0 && (
          // The split is the point: "4/5" does not say whether the missing one is an example you
          // can read or a hidden case you have to reason about.
          <span className="font-mono text-xs text-text-faint">
            public {split.public_passed}/{split.public_total} · hidden {split.hidden_passed}/{split.hidden_total}
          </span>
        )}
        {verdict.runtime_ms != null && <span className="font-mono text-xs text-text-faint">{verdict.runtime_ms} ms</span>}
        {verdict.memory_kb != null && (
          <span className="font-mono text-xs text-text-faint">{(verdict.memory_kb / 1024).toFixed(1)} MB</span>
        )}
      </div>

      {mode === "run" && (
        <p className="text-xs text-text-faint">
          Run checks the public examples only, and never affects mastery. Submit also runs the hidden tests — those are
          what decide whether the problem counts as solved.
        </p>
      )}

      {mode === "submit" && verdict.practice && (
        <p className="text-xs text-text-faint">
          Practice — not scored. You already gave up on this problem, so this attempt doesn't affect mastery.
        </p>
      )}

      {failure?.message && verdict.verdict !== "accepted" && <p className="text-sm text-text-dim">{failure.message}</p>}

      {/* Nothing here for a public failure: the case list below marks it and shows its input,
          expected and actual. This paragraph exists for the case the list CANNOT show — a hidden
          test — where "which one" and "why you can't see it" are the only things left to say. */}
      {failedIndex !== undefined && verdict.verdict !== "accepted" && !failedPublic && (
        <p className="text-sm text-text-dim">
          {split ? (
            <>
              Every public example passed. First failure:{" "}
              <span className="font-mono">hidden test #{failedIndex - split.public_total + 1}</span> of{" "}
              {split.hidden_total}. Hidden inputs stay hidden — otherwise the answer could just be hard-coded — so this
              one is on you to reason about: think about what the examples <em>don't</em> cover.
            </>
          ) : (
            <>
              First failure: test <span className="font-mono">#{failedIndex + 1}</span>.
            </>
          )}
        </p>
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
