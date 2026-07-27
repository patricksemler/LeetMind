#!/usr/bin/env node
// One-command M5 load-test harness (PLAN.md §10 M5, docs/CONTRACTS.md §13).
//
// Spins up real api + judge processes against a DEDICATED test database, seeds one approved
// problem, drives concurrent virtual-user load against the real HTTP + SSE API (which enqueues
// real jobs, judged by real judge workers, executed in real sandbox containers), measures a
// lease-recovery-under-load scenario, computes p50/p95/p99 latency + throughput from Postgres,
// writes docs/measurements.md, cleans up every row it created, and exits.
//
// Usage: pnpm --filter @leetmind/scripts loadtest
import { closePool, query } from "@leetmind/db";
import { assertTestDatabase, testDatabaseUrl } from "@leetmind/db";
import { newId } from "@leetmind/shared";
import { execSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfile, totalSubmissions } from "./config.js";
import { captureEnvInfo } from "./env.js";
import { runLeaseRecoveryUnderLoad } from "./leaseRecovery.js";
import { REPO_ROOT, spawnApi, spawnJudgeWorker, type ManagedProcess } from "./processes.js";
import { runLoad } from "./runner.js";
import { cleanupLoadtestProblem, seedLoadtestProblem } from "./seed.js";
import { buildRunReport, loadSubmissionRecords, printLatencyTable } from "./stats.js";
import { renderMeasurementsMd } from "./writeReport.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEASUREMENTS_PATH = path.resolve(REPO_ROOT, "docs/measurements.md");

const API_PORT = Number(process.env.LOADTEST_API_PORT ?? 8099);
const API_BASE = `http://127.0.0.1:${API_PORT}`;

function assertDockerAndImages(): void {
  execSync("docker info", { stdio: "ignore" });
  for (const image of ["leetmind/runner-python:1", "leetmind/runner-cpp:1"]) {
    try {
      execSync(`docker image inspect ${image}`, { stdio: "ignore" });
    } catch {
      throw new Error(
        `loadtest: required sandbox image "${image}" is not built locally. Run scripts/build-images.sh first.`,
      );
    }
  }
}

async function main(): Promise<void> {
  const runId = newId();
  const databaseUrl = testDatabaseUrl();
  assertTestDatabase(databaseUrl); // docs/CONTRACTS.md §13 — refuse to run against anything else
  process.env.DATABASE_URL = databaseUrl; // so THIS process's own @leetmind/db calls (seed/cleanup/stats) target it too

  console.log(`LeetMind M5 load test — run ${runId}`);
  console.log(`Target database: ${databaseUrl}`);

  assertDockerAndImages();

  const profile = loadProfile();
  console.log(`Profile: ${JSON.stringify(profile, null, 2)}`);
  console.log(`Total submissions to generate: ${totalSubmissions(profile)}`);

  const env = captureEnvInfo();

  const processes: ManagedProcess[] = [];
  const workerIds: string[] = [];
  let seeded: Awaited<ReturnType<typeof seedLoadtestProblem>> | undefined;
  let cleanedUp = false;

  try {
    seeded = await seedLoadtestProblem(runId);
    console.log(`Seeded load-test problem: problem_version_id=${seeded.versionId}`);

    const api = spawnApi({ databaseUrl, port: API_PORT });
    processes.push(api);
    await api.ready;
    console.log(`api ready on ${API_BASE}`);

    const judgeWorkers: ManagedProcess[] = [];
    for (let i = 0; i < profile.judgeWorkerProcesses; i++) {
      const workerId = `loadtest-judge-${i}-${runId}`;
      const worker = spawnJudgeWorker({ databaseUrl, workerId, profile });
      judgeWorkers.push(worker);
      processes.push(worker);
      workerIds.push(workerId);
    }
    await Promise.all(judgeWorkers.map((w) => w.ready));
    console.log(
      `${judgeWorkers.length} judge worker process(es) ready: ${judgeWorkers.map((w) => w.workerId).join(", ")}`,
    );

    // Health check before generating any load.
    const health = await fetch(`${API_BASE}/health`).then(
      (r) => r.json() as Promise<{ ok: boolean; db: string }>,
    );
    if (!health.ok || health.db !== "up") {
      throw new Error(`loadtest: api health check failed: ${JSON.stringify(health)}`);
    }

    console.log("\nStarting load generation + lease-recovery-under-load scenario...");
    const loadPromise = runLoad({ apiBase: API_BASE, problemVersionId: seeded.versionId, profile });
    // Let real concurrent traffic build up for a few seconds before targeting a worker to kill,
    // so the recovery measurement genuinely happens "under load" rather than at t=0.
    const leaseRecoveryPromise = (async () => {
      await new Promise((r) => setTimeout(r, 3000));
      return runLeaseRecoveryUnderLoad({
        apiBase: API_BASE,
        problemVersionId: seeded.versionId,
        profile,
        workers: judgeWorkers,
      });
    })();

    const [loadResult, leaseRecovery] = await Promise.all([loadPromise, leaseRecoveryPromise]);
    console.log(
      `\nLease recovery: killed ${leaseRecovery.killedWorkerId}, ` +
        `recovery=${leaseRecovery.recoveryMs === null ? "DID NOT RECOVER" : `${leaseRecovery.recoveryMs}ms`}, ` +
        `verdict=${leaseRecovery.verdict}`,
    );

    // Capture a live /metrics sample before tearing anything down.
    const metricsSample = await fetch(`${API_BASE}/metrics`).then((r) => r.text());

    // Exclude the deliberately-killed lease-recovery victim from the general latency stats — its
    // recovery wait is reported separately in §4 of the report, and folding it into the "normal"
    // percentiles would conflate two different things this harness is honestly trying to measure.
    const records = await loadSubmissionRecords(seeded.versionId, {
      excludeIds: [leaseRecovery.submissionId],
    });

    // docs/CONTRACTS.md §13 documents a known hazard: OTHER agents' test suites running
    // concurrently against this same shared `leetmind_test` database can (pre-M4-fix) truncate
    // shared tables mid-run. That is a data-loss event for THIS run's measurements, not a
    // legitimate "honest zero" — fail loudly rather than silently writing a bogus all-zero report
    // (the same "fail loudly, never silently continue" principle CONTRACTS §13 itself mandates for
    // the test-database guard).
    const expected = totalSubmissions(profile);
    if (records.length < expected * 0.9) {
      throw new Error(
        `loadtest: expected ~${expected} submissions for problem_version_id=${seeded.versionId} but only found ` +
          `${records.length} in the database after the run completed. This almost certainly means a CONCURRENT ` +
          `process truncated/deleted shared tables in leetmind_test while this load test was running (a known ` +
          `hazard documented in docs/CONTRACTS.md §13 — check for other agents' \`pnpm test\` / \`pytest\` runs ` +
          `against the same database). Re-run the load test once no other suite is running against leetmind_test.`,
      );
    }

    const report = buildRunReport({ profile, records, wallClockMs: loadResult.wallClockMs });

    printLatencyTable("End-to-end submission latency (created -> completed)", [
      { label: "all", summary: report.e2eOverall },
      { label: "python", summary: report.e2eByLanguage.python },
      { label: "cpp", summary: report.e2eByLanguage.cpp },
    ]);
    printLatencyTable("Queue wait time (enqueued -> claimed)", [
      { label: "all", summary: report.queueWaitOverall },
    ]);
    printLatencyTable("Judge execution time (sandbox run)", [
      { label: "all", summary: report.judgeExecOverall },
      { label: "python", summary: report.judgeExecByLanguage.python },
      { label: "cpp", summary: report.judgeExecByLanguage.cpp },
    ]);
    console.log(`\nThroughput: ${report.throughputPerMin.toFixed(1)} submissions/min`);
    console.log(`Verdict/status counts: ${JSON.stringify(report.verdictCounts, null, 2)}`);
    console.log(`Incomplete: ${report.incomplete.length}`);

    const md = renderMeasurementsMd({
      runId,
      ranAt: new Date(),
      env,
      report,
      leaseRecovery,
      metricsSample,
    });
    await writeFile(MEASUREMENTS_PATH, md, "utf8");
    console.log(`\nWrote ${MEASUREMENTS_PATH}`);

    // Stop processes before cleanup — no point holding a judge worker alive against a database
    // whose rows are about to disappear out from under it.
    await Promise.all(processes.map((p) => p.stop()));

    const { deletedSubmissions } = await cleanupLoadtestProblem(seeded);
    await query("delete from jobs where payload->>'problem_version_id' = $1", [seeded.versionId]);
    await query("delete from worker_heartbeats where worker_id = any($1)", [workerIds]);
    cleanedUp = true;
    console.log(
      `Cleaned up: ${deletedSubmissions} submission(s), the seeded problem, jobs, and worker heartbeats.`,
    );
  } finally {
    await Promise.all(processes.map((p) => p.stop().catch(() => {})));
    // Best-effort cleanup even on a thrown error (e.g. the concurrent-truncation guard above) —
    // whatever of our own rows survived should still not be left behind (docs/CONTRACTS.md §13
    // rule 3: clean up your own rows). Never a truncate; only ever these narrowly-scoped deletes.
    if (!cleanedUp && seeded) {
      await cleanupLoadtestProblem(seeded).catch(() => {});
      await query("delete from jobs where payload->>'problem_version_id' = $1", [
        seeded.versionId,
      ]).catch(() => {});
      if (workerIds.length > 0) {
        await query("delete from worker_heartbeats where worker_id = any($1)", [workerIds]).catch(
          () => {},
        );
      }
    }
    await closePool();
  }
}

main().catch((err: unknown) => {
  console.error("\nloadtest failed:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
