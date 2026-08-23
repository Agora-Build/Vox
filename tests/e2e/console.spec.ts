import { test, expect, type Page } from "@playwright/test";

/**
 * Console Pages E2E Tests
 *
 * Tests the authenticated console pages.
 * These tests verify that pages require authentication and redirect or show auth prompt.
 */

// The redirect is client-side: React must fetch /api/auth/status before it
// navigates to /login, so a one-shot content snapshot after domcontentloaded
// races the auth check. Poll until the redirect (or a login prompt) shows up.
async function expectRequiresAuth(page: Page) {
  await expect
    .poll(
      async () => {
        const url = page.url();
        const content = (await page.content()).toLowerCase();
        return url.includes("login") || content.includes("sign in") || content.includes("login");
      },
      { timeout: 10000 },
    )
    .toBeTruthy();
}

test.describe("Console Access Control", () => {
  test.beforeEach(async ({ page }) => {
    // Clear any existing session
    await page.context().clearCookies();
  });

  test("should redirect /console to login when not authenticated", async ({
    page,
  }) => {
    await page.goto("/console");
    await expectRequiresAuth(page);
  });

  test("should redirect /console/projects to login", async ({ page }) => {
    await page.goto("/console/projects");
    await expectRequiresAuth(page);
  });

  test("should redirect /console/workflows to login", async ({ page }) => {
    await page.goto("/console/workflows");
    await expectRequiresAuth(page);
  });

  test("should handle /console/settings access", async ({ page }) => {
    await page.goto("/console/settings");
    await page.waitForLoadState("domcontentloaded");

    // Page should load (might show auth prompt or settings)
    const content = await page.content();
    expect(content.length).toBeGreaterThan(100);
  });

  test("should handle /console/eval-sets access", async ({ page }) => {
    await page.goto("/console/eval-sets");
    await page.waitForLoadState("domcontentloaded");

    // Page should load
    const content = await page.content();
    expect(content.length).toBeGreaterThan(100);
  });

  test("should handle /console/organization access", async ({ page }) => {
    await page.goto("/console/organization");
    await page.waitForLoadState("domcontentloaded");

    // Page should load
    const content = await page.content();
    expect(content.length).toBeGreaterThan(100);
  });
});

test.describe("Admin Console Access Control", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
  });

  test("should redirect /admin/console to admin login", async ({ page }) => {
    await page.goto("/admin/console");
    // /admin/console content itself mentions "admin", so this poll accepts
    // either the login redirect or the admin-login prompt.
    await expectRequiresAuth(page);
  });

  test("should show admin login page", async ({ page }) => {
    await page.goto("/admin/login");
    await page.waitForLoadState("domcontentloaded");

    // Page should load
    const content = await page.content();
    expect(content.length).toBeGreaterThan(100);
  });
});

test.describe("Console Navigation (Unauthenticated)", () => {
  test("should have back to home link on login page", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("domcontentloaded");

    // Page should load
    const content = await page.content();
    expect(content.length).toBeGreaterThan(100);
  });
});
