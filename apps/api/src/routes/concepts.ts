import type { FastifyInstance } from "fastify";
import { listConceptEdges, listConcepts } from "@algolift/db";
import type { Deps } from "../deps.js";

export function registerConceptRoutes(fastify: FastifyInstance, _deps: Deps): void {
  fastify.get("/api/concepts", async (_request, reply) => {
    const [concepts, edges] = await Promise.all([listConcepts(), listConceptEdges()]);
    reply.send({ concepts, edges });
  });
}
