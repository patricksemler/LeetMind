// The documented load profile (PLAN.md §10 M5 "load-test harness with documented profile
// (concurrent sessions, submission mix, language mix) producing p50/p95/p99 queue + judge
// latency, throughput, and lease-recovery time"). Every number here is printed in the harness's
// output AND written verbatim into docs/measurements.md, so a reader can see exactly what was
// measured without reading this file — but this file is the single source of truth for it.
//
// Override any field with an env var (see the `envOverrides` block at the bottom) so a re-run
// with a different shape doesn't require editing source.

export interface LoadProfile {
  /** Number of concurrent "virtual users" each looping submissions with think-time between them. */
  concurrentSessions: number;
  /** Submissions each session makes before stopping. Total submissions = concurrentSessions * this. */
  submissionsPerSession: number;
  /** Randomized delay between one submission's terminal verdict and a session's next submission,
   * simulating a human reading the verdict / editing code — compressed from a real minutes-scale
   * gap to keep the harness runtime reasonable. Documented as a compression, not hidden. */
  thinkTimeMsRange: [number, number];
  /** Fraction of submissions per language. Must sum to 1. */
  languageMix: { python: number; cpp: number };
  /** Fraction of submissions per intended outcome. Must sum to 1. `timeout` and `compile_error`
   * are deliberately rare — they're the two verdicts whose wall-clock cost is highest (a timeout
   * always burns the full sandbox wall-timeout budget), and the point of a submission mix is
   * realism, not maximizing worst-case latency. */
  outcomeMix: { accepted: number; wrong_answer: number; timeout: number; compile_error: number };
  /** Number of separate judge coordinator OS processes spawned by the harness (not threads within
   * one process) — needed so the lease-recovery-under-load scenario can SIGKILL exactly one of
   * them while the other(s) keep serving traffic, the same "real SIGKILL of a real subprocess"
   * requirement apps/judge/test/chaos/workerKill.test.ts documents for the idle case. */
  judgeWorkerProcesses: number;
  /** JUDGE_CONCURRENCY per spawned judge process. Total concurrent judge slots = this *
   * judgeWorkerProcesses. */
  judgeConcurrencyPerWorker: number;
  /** SANDBOX_WALL_TIMEOUT_MS for the harness's own spawned judge processes. Shortened from the
   * production default (10000ms, docs/CONTRACTS.md §2) specifically so the `timeout` slice of the
   * submission mix doesn't dominate total harness wall-clock — with outcomeMix.timeout small but
   * nonzero, each timeout submission still costs exactly this many ms of sandbox wall time.
   * Documented deviation, not silently different from production. */
  sandboxWallTimeoutMs: number;
  /** Lease/reaper/heartbeat timings for the lease-recovery-under-load scenario. Deliberately the
   * PRODUCTION defaults (docs/CONTRACTS.md §2), NOT apps/judge/test/chaos/workerKill.test.ts's
   * compressed ones — the whole point of measuring recovery "under load" is an honest number
   * comparable to what a real deployment would see, not a best-case number tuned to be fast. */
  queueLeaseSeconds: number;
  queueReaperIntervalMs: number;
  queueHeartbeatMs: number;
  /** How long (ms) the lease-recovery victim submission sleeps inside the sandbox — must be long
   * enough that the harness reliably observes status='running' before it SIGKILLs the worker, and
   * short enough to finish comfortably inside sandboxWallTimeoutMs once re-executed by a survivor. */
  leaseRecoveryVictimSleepMs: number;
}

const DEFAULT_PROFILE: LoadProfile = {
  concurrentSessions: 6,
  submissionsPerSession: 20,
  thinkTimeMsRange: [200, 800],
  languageMix: { python: 0.7, cpp: 0.3 },
  outcomeMix: { accepted: 0.65, wrong_answer: 0.2, timeout: 0.05, compile_error: 0.1 },
  judgeWorkerProcesses: 2,
  judgeConcurrencyPerWorker: 3,
  sandboxWallTimeoutMs: 4000,
  queueLeaseSeconds: 30,
  queueReaperIntervalMs: 5000,
  queueHeartbeatMs: 10000,
  leaseRecoveryVictimSleepMs: 3000,
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`loadtest config: ${name}="${raw}" is not a valid integer`);
  return n;
}

export function loadProfile(): LoadProfile {
  return {
    ...DEFAULT_PROFILE,
    concurrentSessions: envInt("LOADTEST_CONCURRENT_SESSIONS", DEFAULT_PROFILE.concurrentSessions),
    submissionsPerSession: envInt("LOADTEST_SUBMISSIONS_PER_SESSION", DEFAULT_PROFILE.submissionsPerSession),
    judgeWorkerProcesses: envInt("LOADTEST_JUDGE_WORKERS", DEFAULT_PROFILE.judgeWorkerProcesses),
    judgeConcurrencyPerWorker: envInt("LOADTEST_JUDGE_CONCURRENCY", DEFAULT_PROFILE.judgeConcurrencyPerWorker),
    sandboxWallTimeoutMs: envInt("LOADTEST_SANDBOX_WALL_TIMEOUT_MS", DEFAULT_PROFILE.sandboxWallTimeoutMs),
  };
}

export function totalSubmissions(profile: LoadProfile): number {
  return profile.concurrentSessions * profile.submissionsPerSession;
}
