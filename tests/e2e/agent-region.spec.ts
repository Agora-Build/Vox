import { test, expect } from "@playwright/test";

// Zero-trust region: the mint dialog must not offer a region for non-public
// tiers (server rejects it anyway — the UI never offers what would 400).
// No token is actually minted: dialog-only, zero DB pollution.
test.describe("eval-agent token mint dialog", () => {
  // Two full page loads (login, then /console/eval-agents) before the first
  // assertion, each paying the Vite dev server's on-demand transform for
  // routes nothing has hit yet. The APIs behind this page answer in under
  // 100ms; the time is all first-hit compilation. That put the run at ~24s of
  // a 30s budget in isolation and over it whenever the suite ran 4-wide —
  // which is why this was on the "known flakes" list. Budget for the work.
  test.setTimeout(90_000);

  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("domcontentloaded");
    await page.fill('input[type="email"], input[name="email"], input[placeholder*="email" i]', "admin@vox.local");
    await page.fill('input[type="password"]', "admin123456");
    await page.click('button[type="submit"]');
    // The naive /console|\// regex matches "/login" itself (every path has a
    // slash) so it never actually waits for the post-login redirect — wait
    // for the URL to leave /login instead.
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 10000 });
    await page.goto("/console/eval-agents");
    await page.waitForLoadState("domcontentloaded");
  });

  test("non-public tier hides the region picker and explains auto-detection", async ({ page }) => {
    // Open the create-token dialog (only the DialogTrigger matches "Create Agent" before it opens).
    await page.getByRole("button", { name: "Create Agent" }).first().click();
    const dialog = page.getByRole("dialog");

    // Admin's default tier is public → region ("City") picker visible, no auto-detect note.
    await expect(dialog.getByText("City").first()).toBeVisible();
    await expect(dialog.getByTestId("text-region-auto")).not.toBeVisible();

    // Switch tier to private via the dispatch-tier combobox (its value text reads "Public").
    await dialog.getByRole("combobox").filter({ hasText: /public/i }).click();
    await page.getByRole("option", { name: "Private" }).click();

    // Private tier → no region select, auto-detect explanation shown instead.
    await expect(dialog.getByTestId("text-region-auto")).toBeVisible();
    await expect(dialog.getByText("City").first()).not.toBeVisible();
  });
});
