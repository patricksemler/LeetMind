// GET /api/me — who the caller is.
//
// This used to also answer "do they still need onboarding?" (`has_baseline`), which the web client
// needed before it could decide between rendering the sign-in screen, the baseline, or practice.
// There is no onboarding any more: a signed-in user goes straight to a problem, so identity is the
// only question left to answer here.
import type { FastifyInstance } from "fastify";
import { getUser } from "@leetmind/db";
import { notFound } from "@leetmind/shared";
import type { Deps } from "../deps.js";

export function registerMeRoutes(fastify: FastifyInstance, _deps: Deps): void {
  fastify.get("/api/me", async (request, reply) => {
    const userId = request.userId;
    const user = await getUser(userId);

    if (!user) {
      // Only reachable with auth off and a SINGLE_USER_ID that was never seeded — a
      // misconfiguration, not a user-facing state.
      throw notFound("User not found");
    }

    reply.send({
      user: {
        id: user.id,
        handle: user.handle,
        // Prefer the verified token's email over the denormalized copy: the copy is only
        // refreshed at provisioning time, so it goes stale if the account changes address.
        email: request.authEmail ?? user.email ?? null,
      },
    });
  });
}
