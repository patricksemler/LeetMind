import { defineConfig, devices } from "@playwright/test";

/**
 * Real-stack e2e smoke (QA-PLAN.md "Prevent recurrence" §2). Runs against a REAL api + judge +
 * web — never the mock server — because half of Phase 1's P0 bugs were exactly the seams this
 * kind of test crosses (a shape the mock got right and the real API didn't, or vice versa).
 *
 * This does NOT start the stack itself — QA-PLAN.md's "Reproducing the QA environment" section is
 * the canonical way to bring one up (an isolated `leetmind_qa` database, api on :8081, its own
 * judge worker, web on :5174, so a full e2e run never touches your everyday dev database or dev
 * server). Point `E2E_BASE_URL` at whatever's already running; it defaults to that QA web port.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
