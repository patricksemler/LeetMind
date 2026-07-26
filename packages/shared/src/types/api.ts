import { z } from "zod";
import { ConceptEdgeSchema, ConceptSchema } from "./concepts.js";
import { PublicProblemSchema } from "./problem.js";

// Small standalone route DTOs that don't belong to any larger family: GET /health,
// GET /api/problems/next, GET /api/problems/:versionId, GET /api/me, POST /api/generate-now,
// GET /api/concepts. Split out of submission.ts; see submission.ts for the actual
// submission-domain vocabulary.

// --- GET /health ----------------------------------------------------------------------------

export const HealthResponse = z.object({
  ok: z.boolean(),
  version: z.string(),
  db: z.enum(["up", "down"]),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

// --- GET /api/problems/next -----------------------------------------------------------------

export const NextProblemQuery = z.object({
  concept: z.string().optional(),
  rating: z.coerce.number().optional(),
});
export type NextProblemQuery = z.infer<typeof NextProblemQuery>;

// `problem` is nullable: an empty approved pool is a normal state (the replenishment buffer may
// not have caught up yet), not an error. The API returns 200 with `problem: null` and an
// actionable `rationale` rather than a 500 — see CONTRACTS §9.
export const NextProblemResponse = z
  .object({
    problem: PublicProblemSchema.nullable(),
    rationale: z.string(),
    evidence: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();
export type NextProblemResponse = z.infer<typeof NextProblemResponse>;

// --- GET /api/problems/:versionId -----------------------------------------------------------

export const GetProblemResponse = z.object({
  problem: PublicProblemSchema,
});
export type GetProblemResponse = z.infer<typeof GetProblemResponse>;

// --- GET /api/me --------------------------------------------------------------------------------

export const MeResponse = z.object({
  user: z.object({
    id: z.string(),
    handle: z.string(),
    email: z.string().nullable(),
  }),
});
export type MeResponse = z.infer<typeof MeResponse>;

// --- POST /api/generate-now (M3 escape hatch) -------------------------------------------------

export const GenerateNowRequest = z.object({
  concepts: z.array(z.object({ id: z.string(), weight: z.number().min(0).max(1) })).min(1),
  target_rating: z.number().int(),
});
export type GenerateNowRequest = z.infer<typeof GenerateNowRequest>;

export const GenerateNowResponse = z.object({
  job_id: z.string(),
});
export type GenerateNowResponse = z.infer<typeof GenerateNowResponse>;

// --- GET /api/concepts -------------------------------------------------------------------------

export const GetConceptsResponse = z.object({
  concepts: z.array(ConceptSchema),
  edges: z.array(ConceptEdgeSchema),
});
export type GetConceptsResponse = z.infer<typeof GetConceptsResponse>;
