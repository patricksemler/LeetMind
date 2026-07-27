import type { Request, Response } from "express";

/** Express 5 types route params as `string | string[]` (array route patterns); every route here
 * uses a plain `:id`-style segment, so this just narrows back to the plain string. */
export function pparam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export function notFound(res: Response, message: string) {
  res.status(404).json({
    error: { code: "not_found", message },
    correlation_id: res.getHeader("x-correlation-id"),
  });
}

export function badRequest(res: Response, message: string, details?: unknown) {
  res.status(400).json({
    error: { code: "validation_error", message, details },
    correlation_id: res.getHeader("x-correlation-id"),
  });
}

export function handle(fn: (req: Request, res: Response) => void | Promise<void>) {
  return (req: Request, res: Response) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error("[mock-api] unhandled error", err);
      res.status(500).json({
        error: { code: "internal_error", message: "unexpected mock server error" },
        correlation_id: res.getHeader("x-correlation-id"),
      });
    });
  };
}
