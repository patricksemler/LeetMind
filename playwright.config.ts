import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke: sign in → practice serves a problem → solve → live verdict → the concept tree
 * moves. It exercises the seams a component test cannot — the real wire shapes, the SSE stream,
 * and the router — so it needs a real backend behind the app, not a stubbed one.
 *
 * This does NOT start anything itself. Bring up a web server (`pnpm dev`, pointed at a backend via
 * `VITE_API_BASE`) and set `E2E_BASE_URL` to it; the default assumes the dev server's own port.
 * Use a scratch database if the backend you point at has one — the run submits real solutions and
 * moves real ratings.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
