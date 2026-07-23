// Vitest setupFile (see ../vitest.config.ts) — runs before any test file in this suite. Per
// docs/CONTRACTS.md §13, tests never read `DATABASE_URL` (which defaults to the development
// database); they read `TEST_DATABASE_URL`. This also gives THIS PROCESS its own Postgres schema
// within that test database (schema-per-vitest-process isolation, §13), so running
// `pnpm --filter @algolift/judge test` concurrently with `pnpm --filter @algolift/api test` (or
// with content's `pytest`, or with another copy of this suite's own chaos worker subprocesses —
// which inherit this process's already-redirected `DATABASE_URL` via `spawnChaosWorker`'s
// `{...process.env}`, so they land in the SAME schema automatically, no extra wiring needed)
// against the same `algolift_test` database no longer collides — this is exactly the gap
// documented in §13's "This generalizes beyond TypeScript" note (`assertNoStrayJobs()` in
// apps/judge/test/chaos/chaos-helpers.ts fired for real during development because of it).
// `ensureTestSchemaIsolation` asserts `assertTestDatabase` first regardless (defense in depth, not
// a replacement for it). If the guard throws, the whole test run fails loudly here, before any
// test (and therefore before any seed/teardown) gets a chance to run.
//
// Note: this suite (apps/judge/test/helpers.ts) already never truncates shared tables — it only
// ever creates and tears down its own rows — so this setup file's job is purely the DATABASE_URL
// redirection + schema isolation + guard, not a change to how tests clean up after themselves.
import { afterAll } from "vitest";
import { dropTestSchema, ensureTestSchemaIsolation, testDatabaseUrl, testWorkerSchema } from "@algolift/db";

await ensureTestSchemaIsolation();

// Vitest's default pool forks a fresh child process (and thus a fresh module registry, so a
// fresh `readyPromise` in @algolift/db's testSchema.ts) per test FILE even with
// `fileParallelism: false` — which means this schema is actually scoped per-file, not merely
// per-`pnpm --filter` invocation. That's strictly *more* isolation than §13 asks for (chaos-suite
// child worker processes spawned from any one file still inherit that file's own schema via
// `DATABASE_URL`, so they stay correctly grouped with it), but it also means a full run creates
// one throwaway schema per test file — drop it once this file's tests finish so `algolift_test`
// doesn't accumulate schemas across repeated runs.
afterAll(async () => {
  await dropTestSchema(testWorkerSchema(), testDatabaseUrl());
});
