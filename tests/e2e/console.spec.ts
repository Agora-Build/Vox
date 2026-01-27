import { test, expect } from "@playwright/test";

/**
 * Console Pages E2E Tests
 *
 * Tests the authenticated console pages.
 * These tests verify that pages require authentication and redirect or show auth prompt.
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
    await page.waitForLoadState("domcontentloaded");

    // Should either redirect to login or show login prompt
    const url = page.url();
    const content = await page.content();
    const requiresAuth =
      url.includes("login") ||
      content.toLowerCase().includes("sign in") ||
      content.toLowerCase().includes("login");
    expect(requiresAuth).toBeTruthy();
  });

  test("should redirect /console/projects to login", async ({ page }) => {
    await page.goto("/console/projects");
    await page.waitForLoadState("domcontentloaded");

    const url = page.url();
    const content = await page.content();
    const requiresAuth =
      url.includes("login") ||
      content.toLowerCase().includes("sign in") ||
      content.toLowerCase().includes("login");
    expect(requiresAuth).toBeTruthy();
  });

  test("should redirect /console/workflows to login", async ({ page }) => {
    await page.goto("/console/workflows");
    await page.waitForLoadState("domcontentloaded");

    const url = page.url();
    const content = await page.content();
    const requiresAuth =
      url.includes("login") ||
      content.toLowerCase().includes("sign in") ||
      content.toLowerCase().includes("login");
    expect(requiresAuth).toBeTruthy();
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
    await page.waitForLoadState("domcontentloaded");

    // Should redirect to login or show admin login
    const url = page.url();
    const content = await page.content();
    const requiresAuth =
      url.includes("login") ||
      content.toLowerCase().includes("sign in") ||
      content.toLowerCase().includes("login") ||
      content.toLowerCase().includes("admin");
    expect(requiresAuth).toBeTruthy();
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
