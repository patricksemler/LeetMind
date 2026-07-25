import type { FastifyInstance } from "fastify";
import { queryOne } from "@leetmind/db";
import type { Deps } from "../deps.js";
import { API_VERSION } from "../server.js";

export function registerHealthRoutes(fastify: FastifyInstance, _deps: Deps): void {
  fastify.get("/health", async (_request, reply) => {
    let db: "up" | "down" = "down";
    try {
      const row = await queryOne<{ ok: number }>("select 1 as ok");
      db = row?.ok === 1 ? "up" : "down";
    } catch {
      db = "down";
    }

    reply.send({ ok: db === "up", version: API_VERSION, db });
  });
}
