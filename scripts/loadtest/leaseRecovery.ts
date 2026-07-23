// Lease-recovery-under-load scenario: submits one long-sleeping "victim" submission while the
// general load in runner.ts is concurrently hammering the same judge worker pool, waits until a
// specific spawned judge process has actually claimed and started executing it (real `docker run`
// in flight, not just claimed), SIGKILLs that OS process for real, and measures wall-clock time
// until a surviving worker completes it. Same rationale as
// apps/judge/test/chaos/workerKill.test.ts for why this must be a real SIGKILL of a real
// subprocess rather than an in-process abort — the difference here is PRODUCTION lease/reaper/
// heartbeat timings (see config.ts's doc comment) and a busy queue full of concurrent unrelated
// traffic, which is the whole point: this number is meant to be more representative than the
// idle chaos-suite one, not faster.
import { query } from "@algolift/db";
import { createSubmission, waitForTerminal } from "./client.js";
import type { LoadProfile } from "./config.js";
import type { ManagedProcess } from "./processes.js";
import { leaseRecoveryVictimSource } from "./sources.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface JobRow {
  status: string;
  leased_by: string | null;
}

async function pollJobLeasedBy(submissionId: string, timeoutMs: number): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await query<JobRow>(`select status, leased_by from jobs where idempotency_key = $1`, [
      `judge:${submissionId}`,
    ]);
    const row = rows[0];
    if (row && row.status === "leased" && row.leased_by) return row.leased_by;
    await sleep(50);
  }
  return null;
}

export interface LeaseRecoveryResult {
  submissionId: string;
  killedWorkerId: string;
  killedAt: number;
  recoveredAt: number | null;
  recoveryMs: number | null;
  verdict: string | null;
  timedOut: boolean;
}

export async function runLeaseRecoveryUnderLoad(opts: {
  apiBase: string;
  problemVersionId: string;
  profile: LoadProfile;
  workers: ManagedProcess[];
}): Promise<LeaseRecoveryResult> {
  const { submissionId } = await createSubmission({
    apiBase: opts.apiBase,
    problemVersionId: opts.problemVersionId,
    language: "python",
    source: leaseRecoveryVictimSource(opts.profile),
  });

  // Give it up to 20s to be claimed even under a loaded queue (production priority is judge >
  // verify > generate and this IS a judge job, but a busy pool of judgeWorkerProcesses *
  // judgeConcurrencyPerWorker slots may still all be momentarily full).
  const leasedBy = await pollJobLeasedBy(submissionId, 20_000);
  if (!leasedBy) {
    throw new Error(
      `runLeaseRecoveryUnderLoad: victim submission ${submissionId} was not claimed within 20s — is the load ` +
        `overwhelming every judge worker's queue-poll loop, or did something else go wrong?`,
    );
  }

  const victim = opts.workers.find((w) => w.workerId === leasedBy);
  if (!victim) {
    throw new Error(
      `runLeaseRecoveryUnderLoad: job was claimed by worker_id="${leasedBy}", which doesn't match any ` +
        `harness-spawned worker (${opts.workers.map((w) => w.workerId).join(", ")}) — cannot target it for SIGKILL.`,
    );
  }

  // Give it a moment to be genuinely mid-`docker run` (sleeping inside the sandbox) rather than
  // killing it the instant the lease lands, which would just test claim-time bookkeeping, not
  // recovery from a worker that's truly gone mid-execution.
  await sleep(Math.min(1500, Math.floor(opts.profile.leaseRecoveryVictimSleepMs / 2)));

  const killedAt = Date.now();
  await victim.kill();

  const recoveryBudgetMs = opts.profile.queueLeaseSeconds * 1000 + opts.profile.queueReaperIntervalMs + 20_000;
  const result = await waitForTerminal({ apiBase: opts.apiBase, submissionId, timeoutMs: recoveryBudgetMs });
  const recoveredAt = result.timedOutWaiting ? null : Date.now();

  return {
    submissionId,
    killedWorkerId: leasedBy,
    killedAt,
    recoveredAt,
    recoveryMs: recoveredAt !== null ? recoveredAt - killedAt : null,
    verdict: result.verdict,
    timedOut: result.timedOutWaiting,
  };
}
