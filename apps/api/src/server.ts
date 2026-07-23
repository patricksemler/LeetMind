// Builds (but does not start) the Fastify instance. Exported so tests can inject it via
// `fastify.inject()` without binding a real port (docs/CONTRACTS.md apps/api brief).
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import {
  AppError,
  isId,
  newId,
  toErrorResponse,
  withContext,
} from "@algolift/shared";
import type { Deps } from "./deps.js";
import { registerRoutes } from "./routes/index.js";

export const API_VERSION = "0.1.0";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
  }
}

/** Best-effort resolution of the web dev server's origin, for CORS. Not part of ApiConfig's
 * parsed schema (docs/CONTRACTS.md §2 scopes WEB_PORT to `web`, not `api`) — read directly with a
 * sane default matching the documented default. */
function resolveWebOrigins(): string[] {
  const port = process.env.WEB_PORT?.trim() || "5173";
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

export function buildServer(deps: Deps): FastifyInstance {
  const fastify = Fastify({ logger: false, trustProxy: true });
  const { logger } = deps;

  fastify.register(cors, { origin: resolveWebOrigins(), credentials: false });

  // Correlation-id plumbing (docs/CONTRACTS.md §1): read `x-correlation-id` or mint a fresh ULID,
  // echo it on the response, and enter it into the shared AsyncLocalStorage log context via
  // `withContext` (enterWith-based) so every log line for the rest of this request's async chain
  // — including ones emitted deep inside route handlers and the error handler — carries it. A
  // plain `runWithContext` wrapping just this hook would NOT persist across Fastify's later
  // hooks/handler (each is a separate promise continuation); `withContext`/`enterWith` is exactly
  // what `@algolift/shared` exports for this situation, per its own doc comment.
  fastify.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-correlation-id"];
    const correlationId =
      typeof incoming === "string" && incoming.trim().length > 0 ? incoming.trim() : newId();
    request.correlationId = correlationId;
    reply.header("x-correlation-id", correlationId);
    withContext({ correlationId });
    (request as FastifyRequest & { _startedAt?: bigint })._startedAt = process.hrtime.bigint();
  });

  fastify.addHook("onResponse", async (request, reply) => {
    const started = (request as FastifyRequest & { _startedAt?: bigint })._startedAt;
    const durationMs = started ? Number(process.hrtime.bigint() - started) / 1e6 : undefined;
    logger.info(
      {
        method: request.method,
        path: request.url,
        status: reply.statusCode,
        duration_ms: durationMs === undefined ? undefined : Math.round(durationMs * 100) / 100,
      },
      "request completed",
    );
  });

  fastify.setErrorHandler<unknown>((err, request, reply) => {
    const correlationId = request.correlationId ?? newId();

    if (err instanceof ZodError) {
      const appErr = new AppError("bad_request", "Request failed validation", 400, {
        issues: err.issues,
      });
      logger.warn({ issues: err.issues }, "validation error");
      reply.status(appErr.httpStatus).send(toErrorResponse(appErr, correlationId));
      return;
    }

    if (err instanceof AppError) {
      const level = err.httpStatus >= 500 ? "error" : "warn";
      logger[level]({ err, code: err.code, http_status: err.httpStatus }, err.message);
      reply.status(err.httpStatus).send(toErrorResponse(err, correlationId));
      return;
    }

    // Fastify's own errors (malformed JSON body, oversized payload, unknown route method, ...)
    // carry a `statusCode`. Anything client-side (< 500) maps straight through as a bad_request;
    // anything else (or no statusCode at all) is an unexpected 500.
    const errorLike = err instanceof Error ? err : new Error(String(err));
    const fastifyStatus = (err as { statusCode?: number })?.statusCode;
    if (typeof fastifyStatus === "number" && fastifyStatus >= 400 && fastifyStatus < 500) {
      const appErr = new AppError("bad_request", errorLike.message, fastifyStatus);
      logger.warn({ err: errorLike }, "request error");
      reply.status(appErr.httpStatus).send(toErrorResponse(appErr, correlationId));
      return;
    }

    logger.error({ err: errorLike, stack: errorLike.stack }, "unhandled error");
    reply.status(500).send(toErrorResponse(errorLike, correlationId));
  });

  fastify.setNotFoundHandler((request, reply) => {
    const correlationId = request.correlationId ?? newId();
    const appErr = new AppError("not_found", `No route: ${request.method} ${request.url}`, 404);
    reply.status(404).send(toErrorResponse(appErr, correlationId));
  });

  registerRoutes(fastify, deps);

  return fastify;
}

/** Shared param-validation helper: routes with a `:id`-shaped ULID param throw 400 up front. */
export function requireId(value: unknown, label = "id"): string {
  if (typeof value !== "string" || !isId(value)) {
    throw new AppError("bad_request", `Invalid ${label}`, 400, { [label]: value });
  }
  return value;
}
