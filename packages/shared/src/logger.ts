import { AsyncLocalStorage } from "node:async_hooks";
import pino, { type Logger } from "pino";

/**
 * Correlation/job/submission/worker context, propagated through async call chains and mixed into
 * every structured log line. See docs/CONTRACTS.md §1.
 */
export interface LogContext {
  correlationId?: string;
  jobId?: string;
  submissionId?: string;
  workerId?: string;
}

export const logContext = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with `ctx` as the active log context (replaces, does not merge with, any parent). */
export function runWithContext<T>(ctx: LogContext, fn: () => T): T {
  return logContext.run(ctx, fn);
}

/**
 * Merges `partial` into whatever log context is currently active, for the remainder of the
 * current async execution (no callback needed — unlike `runWithContext`, this mutates the store
 * in place via `AsyncLocalStorage#enterWith`).
 */
export function withContext(partial: LogContext): void {
  const current = logContext.getStore() ?? {};
  logContext.enterWith({ ...current, ...partial });
}

/**
 * Creates a pino JSON logger for `service`. Every line carries `ts, level, service, msg`, plus
 * whichever of `correlation_id, job_id, submission_id, worker_id` are present in the active
 * `logContext`. Pretty-printing is enabled only in local interactive dev (NODE_ENV=development
 * AND stdout is a TTY) — service/container logs are always single-line JSON.
 */
export function createLogger(service: string): Logger {
  const isDev = process.env.NODE_ENV === "development";
  const isTTY = process.stdout.isTTY === true;
  const usePretty = isDev && isTTY;

  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { service },
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    mixin() {
      const ctx = logContext.getStore();
      if (!ctx) return {};
      const fields: Record<string, string> = {};
      if (ctx.correlationId) fields.correlation_id = ctx.correlationId;
      if (ctx.jobId) fields.job_id = ctx.jobId;
      if (ctx.submissionId) fields.submission_id = ctx.submissionId;
      if (ctx.workerId) fields.worker_id = ctx.workerId;
      return fields;
    },
    ...(usePretty
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:standard" },
          },
        }
      : {}),
  });
}
