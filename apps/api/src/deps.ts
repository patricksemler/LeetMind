// Small container wiring pool/queue/logger so every route and every test shares one
// construction path (docs/CONTRACTS.md apps/api brief: "src/deps.ts").
import type { Pool } from "pg";
import type { Logger as PinoLogger } from "pino";
import { getPool } from "@algolift/db";
import { Queue, type Logger as QueueLogger } from "@algolift/queue";
import { createLogger, loadApiConfig, type ApiConfig } from "@algolift/shared";

export interface Deps {
  config: ApiConfig;
  pool: Pool;
  queue: Queue;
  logger: PinoLogger;
}

/**
 * Builds the shared dependency set. `configOverride` lets tests inject a config without
 * re-reading `process.env` (e.g. to point at a different single-user id).
 */
export function buildDeps(configOverride?: ApiConfig): Deps {
  const config = configOverride ?? loadApiConfig();
  const pool = getPool();
  const logger = createLogger("api");
  const queue = new Queue(pool, { logger: logger as unknown as QueueLogger });
  return { config, pool, queue, logger };
}
