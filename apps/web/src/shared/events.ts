import type { components } from "./api-types";

/**
 * `GET /api/events`'s SSE payload (PLAN_BACKEND.md §9): a generation job's stage transition.
 * Hand-written because the route returns `EventSourceResponse`, not a pydantic model, so it has
 * no OpenAPI schema to generate this from — kept in sync with `leetmind.schemas.GenerationEvent`
 * by hand. `status` still borrows the generated enum, so a new job status shows up as a type error
 * here instead of silently falling through.
 */
export interface GenerationEvent {
  job_id: string;
  status: components["schemas"]["GenerationJobStatus"];
  repair_count: number;
  problem_id: string | null;
  error: string | null;
}
