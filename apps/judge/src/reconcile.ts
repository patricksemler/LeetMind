// Stranded-submission reconciliation (QA-PLAN.md §2.3). A judge job that exhausts its retries —
// whether via `Queue.fail()` (the handler kept throwing) or the reaper (the worker process that
// held the lease died outright) — lands `status='dead'` in `jobs`, but nothing ever wrote a
// terminal state for the submission it was judging. Confirmed live: the submission is left
// `queued`/`assigned`/`compiling`/`running` forever, and the client shows "running…" with no
// recovery, no error, nothing.
//
// This is a periodic sweep rather than a hook on the worker's fail() path, deliberately: it also
// catches the reaper-driven case (no in-process handler ever ran to hook into) and is naturally
// idempotent — once a submission is completed, it no longer matches the sweep's own query, so
// re-running it (on every tick, or after a crash mid-sweep) is always safe.
import type { PoolClient } from "pg";
import { completeSubmission, notify, query, withTransaction } from "@algolift/db";
import type { JudgeDeps } from "./deps.js";

interface StrandedRow {
  submission_id: string;
  user_id: string;
}

const NON_TERMINAL_STATUSES = ["queued", "assigned", "compiling", "running"] as const;

/**
 * Finds every `submissions` row that's still non-terminal but whose backing `judge` job has
 * already gone `dead`, and completes it with an `internal_error` verdict + the matching SSE
 * events — the same terminal shape a real judge failure would have produced, so the client's
 * existing verdict-rendering path (not a special "stranded" UI state) is what recovers it.
 */
export async function reconcileStrandedSubmissions(deps: JudgeDeps): Promise<number> {
  const stranded = await query<StrandedRow>(
    `select s.id as submission_id, s.user_id
       from submissions s
       join jobs j on j.kind = 'judge' and j.payload->>'submission_id' = s.id
      where j.status = 'dead'
        and s.status = any($1::text[])`,
    [NON_TERMINAL_STATUSES],
  );

  for (const row of stranded) {
    await completeStranded(row, deps);
  }
  return stranded.length;
}

async function completeStranded(row: StrandedRow, deps: JudgeDeps): Promise<void> {
  try {
    await withTransaction(async (client: PoolClient) => {
      await completeSubmission(client, row.submission_id, {
        verdict: "internal_error",
        passed_tests: 0,
        total_tests: 0,
        failure: {
          kind: "internal_error",
          message: "The judge could not produce a verdict for this submission after repeated attempts.",
        },
      });
      const at = new Date().toISOString();
      await notify(client, { type: "status", submission_id: row.submission_id, user_id: row.user_id, status: "completed", at });
      await notify(client, {
        type: "verdict",
        submission_id: row.submission_id,
        user_id: row.user_id,
        verdict: "internal_error",
        passed_tests: 0,
        total_tests: 0,
        failure: { kind: "internal_error", message: "The judge could not produce a verdict for this submission after repeated attempts." },
      });
    });
    deps.logger.warn({ submission_id: row.submission_id }, "reconciled stranded submission (dead judge job)");
  } catch (err) {
    deps.logger.error({ err, submission_id: row.submission_id }, "failed to reconcile stranded submission");
  }
}

export interface StrandedSweepHandle {
  stop: () => void;
}

/** setInterval-style loop, mirroring @algolift/queue's `startReaper`. */
export function startStrandedSweep(deps: JudgeDeps, opts: { intervalMs?: number; signal?: AbortSignal } = {}): StrandedSweepHandle {
  const intervalMs = opts.intervalMs ?? 10_000;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    reconcileStrandedSubmissions(deps)
      .catch((err) => deps.logger.error({ err }, "stranded-submission sweep threw"))
      .finally(() => {
        running = false;
      });
  };

  tick(); // catch anything that went dead while the process was down, without waiting a full interval
  const timer = setInterval(tick, intervalMs);
  const stop = () => clearInterval(timer);
  if (opts.signal) {
    if (opts.signal.aborted) stop();
    else opts.signal.addEventListener("abort", stop, { once: true });
  }
  return { stop };
}
