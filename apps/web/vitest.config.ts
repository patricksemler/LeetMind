import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@leetmind/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    css: false,
    // e2e/ is Playwright-only (its own test() from @playwright/test, run via `playwright test`,
    // not vitest) — vitest's default include glob would otherwise pick up e2e/*.spec.ts too.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
