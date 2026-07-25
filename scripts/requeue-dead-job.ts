#!/usr/bin/env node
// Operator CLI for poison-job parking (PLAN.md §11: no admin UI, "the terminal is the admin
// console"; docs/CONTRACTS.md §5 poison-job parking / M4 chaos suite). Lists `dead` jobs with
// enough context to debug (kind, attempts, last_error, correlation_id, age) and requeues one by
// id after resetting `attempts`.
//
// Usage (from repo root):
//   node --import tsx scripts/requeue-dead-job.ts list [--kind=judge] [--limit=50]
//   node --import tsx scripts/requeue-dead-job.ts requeue <job-id>
//   node --import tsx scripts/requeue-dead-job.ts requeue <job-id> --yes   # skip the confirmation prompt
//
// or, from within scripts/: `pnpm requeue-dead-job -- list`, etc.
//
// This is an OPERATOR tool for the real database: it reads `DATABASE_URL` (defaulting to the dev
// database, same as every service), never `TEST_DATABASE_URL`. Per docs/CONTRACTS.md §13 the test
// suites refuse to run against anything that ISN'T named like a test database; this script does
// the mirror-image check and refuses to run against anything that IS — an operator who
// accidentally points DATABASE_URL at `leetmind_test` should get a loud refusal, not a requeue
// that a test run's own truncation immediately erases (or worse, cross-contaminates a live chaos
// test run).
import { createInterface } from "node:readline/promises";
import { Pool } from "pg";
import { loadBaseConfig } from "@leetmind/shared";
import { Queue, type DeadJobInfo } from "@leetmind/queue";

const TEST_DB_NAME_PATTERN = /(^|_)test$/;

function extractDatabaseName(url: string): string | undefined {
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return undefined;
  }
}

/** Inverse of `@leetmind/db`'s `assertTestDatabase` (docs/CONTRACTS.md §13): this is an operator
 * tool for REAL data, so it refuses to run against anything that looks like a test database,
 * rather than refusing anything that doesn't. */
function assertNotTestDatabase(url: string): void {
  const dbName = extractDatabaseName(url);
  if (dbName && TEST_DB_NAME_PATTERN.test(dbName)) {
    throw new Error(
      `requeue-dead-job: refusing to run against database "${dbName}" — its name ends in "_test" ` +
        `(or is exactly "test"), which means DATABASE_URL is pointed at a test database, not a ` +
        `real one. This is an operator tool for production/dev data; it deliberately refuses to ` +
        `touch anything that looks like a test fixture. If you really mean to operate on a test ` +
        `database (e.g. debugging a chaos test), export DATABASE_URL to point at it explicitly — ` +
        `this guard cannot be bypassed by flag, only by DATABASE_URL itself.`,
    );
  }
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function printDeadJob(job: DeadJobInfo): void {
  const line = [
    `id=${job.id}`,
    `kind=${job.kind}`,
    `attempts=${job.attempts}/${job.max_attempts}`,
    `age=${formatAge(job.age_ms)}`,
    `correlation_id=${job.correlation_id ?? "-"}`,
  ].join("  ");
  console.log(line);
  console.log(`  last_error: ${job.last_error ?? "(none recorded)"}`);
  console.log(`  payload: ${JSON.stringify(job.payload)}`);
}

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=", 2);
      flags[key!] = value ?? true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function cmdList(queue: Queue, flags: Record<string, string | boolean>): Promise<void> {
  const kind = typeof flags.kind === "string" ? flags.kind : undefined;
  const limit = typeof flags.limit === "string" ? Number(flags.limit) : 50;
  const jobs = await queue.listDeadJobs({ kind, limit });
  if (jobs.length === 0) {
    console.log(kind ? `No dead jobs of kind "${kind}".` : "No dead jobs.");
    return;
  }
  console.log(`${jobs.length} dead job(s)${kind ? ` of kind "${kind}"` : ""}:\n`);
  for (const job of jobs) {
    printDeadJob(job);
    console.log("");
  }
}

async function cmdRequeue(queue: Queue, positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const jobId = positional[0];
  if (!jobId) {
    throw new Error("requeue: missing <job-id>. Usage: requeue-dead-job.ts requeue <job-id> [--yes]");
  }

  const existing = await queue.getJob(jobId);
  if (!existing) {
    throw new Error(`requeue: no job with id ${jobId}`);
  }
  if (existing.status !== "dead") {
    throw new Error(
      `requeue: job ${jobId} is currently "${existing.status}", not "dead" — refusing (this tool ` +
        `only ever resurrects poison jobs, never touches one a worker might legitimately hold).`,
    );
  }

  console.log("About to requeue:");
  printDeadJob({ ...existing, age_ms: 0 });

  if (flags.yes !== true) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("\nRequeue this job (resets attempts to 0)? [y/N] ");
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.log("Aborted.");
      return;
    }
  }

  const requeued = await queue.requeueDeadJob(jobId);
  if (!requeued) {
    throw new Error(`requeue: job ${jobId} was no longer "dead" by the time we tried to requeue it.`);
  }
  console.log(`Requeued ${jobId}: status=${requeued.status} attempts=${requeued.attempts}`);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const { positional, flags } = parseFlags(rest);

  const config = loadBaseConfig();
  assertNotTestDatabase(config.databaseUrl);

  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  const queue = new Queue(pool, { workerId: "requeue-dead-job-cli" });

  try {
    switch (command) {
      case "list":
        await cmdList(queue, flags);
        break;
      case "requeue":
        await cmdRequeue(queue, positional, flags);
        break;
      default:
        console.error(
          "Usage:\n" +
            "  requeue-dead-job.ts list [--kind=<kind>] [--limit=<n>]\n" +
            "  requeue-dead-job.ts requeue <job-id> [--yes]",
        );
        process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
