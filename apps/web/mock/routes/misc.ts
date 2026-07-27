import type { Express } from "express";
import { GenerateNowRequest, newId } from "@leetmind/shared";
import { CONCEPT_EDGES, CONCEPTS } from "../fixtures/concepts.js";
import { USER_ID } from "../state.js";
import { badRequest, handle } from "./helpers.js";

export function registerMiscRoutes(app: Express): void {
  // --- GET /health -------------------------------------------------------------------------------

  app.get(
    "/health",
    handle((_req, res) => {
      res.json({ ok: true, version: "mock-0.1.0", db: "up" });
    }),
  );

  // --- GET /api/me --------------------------------------------------------------------------------

  app.get(
    "/api/me",
    handle((_req, res) => {
      res.json({
        user: { id: USER_ID, handle: "local", email: null },
      });
    }),
  );

  // --- POST /api/generate-now (M3 escape hatch) ---------------------------------------------------

  app.post(
    "/api/generate-now",
    handle((req, res) => {
      const parsed = GenerateNowRequest.safeParse(req.body);
      if (!parsed.success) return badRequest(res, "invalid generate-now request", parsed.error.flatten());
      res.json({ job_id: newId() });
    }),
  );

  // --- GET /api/concepts -------------------------------------------------------------------------

  app.get(
    "/api/concepts",
    handle((_req, res) => {
      res.json({ concepts: CONCEPTS, edges: CONCEPT_EDGES });
    }),
  );
}
