// Vitest setupFile (see ../vitest.config.ts) — runs before any test file in this package. Per
// docs/CONTRACTS.md §13, tests never read `DATABASE_URL` (which defaults to the development
// database); they read `TEST_DATABASE_URL`. This also gives THIS PROCESS its own Postgres schema
// within that test database (schema-per-vitest-process isolation, §13), so running
// `pnpm --filter @algolift/api test` concurrently with `pnpm --filter @algolift/judge test` (or
// with content's `pytest`) against the same `algolift_test` database no longer collides — each
// process's schema is a separate namespace, migrated independently, with `search_path` baked into
// `process.env.DATABASE_URL` for the rest of this process's lifetime. `ensureTestSchemaIsolation`
// asserts `assertTestDatabase` first regardless (defense in depth, not a replacement for it — see
// its own doc comment in @algolift/db). If the guard throws, the whole test run fails loudly
// here, before any test (and therefore before any destructive fixture) gets a chance to run.
import { afterAll } from "vitest";
import { dropTestSchema, ensureTestSchemaIsolation, testDatabaseUrl, testWorkerSchema } from "@algolift/db";

await ensureTestSchemaIsolation();

// Vitest's default pool forks a fresh child process (and thus a fresh module registry, so a
// fresh `readyPromise` in @algolift/db's testSchema.ts) per test FILE even with
// `fileParallelism: false` — which means this schema is actually scoped per-file, not merely
// per-`pnpm --filter` invocation. That's strictly *more* isolation than §13 asks for, but it also
// means a full run creates one throwaway schema per test file — drop it once this file's tests
// finish so `algolift_test` doesn't accumulate schemas across repeated runs.
afterAll(async () => {
  await dropTestSchema(testWorkerSchema(), testDatabaseUrl());
});
