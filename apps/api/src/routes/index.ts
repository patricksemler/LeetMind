import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps.js";
import { registerBaselineRoutes } from "./baseline.js";
import { registerConceptRoutes } from "./concepts.js";
import { registerGenerateRoutes } from "./generate.js";
import { registerHealthRoutes } from "./health.js";
import { registerHintRoutes } from "./hints.js";
import { registerMeRoutes } from "./me.js";
import { registerMetricsRoutes } from "./metrics.js";
import { registerPracticeRoutes } from "./practice.js";
import { registerProblemRoutes } from "./problems.js";
import { registerProgressRoutes } from "./progress.js";
import { registerSubmissionRoutes } from "./submissions.js";
import { registerSystemRoutes } from "./system.js";

export function registerRoutes(fastify: FastifyInstance, deps: Deps): void {
  registerHealthRoutes(fastify, deps);
  registerMeRoutes(fastify, deps);
  registerConceptRoutes(fastify, deps);
  registerProblemRoutes(fastify, deps);
  registerSubmissionRoutes(fastify, deps);
  registerHintRoutes(fastify, deps);
  registerProgressRoutes(fastify, deps);
  registerSystemRoutes(fastify, deps);
  registerMetricsRoutes(fastify, deps);
  registerGenerateRoutes(fastify, deps);
  registerBaselineRoutes(fastify, deps);
  registerPracticeRoutes(fastify, deps);
}
