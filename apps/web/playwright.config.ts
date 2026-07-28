import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke: sign in → practice generates and serves a problem → solve → accepted verdict
 * → the concepts page shows the rating that moved. It exercises the seams a component test cannot
 * — the real wire shapes, the generation pipeline, and the router — so it needs a real backend
 * behind the app, not a stubbed one.
 *
 * This does NOT start anything itself. Bring up:
 *   - the server (`apps/server`) with `LLM_CLI=fixture` (PLAN_BACKEND.md §12) — this backend's
 *     generation is always LLM-driven, so fixture mode stands in for a real CLI with a
 *     deterministic canned problem, and needs no login;
 *   - a web server (`pnpm dev`, pointed at that backend via `VITE_API_BASE`), with
 *     `E2E_BASE_URL` set to it if not the dev server's own default port;
 *   - `E2E_EMAIL`/`E2E_PASSWORD` for a real Supabase Auth user — auth is required in both apps
 *     (PLAN_BACKEND.md §9), so the spec skips itself without credentials rather than assuming a
 *     single-user bypass that no longer exists server-side.
 * Use a scratch database — the run submits real solutions and moves real ratings.
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
