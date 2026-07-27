/**
 * Mock implementation of every endpoint in docs/CONTRACTS.md §9, backed by in-memory fixtures.
 * This is what `apps/web` runs against in dev (`pnpm dev:mock`) until `apps/api` exists — flip
 * `VITE_API_BASE` to point at the real API and nothing in `apps/web/src` needs to change.
 *
 * It is also a de-facto executable spec of §9: every response shape is built and validated
 * through the same `@leetmind/shared` zod schemas the real API must satisfy, and `toPublicProblem`
 * (the *only* legal constructor of a client-facing problem, per §4.2) is imported rather than
 * reimplemented.
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { newId, ProblemVersionSchema } from "@leetmind/shared";
import { registerHintRoutes } from "./routes/hints.js";
import { registerMiscRoutes } from "./routes/misc.js";
import { registerProblemRoutes } from "./routes/problems.js";
import { registerProgressRoutes } from "./routes/progress.js";
import { registerSubmissionRoutes } from "./routes/submissions.js";
import { problemFixtures } from "./state.js";

// Sanity-check every fixture against the full, server-only schema at boot — catches fixture
// authoring mistakes before they can produce a broken PublicProblem.
for (const fixture of problemFixtures) {
  ProblemVersionSchema.parse(fixture.content);
}

const app: Express = express();
app.use(express.json({ limit: "2mb" }));

app.use((req: Request, res: Response, next: NextFunction) => {
  const correlationId = (req.header("x-correlation-id") ?? newId()) as string;
  res.setHeader("x-correlation-id", correlationId);
  next();
});

// Route registration order matches the original single-file layout, with one harmless exception:
// `/health`, `/api/me`, `/api/generate-now`, and `/api/concepts` (grouped into routes/misc.ts) are
// now mounted last instead of interleaved between the other groups. None of those four paths share
// a prefix with any `:param` route in this app, so nothing can shadow them regardless of where
// they're registered relative to the others. The one order-sensitive pair in this whole app — `GET
// /api/problems/next` vs `GET /api/problems/:versionId` — is preserved exactly: both are registered
// inside registerProblemRoutes in their original relative order, so `next` still matches before the
// `:versionId` wildcard would otherwise capture it.
registerProblemRoutes(app);
registerSubmissionRoutes(app);
registerHintRoutes(app);
registerProgressRoutes(app);
registerMiscRoutes(app);

// Exported (rather than only ever `app.listen()`-ed below) so mock/server.test.ts can drive it
// in-process with supertest — no port binding, and no risk of colliding with an already-running
// dev instance.
export { app };

// Only bind a real port when this file is run directly (`pnpm mock` / `pnpm dev:mock`), not when
// it's imported as a module (by the test file above).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const PORT = Number(process.env.MOCK_PORT ?? process.env.VITE_API_BASE?.split(":").pop() ?? 8080);
  app.listen(PORT, () => {
    console.log(
      `[mock-api] listening on http://localhost:${PORT} (${problemFixtures.length} fixture problems)`,
    );
  });
}
