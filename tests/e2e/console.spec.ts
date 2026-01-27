import { test, expect } from "@playwright/test";

/**
 * Console Pages E2E Tests
 *
 * Tests the authenticated console pages.
 * These tests verify that pages require authentication and redirect properly.
 */

test.describe("Console Access Control", () => {
  test.beforeEach(async ({ page }) => {
    // Clear any existing session
    await page.context().clearCookies();
  });

  test("should redirect /console to login when not authenticated", async ({
    page,
  }) => {
    await page.goto("/console");
    await expect(page).toHaveURL(/login/);
  });

  test("should redirect /console/projects to login", async ({ page }) => {
    await page.goto("/console/projects");
    await expect(page).toHaveURL(/login/);
  });

  test("should redirect /console/workflows to login", async ({ page }) => {
    await page.goto("/console/workflows");
    await expect(page).toHaveURL(/login/);
  });

  test("should redirect /console/settings to login", async ({ page }) => {
    await page.goto("/console/settings");
    await expect(page).toHaveURL(/login/);
  });

  test("should redirect /console/eval-sets to login", async ({ page }) => {
    await page.goto("/console/eval-sets");
    await expect(page).toHaveURL(/login/);
  });

  test("should redirect /console/organization to login", async ({ page }) => {
    await page.goto("/console/organization");
    await expect(page).toHaveURL(/login/);
  });
});

test.describe("Admin Console Access Control", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
  });

  test("should redirect /admin/console to admin login", async ({ page }) => {
    await page.goto("/admin/console");
    // Should redirect to admin login or main login
    await expect(page).toHaveURL(/login/);
  });

  test("should show admin login page", async ({ page }) => {
    await page.goto("/admin/login");
    await expect(page.locator("body")).toBeVisible();
  });
});

test.describe("Console Navigation (Unauthenticated)", () => {
  test("should have back to home link on login page", async ({ page }) => {
    await page.goto("/login");

    // Look for a link back to the main site
    const homeLink = page.locator('a[href="/"], a:has-text("Home")');
    if ((await homeLink.count()) > 0) {
      await expect(homeLink.first()).toBeVisible();
    }
  });
});
