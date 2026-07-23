import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // docs/CONTRACTS.md §13: point DATABASE_URL at a schema-scoped TEST_DATABASE_URL (guarded,
    // migrated) before any test file's top-level code runs, so this process's tests are isolated
    // from every OTHER concurrently-running test process sharing algolift_test — not just from
    // the development database.
    setupFiles: ["./test/testSetup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Integration tests share one real Postgres instance (now: this process's own schema within
    // it) and mutate shared rows (the single seeded local user's `user_concept_state`); keep file
    // execution serial so cleanup in one file can't race writes in another.
    fileParallelism: false,
  },
});
