// POST /api/generate-now — the M3 "escape hatch": enqueue a `generate` job at elevated priority
// (docs/CONTRACTS.md §9). Uses a fresh, always-unique idempotency key rather than the
// replenishment worker's `generate:<concept>:<band>:<slot>` scheme (content/leetmind_content
// /workers/replenish.py, docs/CONTRACTS.md §11) deliberately: reusing that scheme risks a manual
// request silently colliding with (and no-op'ing against) an already-queued background
// replenishment job for the same concept/band cell, which would defeat the entire point of an
// on-demand "generate now" button.
import type { FastifyInstance } from "fastify";
import { withTransaction } from "@leetmind/db";
import { GenerateNowRequest, GenerationRequestSchema, newId } from "@leetmind/shared";
import type { Deps } from "../deps.js";

/** Lower runs sooner (docs/CONTRACTS.md §4.4: JOB_PRIORITY.generate = 100). Elevated well above
 * that, and above judge (10)/verify (50) too, so a manual request jumps the whole queue. */
const ELEVATED_GENERATE_PRIORITY = 1;

/** Must track content/leetmind_content/generation/prompts/v2.py's `PROMPT_VERSION` (per
 * docs/CONTRACTS.md §11) — the content plane is a separate Python codebase apps/api may not
 * import, so this is a documented cross-language constant, not a guess.
 *
 * It is not inert: `StubInvoker` stamps this value onto the generated problem's
 * `provenance.prompt_version` (content/leetmind_content/generation/invoker.py), so a stale value
 * here mislabels generated content. Kept in step with lib/practiceQueries.ts. */
const PROMPT_VERSION = "v2";

export function registerGenerateRoutes(fastify: FastifyInstance, deps: Deps): void {
  fastify.post("/api/generate-now", async (request, reply) => {
    const body = GenerateNowRequest.parse(request.body);
    const correlationId = request.correlationId;

    const conceptKey = [...body.concepts]
      .map((c) => c.id)
      .sort()
      .join("+");
    const band = Math.floor(body.target_rating / 200) * 200;

    const generationRequest = GenerationRequestSchema.parse({
      concepts: body.concepts,
      target_rating: body.target_rating,
      rating_tolerance: 100,
      expected_minutes: [5, 20],
      required_patterns: [],
      forbidden_patterns: [],
      similarity_exclusions: [],
      allow_types: [],
      prompt_version: PROMPT_VERSION,
    });

    const job = await withTransaction((client) =>
      deps.queue.enqueue(client, {
        kind: "generate",
        payload: { request: generationRequest, correlation_id: correlationId },
        priority: ELEVATED_GENERATE_PRIORITY,
        idempotencyKey: `generate:manual:${conceptKey}:${band}:${newId()}`,
        correlationId,
      }),
    );

    if (!job) {
      // Unreachable in practice (idempotency key is always fresh), but keep the response
      // contract honest rather than sending `job_id: undefined`.
      reply.status(500).send({ error: { code: "internal_error", message: "job enqueue collided" }, correlation_id: correlationId });
      return;
    }

    reply.status(202).send({ job_id: job.id });
  });
}
