import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // docs/CONTRACTS.md §13: point DATABASE_URL at TEST_DATABASE_URL (guarded) before any test
    // file's top-level code runs, so this suite never touches the development database.
    setupFiles: ["./test/testSetup.ts"],
    // Sandbox executions (real `docker run`) plus multi-phase state-machine transactions are
    // slow relative to unit tests; give both the per-test and per-hook budget real headroom.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Integration tests share one real Postgres instance and the single seeded local user's
    // `user_concept_state` rows; keep file execution serial so cleanup in one file can't race
    // writes in another (same policy as apps/api's vitest.config.ts).
    fileParallelism: false,
  },
});
