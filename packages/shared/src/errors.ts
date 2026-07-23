/**
 * Application error type + helpers, and the shape the API serializes errors to.
 * See docs/CONTRACTS.md §1: `{ error: { code, message, details? }, correlation_id }`.
 */

export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: string, message: string, httpStatus: number, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function notFound(message = "Not found", details?: unknown): AppError {
  return new AppError("not_found", message, 404, details);
}

export function badRequest(message = "Bad request", details?: unknown): AppError {
  return new AppError("bad_request", message, 400, details);
}

export function conflict(message = "Conflict", details?: unknown): AppError {
  return new AppError("conflict", message, 409, details);
}

export function internal(message = "Internal error", details?: unknown): AppError {
  return new AppError("internal_error", message, 500, details);
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  correlation_id: string;
}

/**
 * Normalizes any thrown value into the API's error response envelope. Non-`AppError` values are
 * mapped to a generic 500 `internal_error` without leaking internal details.
 */
export function toErrorResponse(err: unknown, correlationId: string): ErrorResponse {
  if (err instanceof AppError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
      correlation_id: correlationId,
    };
  }

  return {
    error: { code: "internal_error", message: "Internal error" },
    correlation_id: correlationId,
  };
}
