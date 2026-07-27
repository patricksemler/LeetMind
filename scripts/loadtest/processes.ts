// Spawns/stops real api + judge OS processes (via `tsx`, the same invocation style
// docs/CONTRACTS.md §6.1 documents for the sandbox CLI bridge and
// apps/judge/test/chaos/chaos-helpers.ts uses for its worker-process spawner) — the load test
// drives the REAL system end to end, not a simulation. Every spawned process gets DATABASE_URL
// pointed explicitly at the harness's dedicated test database, regardless of whatever the calling
// shell's environment has set, so there is no way for this harness to accidentally touch the dev
// database (docs/CONTRACTS.md §13).
import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadProfile } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../..");

export interface ManagedProcess {
  name: string;
  workerId?: string;
  proc: ChildProcessByStdio<null, Readable, Readable>;
  stdout: string;
  stderr: string;
  ready: Promise<void>;
  kill(): Promise<void>;
  stop(): Promise<void>;
}

function tail(s: string, n = 4000): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
}

/**
 * Readiness is polled externally (HTTP health check for api, a `worker_heartbeats` row for
 * judge — see spawnApi/spawnJudgeWorker below), NOT detected by matching a log line: structured
 * JSON logs are gated by `LOG_LEVEL` (docs/CONTRACTS.md §1), and this harness runs its spawned
 * processes with whatever level the operator wants (quiet by default) without that choice
 * silently breaking readiness detection.
 */
function spawnTsxProcess(opts: {
  name: string;
  entry: string;
  env: NodeJS.ProcessEnv;
  pollReady: () => Promise<boolean>;
  workerId?: string;
  timeoutMs?: number;
}): ManagedProcess {
  const proc = spawn("node", ["--import", "tsx", opts.entry], {
    cwd: REPO_ROOT,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const handle: ManagedProcess = {
    name: opts.name,
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
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    },
  };

  proc.stdout.on("data", (d: Buffer) => {
    handle.stdout += d.toString("utf8");
  });
  proc.stderr.on("data", (d: Buffer) => {
    handle.stderr += d.toString("utf8");
  });

  const timeoutMs = opts.timeoutMs ?? 30_000;
  handle.ready = (async () => {
    const start = Date.now();
    let exited = false;
    proc.once("exit", () => {
      exited = true;
    });
    while (Date.now() - start < timeoutMs) {
      if (exited) {
        throw new Error(
          `${opts.name}: process exited (code=${proc.exitCode}, signal=${proc.signalCode}) before becoming ready.\n` +
            `stdout:\n${tail(handle.stdout)}\nstderr:\n${tail(handle.stderr)}`,
        );
      }
      if (await opts.pollReady().catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(
      `${opts.name}: did not become ready within ${timeoutMs}ms.\nstdout:\n${tail(handle.stdout)}\nstderr:\n${tail(handle.stderr)}`,
    );
  })();

  return handle;
}

export function spawnApi(opts: { databaseUrl: string; port: number }): ManagedProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: opts.databaseUrl,
    API_PORT: String(opts.port),
    LOG_LEVEL: process.env.LOADTEST_LOG_LEVEL ?? "info",
  };
  return spawnTsxProcess({
    name: "api",
    entry: "apps/api/src/index.ts",
    env,
    pollReady: async () => {
      const res = await fetch(`http://127.0.0.1:${opts.port}/health`);
      if (!res.ok) return false;
      const body = (await res.json()) as { ok?: boolean; db?: string };
      return body.ok === true && body.db === "up";
    },
  });
}

export function spawnJudgeWorker(opts: {
  databaseUrl: string;
  workerId: string;
  profile: LoadProfile;
}): ManagedProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: opts.databaseUrl,
    JUDGE_WORKER_ID: opts.workerId,
    JUDGE_CONCURRENCY: String(opts.profile.judgeConcurrencyPerWorker),
    QUEUE_LEASE_SECONDS: String(opts.profile.queueLeaseSeconds),
    QUEUE_REAPER_INTERVAL_MS: String(opts.profile.queueReaperIntervalMs),
    QUEUE_HEARTBEAT_MS: String(opts.profile.queueHeartbeatMs),
    QUEUE_POLL_INTERVAL_MS: process.env.LOADTEST_QUEUE_POLL_INTERVAL_MS ?? "300",
    SANDBOX_WALL_TIMEOUT_MS: String(opts.profile.sandboxWallTimeoutMs),
    LOG_LEVEL: process.env.LOADTEST_LOG_LEVEL ?? "info",
  };
  return spawnTsxProcess({
    name: `judge:${opts.workerId}`,
    entry: "apps/judge/src/index.ts",
    env,
    // ensureImage() (packages/sandbox) can take a moment on a cold `docker image inspect`, and
    // judge only upserts its heartbeat AFTER that check succeeds (apps/judge/src/index.ts) — a
    // generous timeout here avoids a flaky false "not ready" on a loaded machine.
    timeoutMs: 45_000,
    pollReady: async () => {
      const { query } = await import("@leetmind/db");
      const rows = await query<{ worker_id: string }>(
        "select worker_id from worker_heartbeats where worker_id = $1",
        [opts.workerId],
      );
      return rows.length > 0;
    },
    workerId: opts.workerId,
  });
}
