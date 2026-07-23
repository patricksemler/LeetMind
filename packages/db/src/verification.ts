import type { PoolClient } from "pg";
import { queryOneWith } from "./pool.js";
import type { VerificationReportRow } from "./types.js";

export interface NewVerificationReportInput {
  id: string;
  problem_version_id: string;
  passed: boolean;
  failed_stage?: string | null;
  stages: unknown[];
  seeds?: unknown[];
  counterexample?: Record<string, unknown> | null;
  solution_hashes?: Record<string, string>;
  duration_ms?: number | null;
  correlation_id?: string | null;
}

/** Inserts a verification_reports row — the six-stage gate writes exactly one of these per run. */
export async function insertVerificationReport(
  client: PoolClient,
  row: NewVerificationReportInput,
): Promise<VerificationReportRow> {
  const sql = `
    insert into verification_reports (
      id, problem_version_id, passed, failed_stage, stages, seeds, counterexample,
      solution_hashes, duration_ms, correlation_id
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
    )
    returning *
  `;
  const inserted = await queryOneWith<VerificationReportRow>(client, sql, [
    row.id,
    row.problem_version_id,
    row.passed,
    row.failed_stage ?? null,
    JSON.stringify(row.stages),
    JSON.stringify(row.seeds ?? []),
    row.counterexample ? JSON.stringify(row.counterexample) : null,
    JSON.stringify(row.solution_hashes ?? {}),
    row.duration_ms ?? null,
    row.correlation_id ?? null,
  ]);
  if (!inserted) {
    throw new Error(`insertVerificationReport: insert of ${row.id} returned no row`);
  }
  return inserted;
}
