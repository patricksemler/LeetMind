// GET /api/me — who the caller is and whether they still need onboarding.
//
// The web client needs both facts before it can decide what to render, and asking for them
// separately means a first paint that flickers between "sign in", "take the baseline", and
// "practice". One call, one decision.
import type { FastifyInstance } from "fastify";
import { getLatestBaselineSession, getUser } from "@leetmind/db";
import { notFound } from "@leetmind/shared";
import type { Deps } from "../deps.js";

export function registerMeRoutes(fastify: FastifyInstance, _deps: Deps): void {
  fastify.get("/api/me", async (request, reply) => {
    const userId = request.userId;
    const [user, baseline] = await Promise.all([getUser(userId), getLatestBaselineSession(userId)]);

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
      // A baseline that was started and abandoned still counts as "asked for" — re-prompting a
      // user who deliberately backed out of onboarding every time they open the app is a trap.
      // The practice route uses the same rule (`getLatestBaselineSession`, any status).
      has_baseline: baseline !== null,
    });
  });
}
