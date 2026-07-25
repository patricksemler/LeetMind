#!/usr/bin/env node
// Standalone judge-worker bootstrap for the chaos suite (apps/judge/test/chaos/*.test.ts).
//
// This deliberately does NOT touch apps/judge/src/index.ts (out of scope per this task's file
// boundary — that file is owned by another agent working the C++ pipeline). It is a second,
// test-only entrypoint that wires the SAME real handler (`createJudgeHandler`) and the SAME real
// `runWorker`/`startReaper` from `@leetmind/queue`, just with every timing knob overridable by env
// var so the "worker killed mid-judge" chaos test can force a lease-recovery window well under the
// default 30s lease without touching production config. It is spawned as a REAL, SEPARATE OS
// process (`node --import tsx`, mirroring the CONTRACTS.md §6.1 CLI-bridge invocation style) so
// the chaos suite can SIGKILL it for real, rather than merely aborting an in-process signal.
//
// Env vars (all optional except CHAOS_WORKER_ID):
//   DATABASE_URL              required — MUST already point at a test database; asserted below.
//   CHAOS_WORKER_ID           worker id used for jobs.leased_by / worker_heartbeats.worker_id
//   CHAOS_KINDS               comma-separated job kinds to claim (default "judge")
//   CHAOS_CONCURRENCY         default 1
//   CHAOS_LEASE_SECONDS       default 30 (Queue's own default)
//   CHAOS_REAPER_INTERVAL_MS  default 5000 (queue package's own default)
//   CHAOS_POLL_INTERVAL_MS    default 500 (queue package's own default)
//   CHAOS_HEARTBEAT_MS        default 10000 (queue package's own default)
//
// Prints "CHAOS_WORKER_READY <workerId>" to stdout once the worker loop starts (best-effort
// liveness signal for debugging only — the test suite itself synchronizes via the database, never
// by parsing this process's stdout, since a killed process's buffered stdout is not reliable).
import { assertTestDatabase, getPool } from "@leetmind/db";
import { Queue, runWorker, startReaper, installShutdownHandlers, type Logger as QueueLogger } from "@leetmind/queue";
import { createLogger, loadJudgeConfig, loadSandboxConfig } from "@leetmind/shared";
import { createJudgeHandler } from "../../src/handler.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("chaos worker-process: DATABASE_URL is not set");
  process.exit(1);
}
// Defence in depth (docs/CONTRACTS.md §13 rule 2): even though the parent test process already
// redirects DATABASE_URL to TEST_DATABASE_URL before spawning us, this is a separate OS process
// that could in principle be invoked with a different environment, and it claims/executes/writes
// real submission state — assert again here before touching anything.
assertTestDatabase(url);

const rawWorkerId = process.env.CHAOS_WORKER_ID;
if (!rawWorkerId) {
  console.error("chaos worker-process: CHAOS_WORKER_ID is not set");
  process.exit(1);
}
// Re-bound to a fresh `const` right after the guard so its type is plain `string`, not
// `string | undefined`, in the closures below (TS does not carry control-flow narrowing of an
// outer-scope `const` into nested function bodies defined later in the file).
const workerId: string = rawWorkerId;

const kinds = (process.env.CHAOS_KINDS ?? "judge").split(",").map((s) => s.trim());
const concurrency = Number(process.env.CHAOS_CONCURRENCY ?? "1");
const leaseSeconds = process.env.CHAOS_LEASE_SECONDS ? Number(process.env.CHAOS_LEASE_SECONDS) : undefined;
const reaperIntervalMs = process.env.CHAOS_REAPER_INTERVAL_MS ? Number(process.env.CHAOS_REAPER_INTERVAL_MS) : undefined;
const pollIntervalMs = process.env.CHAOS_POLL_INTERVAL_MS ? Number(process.env.CHAOS_POLL_INTERVAL_MS) : undefined;
const heartbeatMs = process.env.CHAOS_HEARTBEAT_MS ? Number(process.env.CHAOS_HEARTBEAT_MS) : undefined;

async function main(): Promise<void> {
  const config = loadJudgeConfig({ ...process.env, JUDGE_WORKER_ID: workerId });
  const sandbox = loadSandboxConfig(process.env);
  const pool = getPool();
  const logger = createLogger(`chaos-worker-${workerId}`);
  const queueLogger = logger as unknown as QueueLogger;
  const queue = new Queue(pool, { leaseSeconds, workerId, logger: queueLogger });

  const controller = new AbortController();
  installShutdownHandlers(controller);

  const reaper = startReaper({ queue, intervalMs: reaperIntervalMs, signal: controller.signal, logger: queueLogger });

  await queue.upsertWorkerHeartbeat(workerId, kinds.join(","), { concurrency, chaos: true });

  const handler = createJudgeHandler({ config, sandbox, pool, queue, logger });

  console.log(`CHAOS_WORKER_READY ${workerId}`);

  await runWorker({
    queue,
    kinds,
    concurrency,
    handler,
    logger: queueLogger,
    workerId,
    signal: controller.signal,
    pollIntervalMs,
    heartbeatMs,
  });

  reaper.stop();
  await getPool()
    .end()
    .catch(() => {});
}

main().catch((err: unknown) => {
  console.error("chaos worker-process failed:", err);
  process.exit(1);
});
