// Post-run measurement: pulls every submission this run created straight from Postgres
// (server-authoritative timestamps, not client-observed ones — see client.ts's doc comment for
// why) and computes p50/p95/p99 for end-to-end latency, queue wait, and judge execution time,
// plus throughput and verdict/error counts. Prints a clean summary table.
import { query } from "@algolift/db";
import type { LoadProfile } from "./config.js";

export interface SubmissionRecord {
  id: string;
  language: "python" | "cpp";
  verdict: string | null;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
  runtimeMs: number | null;
  jobCreatedAt: Date | null;
  leaseExpiresAt: Date | null;
  attempts: number | null;
}

export async function loadSubmissionRecords(
  problemVersionId: string,
  opts: { excludeIds?: string[] } = {},
): Promise<SubmissionRecord[]> {
  const excludeIds = opts.excludeIds ?? [];
  const rows = await query<{
    id: string;
    language: "python" | "cpp";
    verdict: string | null;
    status: string;
    created_at: Date;
    completed_at: Date | null;
    runtime_ms: number | null;
    job_created_at: Date | null;
    lease_expires_at: Date | null;
    attempts: number | null;
  }>(
    `select s.id, s.language, s.verdict, s.status, s.created_at, s.completed_at, s.runtime_ms,
            j.created_at as job_created_at, j.lease_expires_at, j.attempts
       from submissions s
       left join jobs j on j.idempotency_key = 'judge:' || s.id
      where s.problem_version_id = $1 and not (s.id = any($2))
      order by s.created_at asc`,
    [problemVersionId, excludeIds],
  );
  return rows.map((r) => ({
    id: r.id,
    language: r.language,
    verdict: r.verdict,
    status: r.status,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    runtimeMs: r.runtime_ms,
    jobCreatedAt: r.job_created_at,
    leaseExpiresAt: r.lease_expires_at,
    attempts: r.attempts,
  }));
}

/** Linear-interpolation percentile (same family of estimator as Postgres's
 * `percentile_cont`, which @algolift/queue's own `Queue.stats()` uses — kept consistent rather
 * than picking a different estimator for this harness). */
export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = rank - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

export interface LatencySummary {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  min: number | null;
  max: number | null;
  meanMs: number | null;
}

export function summarize(valuesMs: number[]): LatencySummary {
  const sorted = [...valuesMs].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted.length ? sorted[0]! : null,
    max: sorted.length ? sorted[sorted.length - 1]! : null,
    meanMs: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
  };
}

/** `claim_time ~= lease_expires_at - leaseSeconds` — EXACTLY the approximation
 * `packages/queue/src/queue.ts`'s `Queue.stats()` doc comment documents and uses for its own
 * `wait_time_ms` p50/p95 (and the metrics.ts /metrics endpoint, and /api/system/stats). Reusing
 * it here rather than inventing a different measurement keeps this harness's numbers directly
 * comparable to what the running system's own dashboards report. Same caveat applies: drifts for
 * jobs whose lease was extended by a heartbeat before this read. */
export function queueWaitMs(record: SubmissionRecord, leaseSeconds: number): number | null {
  if (!record.jobCreatedAt || !record.leaseExpiresAt) return null;
  const approxClaimedAt = record.leaseExpiresAt.getTime() - leaseSeconds * 1000;
  const waitMs = approxClaimedAt - record.jobCreatedAt.getTime();
  return waitMs >= 0 ? waitMs : null; // negative would indicate a heartbeat-extended lease, not a real wait
}

export function e2eLatencyMs(record: SubmissionRecord): number | null {
  if (!record.completedAt) return null;
  return record.completedAt.getTime() - record.createdAt.getTime();
}

function fmtMs(v: number | null): string {
  if (v === null) return "—";
  if (v < 1000) return `${Math.round(v)}ms`;
  return `${(v / 1000).toFixed(2)}s`;
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padLeft(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

export function printLatencyTable(title: string, rows: { label: string; summary: LatencySummary }[]): string {
  const lines: string[] = [];
  lines.push(`\n${title}`);
  lines.push("-".repeat(title.length));
  const header = ["", "n", "p50", "p95", "p99", "min", "max", "mean"];
  const colWidths = [18, 6, 9, 9, 9, 9, 9, 9];
  lines.push(header.map((h, i) => padRight(h, colWidths[i]!)).join(" "));
  for (const { label, summary } of rows) {
    const cells = [
      padRight(label, colWidths[0]!),
      padLeft(String(summary.count), colWidths[1]!),
      padLeft(fmtMs(summary.p50), colWidths[2]!),
      padLeft(fmtMs(summary.p95), colWidths[3]!),
      padLeft(fmtMs(summary.p99), colWidths[4]!),
      padLeft(fmtMs(summary.min), colWidths[5]!),
      padLeft(fmtMs(summary.max), colWidths[6]!),
      padLeft(fmtMs(summary.meanMs), colWidths[7]!),
    ];
    lines.push(cells.join(" "));
  }
  const out = lines.join("\n");
  console.log(out);
  return out;
}

export interface RunReport {
  profile: LoadProfile;
  totalSubmissions: number;
  completed: SubmissionRecord[];
  incomplete: SubmissionRecord[];
  wallClockMs: number;
  e2eOverall: LatencySummary;
  e2eByLanguage: Record<"python" | "cpp", LatencySummary>;
  queueWaitOverall: LatencySummary;
  judgeExecOverall: LatencySummary;
  judgeExecByLanguage: Record<"python" | "cpp", LatencySummary>;
  verdictCounts: Record<string, number>;
  throughputPerMin: number;
}

export function buildRunReport(opts: {
  profile: LoadProfile;
  records: SubmissionRecord[];
  wallClockMs: number;
}): RunReport {
  const { profile, records, wallClockMs } = opts;
  const completed = records.filter((r) => r.status === "completed" && r.completedAt !== null);
  const incomplete = records.filter((r) => !(r.status === "completed" && r.completedAt !== null));

  const e2eAll = completed.map(e2eLatencyMs).filter((v): v is number => v !== null);
  const e2ePy = completed.filter((r) => r.language === "python").map(e2eLatencyMs).filter((v): v is number => v !== null);
  const e2eCpp = completed.filter((r) => r.language === "cpp").map(e2eLatencyMs).filter((v): v is number => v !== null);

  const waitAll = completed
    .map((r) => queueWaitMs(r, profile.queueLeaseSeconds))
    .filter((v): v is number => v !== null);

  const execAll = completed.map((r) => r.runtimeMs).filter((v): v is number => v !== null);
  const execPy = completed
    .filter((r) => r.language === "python")
    .map((r) => r.runtimeMs)
    .filter((v): v is number => v !== null);
  const execCpp = completed
    .filter((r) => r.language === "cpp")
    .map((r) => r.runtimeMs)
    .filter((v): v is number => v !== null);

  const verdictCounts: Record<string, number> = {};
  for (const r of completed) {
    const key = r.verdict ?? "(null)";
    verdictCounts[key] = (verdictCounts[key] ?? 0) + 1;
  }
  for (const r of incomplete) {
    verdictCounts[`incomplete:${r.status}`] = (verdictCounts[`incomplete:${r.status}`] ?? 0) + 1;
  }

  return {
    profile,
    totalSubmissions: records.length,
    completed,
    incomplete,
    wallClockMs,
    e2eOverall: summarize(e2eAll),
    e2eByLanguage: { python: summarize(e2ePy), cpp: summarize(e2eCpp) },
    queueWaitOverall: summarize(waitAll),
    judgeExecOverall: summarize(execAll),
    judgeExecByLanguage: { python: summarize(execPy), cpp: summarize(execCpp) },
    verdictCounts,
    throughputPerMin: completed.length / (wallClockMs / 60_000),
  };
}
