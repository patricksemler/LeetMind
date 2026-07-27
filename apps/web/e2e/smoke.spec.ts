import { expect, test } from "@playwright/test";

/**
 * Real-stack e2e smoke (QA-PLAN.md "Prevent recurrence" §2): sign in → practice serves a problem →
 * solve → live verdict visible → practice serves the next one → progress reflects it. Run against a
 * REAL api + judge + web (never the mock server) — see playwright.config.ts's header comment for
 * how to bring that stack up.
 *
 * The QA fixture pool's approved problems are all the same underlying problem ("Maximum Sum of a
 * Length-K Subarray") seeded multiple times across different concepts/rating bands, so a single
 * hardcoded correct solution below covers whichever one practice serves.
 *
 * There is deliberately no baseline step: the baseline flow was removed, and practice now answers
 * the very first request with a problem (see apps/api/src/routes/practice.ts's header).
 */
const CORRECT_SOLUTION = `from typing import List, Optional


def maxSumSubarray(nums: List[int], k: int) -> int:
    best = sum(nums[:k])
    cur = best
    for i in range(k, len(nums)):
        cur += nums[i] - nums[i - k]
        best = max(best, cur)
    return best
`;

/** Set when the stack under test has auth enabled (SUPABASE_URL configured). Left unset for a
 * single-user stack, where these steps are skipped entirely. */
const E2E_EMAIL = process.env.E2E_EMAIL;
const E2E_PASSWORD = process.env.E2E_PASSWORD;

async function signInIfRequired(page: import("@playwright/test").Page) {
  if (!E2E_EMAIL || !E2E_PASSWORD) return;
  await page.goto("/login");
  // Already signed in from a previous run: the guard bounces straight back to practice.
  if (
    !(await page
      .getByLabel("Email")
      .isVisible({ timeout: 3000 })
      .catch(() => false))
  )
    return;
  await page.getByLabel("Email").fill(E2E_EMAIL);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/(?!login)/, { timeout: 15_000 });
}

test("practice serves a problem -> solve -> live verdict -> practice serves next -> progress reflects it", async ({
  page,
}) => {
  await signInIfRequired(page);

  await page.goto("/");

  // Practice's entry point into the workspace. "Work through it" rather than "Start" when the
  // server decided to teach this one instead of testing it (Practice.tsx) — either is a valid way
  // in, and which one appears depends on the account's history, so accept both.
  const startLink = page.getByRole("link", { name: /^(Start|Work through it)$/ }).first();
  await expect(startLink).toBeVisible({ timeout: 20_000 });
  await startLink.click();
  await expect(page).toHaveURL(/\/problem\//);

  // Not keyboard.type(): Monaco's own smart-indent rewrites whatever we type as we type it (an
  // auto-inserted indent after `:` collides with our own leading whitespace, corrupting the
  // program), and simulated Cmd/Ctrl+A here selects only the current line rather than the whole
  // buffer. Driving the model directly is the standard workaround and exercises the same
  // onChange path a real paste would.
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await page.evaluate((code) => {
    const monaco = (window as any).monaco;
    monaco.editor.getModels()[0].setValue(code);
  }, CORRECT_SOLUTION);

  await page.getByRole("button", { name: "Submit" }).click();

  // Live verdict, delivered over SSE without a reload (QA-PLAN.md §1.1 — the exact P0 this test
  // is named for: a live verdict that never reached the client, only visible after a manual
  // refresh, would time out here instead). With auth on, this also proves the SSE stream's
  // query-parameter token is accepted, since EventSource cannot send a header.
  //
  // Arriving at the submissions panel is itself part of the assertion: Problem.tsx switches the
  // left tab to "submissions" when a verdict lands, so if the event never reached the client the
  // panel stays hidden behind the problem tab and this times out.
  const submissionsPanel = page.locator('[data-testid="submissions-panel"]');
  await expect(submissionsPanel).toBeVisible({ timeout: 30_000 });
  await expect(submissionsPanel.getByText(/accepted/i).first()).toBeVisible({ timeout: 10_000 });

  // Practice must have something to say afterwards — either the next problem, or a visible
  // "generating" state. What it must NOT do is dead-end.
  await page.goto("/");
  await expect(
    page
      .getByRole("link", { name: /^(Start|Work through it)$/ })
      .or(page.getByText(/Writing you a new problem/i))
      .first(),
  ).toBeVisible({ timeout: 20_000 });

  // And Progress must reflect the solve — at least one concept now shows a non-default rating
  // badge instead of "No submissions yet" (QA-PLAN.md §1.4).
  await page.goto("/progress");
  await expect(page.getByText(/no submissions yet/i)).not.toBeVisible();
  await expect(page.getByText(/attempts?/).first()).toBeVisible({ timeout: 15_000 });
});
