import { expect, test } from "@playwright/test";

/**
 * Real-stack e2e smoke (QA-PLAN.md "Prevent recurrence" §2): diagnostic → workout item → solve →
 * live verdict visible → item completes → progress reflects it. Run against a REAL api + judge +
 * web (never the mock server) — see playwright.config.ts's header comment for how to bring that
 * stack up.
 *
 * The QA fixture pool's approved problems are all the same underlying problem ("Maximum Sum of a
 * Length-K Subarray") seeded multiple times across different concepts/rating bands, so a single
 * hardcoded correct solution below covers whichever one the diagnostic picks.
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

test("diagnostic -> solve -> live verdict -> item completes -> progress reflects it", async ({ page }) => {
  await page.goto("/diagnostic");

  // Idempotent against whatever state this account is already in: a fresh account sees the
  // "Start diagnostic" prompt; an account with an already-active diagnostic (e.g. a previous
  // partial run of this same test) sees the ladder directly. Either way, end up looking at the
  // ladder with an item to open.
  const startDiagnosticButton = page.getByRole("button", { name: "Start diagnostic" });
  if (await startDiagnosticButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await startDiagnosticButton.click();
    // Starting a diagnostic abandons any other active workout — confirm if that dialog appears.
    const abandonButton = page.getByRole("button", { name: "Abandon & start diagnostic" });
    if (await abandonButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await abandonButton.click();
    }
  }

  // The diagnostic's first not-yet-resolved item card, with a Start/Continue link into the
  // workspace — "Start" the first time, "Continue" if `?item=` already flipped it to active on a
  // prior visit (QA-PLAN.md §1.2).
  const startLink = page
    .getByRole("link")
    .filter({ has: page.getByRole("button", { name: /^(Start|Continue)$/ }) })
    .first();
  await expect(startLink).toBeVisible({ timeout: 15_000 });

  await startLink.click();
  await expect(page).toHaveURL(/\/problem\//);

  // Reaching the problem via ?item= must have transitioned the workout item to 'active'
  // (QA-PLAN.md §1.2) — confirmed by the diagnostic ladder showing it "in progress" once we go
  // back to check, done later in this test.

  // Not keyboard.type(): Monaco's own smart-indent rewrites whatever we type as we type it (an
  // auto-inserted indent after `:` collides with our own leading whitespace, corrupting the
  // program), and simulated Cmd/Ctrl+A here selects only the current line rather than the whole
  // buffer. Driving the model directly is the standard workaround and exercises the same
  // onChange path a real paste would.
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await page.evaluate((code) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const monaco = (window as any).monaco;
    monaco.editor.getModels()[0].setValue(code);
  }, CORRECT_SOLUTION);

  await page.getByRole("button", { name: "Submit" }).click();

  // Live verdict, delivered over SSE without a reload (QA-PLAN.md §1.1 — the exact P0 this test
  // is named for: a live verdict that never reached the client, only visible after a manual
  // refresh, would time out here instead).
  const verdictPanel = page.locator('[data-testid="verdict-panel"]');
  await expect(verdictPanel).toBeVisible({ timeout: 30_000 });
  await expect(verdictPanel.getByText(/accepted/i)).toBeVisible({ timeout: 10_000 });

  // The accepted verdict must complete the workout item (QA-PLAN.md §1.2) — go back to the
  // diagnostic and confirm the item that used to be "NOT STARTED" is now resolved.
  await page.goto("/diagnostic");
  await expect(page.locator("text=solved").first()).toBeVisible({ timeout: 15_000 });

  // And Progress must reflect it — at least one concept now shows a non-default rating badge
  // instead of "No submissions yet" (QA-PLAN.md §1.4).
  await page.goto("/progress");
  await expect(page.getByText(/no submissions yet/i)).not.toBeVisible();
  await expect(page.getByText(/attempts?/).first()).toBeVisible({ timeout: 15_000 });
});
