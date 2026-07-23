import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Docker integration tests spin up real containers and can be slow,
    // especially the first time an image needs to be built.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
