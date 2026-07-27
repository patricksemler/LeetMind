import type { PoolClient } from "pg";
import { queryOneWith } from "./pool.js";
import type { ModelRunKind, ModelRunRow, ModelRunStatus } from "./types.js";

export interface NewModelRunInput {
  id: string;
  kind: ModelRunKind;
  invoker: string;
  model?: string | null;
  prompt_version: string;
  request: Record<string, unknown>;
  duration_ms?: number | null;
  output_hash?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  problem_version_id?: string | null;
  status: ModelRunStatus;
  error?: string | null;
  correlation_id?: string | null;
}

/** Records one generator/repair invocation — written for every attempt, including failures (CONTRACTS.md §11). */
export async function insertModelRun(
  client: PoolClient,
  row: NewModelRunInput,
): Promise<ModelRunRow> {
  const sql = `
    insert into model_runs (
      id, kind, invoker, model, prompt_version, request, duration_ms, output_hash,
      input_tokens, output_tokens, cost_usd, problem_version_id, status, error, correlation_id
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
    )
    returning *
  `;
  const inserted = await queryOneWith<ModelRunRow>(client, sql, [
    row.id,
    row.kind,
    row.invoker,
    row.model ?? null,
    row.prompt_version,
    JSON.stringify(row.request),
    row.duration_ms ?? null,
    row.output_hash ?? null,
    row.input_tokens ?? null,
    row.output_tokens ?? null,
    row.cost_usd ?? null,
    row.problem_version_id ?? null,
    row.status,
    row.error ?? null,
    row.correlation_id ?? null,
  ]);
  if (!inserted) {
    throw new Error(`insertModelRun: insert of ${row.id} returned no row`);
  }
  return inserted;
}
