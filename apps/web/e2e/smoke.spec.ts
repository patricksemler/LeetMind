import { expect, test } from "@playwright/test";

/**
 * End-to-end smoke: sign in → practice generates and serves a problem → open it → solve it →
 * synchronous accepted verdict with a rating breakdown → practice serves the next one → the
 * concepts page shows the rating it moved. Needs a real backend behind the app (see
 * playwright.config.ts's header for what to bring up and how to point at it) with
 * `LLM_CLI=fixture` (PLAN_BACKEND.md §12): generation is always LLM-driven in this backend — no
 * static problem bank to seed — so the server's fixture mode stands in for the CLI with the same
 * canned "sum a list" problem the pytest suite uses (`leetmind.fixtures`), which is why the
 * solution below is hardcoded to `def solve(nums): return sum(nums)`.
 */
const CORRECT_SOLUTION = "def solve(nums):\n    return sum(nums)\n";

const E2E_EMAIL = process.env.E2E_EMAIL;
const E2E_PASSWORD = process.env.E2E_PASSWORD;

async function signIn(page: import("@playwright/test").Page) {
  // Every test run gets a fresh, storage-less browser context (Playwright's default), so there is
  // no "might already be signed in" case to special-case here the way an app with an optional
  // single-user bypass once needed — auth is required in both apps now (PLAN_BACKEND.md §9).
  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_EMAIL!);
  await page.getByLabel("Password").fill(E2E_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Not `toHaveURL(/\/(?!login)/)`: that regex is unanchored, so it matches the "//" in
  // "http://" and passes on every URL including /login itself — vacuously true, never actually
  // checked navigation left the sign-in page. The nav's "Sign out" button only renders once a
  // session exists (`NavBar.tsx`), so waiting for it is a direct check on the thing that matters.
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 15_000 });
}

test("practice generates and serves a problem -> solve -> accepted -> next -> rating moved", async ({
  page,
}) => {
  test.skip(!E2E_EMAIL || !E2E_PASSWORD, "requires E2E_EMAIL/E2E_PASSWORD against a Supabase project");

  await signIn(page);
  await page.goto("/");

  // A brand-new (or exhausted) queue starts from "generating" — practice bootstraps it via
  // `POST /api/practice/replenish` on first load. Either state is reachable depending on what an
  // earlier run left behind, so accept both.
  await expect(
    page
      .getByRole("link", { name: /^(Start|Continue)$/ })
      .or(page.getByText(/Writing you a new problem/i))
      .first(),
  ).toBeVisible({ timeout: 20_000 });

  const startLink = page.getByRole("link", { name: /^(Start|Continue)$/ });
  await expect(startLink).toBeVisible({ timeout: 120_000 }); // generation can take a while even stubbed
  await startLink.click();
  await expect(page).toHaveURL(/\/problem\//);

  // `POST /problems/{id}/open` fires on mount — the statement is unobtainable before it
  // (amendment 41), so this is also the moment the workspace has anything to show at all.
  await expect(page.getByRole("heading", { name: "Sum It Up" })).toBeVisible({ timeout: 15_000 });

  // Not keyboard.type(): Monaco's own smart-indent rewrites whatever we type as we type it.
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await page.evaluate((code) => {
    const monaco = (window as any).monaco;
    monaco.editor.getModels()[0].setValue(code);
  }, CORRECT_SOLUTION);

  await page.getByRole("button", { name: "Submit" }).click();

  // Run/submit are synchronous now (§8.3) — no SSE verdict to wait on, the response itself is the
  // result. Landing on the Result tab and reading "accepted" there is the whole assertion.
  const resultsPanel = page.locator('[data-testid="results-panel"]');
  await expect(resultsPanel).toBeVisible({ timeout: 30_000 });
  await expect(resultsPanel.getByText("accepted")).toBeVisible({ timeout: 10_000 });

  // The rating-update breakdown (#22) rides along on the same response.
  await expect(page.locator('[data-testid="rating-update-panel"]')).toBeVisible();

  // Practice must have something to say afterwards — either the next problem, or a visible
  // "generating" state. What it must NOT do is dead-end.
  await page.goto("/");
  await expect(
    page
      .getByRole("link", { name: /^(Start|Continue)$/ })
      .or(page.getByText(/Writing you a new problem/i))
      .first(),
  ).toBeVisible({ timeout: 20_000 });

  // And the concepts page must reflect the solve: at least one type now carries a rating badge.
  await page.goto("/concepts");
  await expect(page.getByText(/^\d{3,4}$/).first()).toBeVisible({ timeout: 15_000 });
});
