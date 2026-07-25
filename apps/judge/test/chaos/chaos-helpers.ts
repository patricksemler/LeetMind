// Shared plumbing for apps/judge/test/chaos/*.test.ts (M4's chaos/idempotency suite —
// PLAN.md §10 M4 / §12 risk 4, docs/CONTRACTS.md §5 + §13). Re-exports the existing
// apps/judge/test/helpers.ts fixtures (the model for test hygiene: only ever touch rows a test
// itself created) and adds the extra pieces the chaos suite specifically needs: spawning/killing
// real worker subprocesses, generic DB-polling, and job-row bookkeeping so every chaos test can
// clean up the `jobs` rows it created (the existing helpers.ts never needed to, since its tests
// call the handler directly without ever going through a real `queue.enqueue`).
import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, query } from "@leetmind/db";
import { Queue } from "@leetmind/queue";
import type { JudgeJobPayload } from "@leetmind/shared";
import type { SubmissionRow } from "@leetmind/db";

export * from "../helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../../../..");
export const WORKER_PROCESS_PATH = path.resolve(__dirname, "worker-process.ts");

/** Generic poll-until helper. Throws with a descriptive message (including the last-seen value,
 * when `describe` is given) rather than vitest's generic timeout, so a chaos-test failure is
 * diagnosable from the message alone. */
export async function waitFor<T>(
  check: () => Promise<T | undefined | null | false>,
  opts: { timeoutMs: number; intervalMs?: number; describe?: string } = { timeoutMs: 10_000 },
): Promise<T> {
  const intervalMs = opts.intervalMs ?? 50;
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < opts.timeoutMs) {
    const result = await check();
    if (result) return result;
    last = result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitFor: condition${opts.describe ? ` (${opts.describe})` : ""} not met within ${opts.timeoutMs}ms` +
      (last !== undefined ? ` (last value: ${JSON.stringify(last)})` : ""),
  );
}

export interface ChaosWorkerOpts {
  workerId: string;
  kinds?: string[];
  concurrency?: number;
  leaseSeconds?: number;
  reaperIntervalMs?: number;
  pollIntervalMs?: number;
  heartbeatMs?: number;
}

export interface ChaosWorkerHandle {
  workerId: string;
  proc: ChildProcessByStdio<null, Readable, Readable>;
  stdout: string;
  stderr: string;
  /** Resolves once the worker has printed its readiness line. Does NOT guarantee it has claimed
   * anything yet — callers that need "has claimed job X" should poll the `jobs` table instead. */
  ready: Promise<void>;
  /** SIGKILL — the whole point of the "worker killed mid-judge" test: no graceful shutdown, no
   * chance to finish an in-flight heartbeat or ack. Resolves once the OS has reaped the process. */
  kill(): Promise<void>;
  /** Graceful stop (SIGTERM) for workers this suite spawned only to do cleanup/recovery duty. */
  stop(): Promise<void>;
}

/** Spawns apps/judge/test/chaos/worker-process.ts as a real, separate OS process (`node --import
 * tsx`, the same invocation style CONTRACTS.md §6.1 documents for the sandbox CLI bridge). Inherits
 * the current process's env (which by the time any chaos test file runs already has DATABASE_URL
 * redirected + guarded by test/testSetup.ts), with `CHAOS_*` overrides layered on top. */
export function spawnChaosWorker(opts: ChaosWorkerOpts): ChaosWorkerHandle {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CHAOS_WORKER_ID: opts.workerId,
    CHAOS_KINDS: (opts.kinds ?? ["judge"]).join(","),
    CHAOS_CONCURRENCY: String(opts.concurrency ?? 1),
  };
  if (opts.leaseSeconds !== undefined) env.CHAOS_LEASE_SECONDS = String(opts.leaseSeconds);
  if (opts.reaperIntervalMs !== undefined) env.CHAOS_REAPER_INTERVAL_MS = String(opts.reaperIntervalMs);
  if (opts.pollIntervalMs !== undefined) env.CHAOS_POLL_INTERVAL_MS = String(opts.pollIntervalMs);
  if (opts.heartbeatMs !== undefined) env.CHAOS_HEARTBEAT_MS = String(opts.heartbeatMs);

  const proc = spawn("node", ["--import", "tsx", WORKER_PROCESS_PATH], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const handle: ChaosWorkerHandle = {
    workerId: opts.workerId,
    proc,
    stdout: "",
    stderr: "",
    ready: undefined as unknown as Promise<void>,
    async kill() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill("SIGKILL");
      await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    },
    async stop() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => proc.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
      }
    },
  };

  proc.stdout.on("data", (d: Buffer) => {
    handle.stdout += d.toString("utf8");
  });
  proc.stderr.on("data", (d: Buffer) => {
    handle.stderr += d.toString("utf8");
  });

  handle.ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `spawnChaosWorker(${opts.workerId}): did not print readiness within 15s.\n` +
            `stdout:\n${handle.stdout}\nstderr:\n${handle.stderr}`,
        ),
      );
    }, 15_000);
    const onData = () => {
      if (handle.stdout.includes(`CHAOS_WORKER_READY ${opts.workerId}`)) {
        clearTimeout(timer);
        proc.stdout.off("data", onData);
        resolve();
      }
    };
    proc.stdout.on("data", onData);
    proc.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.once("exit", (code, signal) => {
      // If it exits before ever becoming ready, that's a setup failure the caller needs to see.
      if (!handle.stdout.includes(`CHAOS_WORKER_READY ${opts.workerId}`)) {
        clearTimeout(timer);
        reject(
          new Error(
            `spawnChaosWorker(${opts.workerId}): process exited (code=${code}, signal=${signal}) before ` +
              `becoming ready.\nstdout:\n${handle.stdout}\nstderr:\n${handle.stderr}`,
          ),
        );
      }
    });
  });

  return handle;
}

// --- job bookkeeping (the chaos suite, unlike the existing handler tests, does real queue.enqueue
// calls, so it owns real `jobs` rows it must clean up) --------------------------------------------

/** A Queue instance pointed at the shared test pool, for tests that talk to the queue directly
 * (poison-job, claim-storm, reaper-idempotence, transactional-enqueue) rather than through a
 * spawned worker process. `leaseSeconds` defaults to the package default (30s) unless overridden. */
export function testQueue(opts: { workerId?: string; leaseSeconds?: number } = {}): Queue {
  return new Queue(getPool(), { workerId: opts.workerId, leaseSeconds: opts.leaseSeconds });
}

/** Enqueues a real `judge` job for `submission`, exactly the way `POST /api/submissions` does
 * (CONTRACTS.md §9: submission row + job in one transaction) — here split into two calls since the
 * submission was already inserted by `insertTestSubmission`, but using the SAME idempotency-key
 * convention (`judge:<submission_id>`) production code uses. */
export async function enqueueJudgeJob(
  queue: Queue,
  submission: SubmissionRow,
  opts: { maxAttempts?: number; correlationId?: string } = {},
): Promise<string> {
  const payload: JudgeJobPayload = {
    submission_id: submission.id,
    mode: submission.mode,
    language: submission.language,
    problem_version_id: submission.problem_version_id,
    user_id: submission.user_id,
  };
  const job = await queue.enqueue(getPool(), {
    kind: "judge",
    payload,
    idempotencyKey: `judge:${submission.id}`,
    maxAttempts: opts.maxAttempts,
    correlationId: opts.correlationId,
  });
  if (!job) {
    throw new Error(`enqueueJudgeJob: idempotency key collision for submission ${submission.id}`);
  }
  return job.id;
}

/** Deletes specific `jobs` rows by id — never a truncate, per docs/CONTRACTS.md §13 rule 3. Safe
 * to call with ids that no longer exist (e.g. already reaped into 'dead' and left alone). */
export async function deleteJobs(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await query("delete from jobs where id = any($1)", [ids]);
}

/**
 * `jobs.kind` has a database CHECK constraint (`packages/db/migrations/001_init.sql`) restricting
 * it to exactly `'judge' | 'verify' | 'generate'` — there is no way to namespace a synthetic kind
 * per test run the way `packages/queue/src/test-fixture.ts`'s own throwaway-schema tests can.
 * Pure-queue-mechanics tests (poison-job, claim-storm, reaper-idempotence) that don't need a real
 * judge handler use `'generate'` (the kind least likely to have anything else actively claiming it
 * during a test run — `apps/judge`'s own suite never enqueues it, unlike `'judge'`, which
 * `enqueueJudgeJob` and several other chaos tests use) and track every id they create explicitly,
 * cleaning up via `deleteJobs(ids)` — never a blanket delete-by-kind, since real `generate`/`verify`
 * jobs from a concurrently-run `content` (Python) or `apps/api` test suite against the same
 * `leetmind_test` database are NOT rows this suite created and must never be touched (§13 rule 3).
 */
export const CHAOS_QUEUE_KIND = "generate";

/** Fails loudly (rather than silently corrupting counts) if `kind` already has jobs sitting in it
 * before a broad claim-storm-style test starts — the guard docs/CONTRACTS.md §13 asks for:
 * an operator/CI run that finds unexpected state should get a clear failure naming the rows, not
 * a test that quietly claims and `ack()`s someone else's job. */
export async function assertNoStrayJobs(kind: string): Promise<void> {
  const rows = await query<{ id: string; status: string; created_at: Date }>(
    "select id, status, created_at from jobs where kind = $1 order by created_at asc",
    [kind],
  );
  if (rows.length > 0) {
    throw new Error(
      `assertNoStrayJobs: found ${rows.length} pre-existing job(s) of kind "${kind}" before this test even ` +
        `started (ids: ${rows.map((r) => `${r.id}(${r.status})`).join(", ")}). This test needs an empty ` +
        `queue for that kind to make its counts meaningful — either a previous test run left rows behind ` +
        `(check its afterEach cleanup), or another suite is concurrently enqueuing "${kind}" jobs against ` +
        `the same leetmind_test database. Investigate before re-running.`,
    );
  }
}

export async function deleteWorkerHeartbeats(workerIds: string[]): Promise<void> {
  if (workerIds.length === 0) return;
  await query("delete from worker_heartbeats where worker_id = any($1)", [workerIds]);
}
