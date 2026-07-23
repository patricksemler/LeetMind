import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // docs/CONTRACTS.md §13: point DATABASE_URL at TEST_DATABASE_URL (guarded) before any test
    // file's top-level code runs, so live-DB tests here never touch the development database.
    setupFiles: ["./src/test-setup.ts"],
    // db.test.ts runs real migrations against the live database; keep file execution serial so
    // it can't race other files' schema/DDL work.
    fileParallelism: false,
  },
});
