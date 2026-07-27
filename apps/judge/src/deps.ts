// Small container wiring pool/queue/logger/config so the entrypoint and every test share one
// construction path (mirrors apps/api/src/deps.ts's pattern).
//
// `pino` is deliberately NOT a direct dependency of this package (CONTRACTS.md's judge brief
// lists only `pg` + the workspace packages) — the logger type is inferred from
// `createLogger`'s return type rather than imported from `pino` directly.
import type { Pool } from "pg";
import { getPool } from "@leetmind/db";
import { Queue, type Logger as QueueLogger } from "@leetmind/queue";
import {
  createLogger,
  loadJudgeConfig,
  loadSandboxConfig,
  type JudgeConfig,
  type SandboxConfig,
} from "@leetmind/shared";

export type JudgeLogger = ReturnType<typeof createLogger>;

export interface JudgeDeps {
  config: JudgeConfig;
  sandbox: SandboxConfig;
  pool: Pool;
  queue: Queue;
  logger: JudgeLogger;
}

/**
 * Builds the shared dependency set from env vars. `configOverride`/`sandboxOverride` let tests
 * (and the rejudge CLI) inject config without re-reading `process.env`.
 */
export function buildJudgeDeps(
  configOverride?: JudgeConfig,
  sandboxOverride?: SandboxConfig,
): JudgeDeps {
  const config = configOverride ?? loadJudgeConfig();
  const sandbox = sandboxOverride ?? loadSandboxConfig();
  const pool = getPool();
  const logger = createLogger("judge");
  const queue = new Queue(pool, {
    leaseSeconds: undefined,
    workerId: config.judgeWorkerId,
    logger: logger as unknown as QueueLogger,
  });
  return { config, sandbox, pool, queue, logger };
}
