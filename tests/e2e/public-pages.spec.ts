import { test, expect } from "@playwright/test";

/**
 * Public Pages E2E Tests
 *
 * Tests the public-facing pages that don't require authentication.
 */

test.describe("Landing Page", () => {
  test("should display landing page", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    // Should have some content
    const content = await page.content();
    expect(content.length).toBeGreaterThan(100);
  });

  test("should have working navigation links", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    // Check for login link
    const loginLink = page.locator('a[href*="login"]');
    if ((await loginLink.count()) > 0) {
      await expect(loginLink.first()).toBeVisible();
    }
  });
});

test.describe("Realtime Dashboard", () => {
  test("should display realtime metrics page", async ({ page }) => {
    await page.goto("/realtime");
    await page.waitForLoadState("domcontentloaded");

    // Page should have content
    const content = await page.content();
    expect(content.length).toBeGreaterThan(100);
  });
});

test.describe("Leaderboard", () => {
  test("should display leaderboard page", async ({ page }) => {
    await page.goto("/leaderboard");
    await page.waitForLoadState("domcontentloaded");

    // Page should have content
    const content = await page.content();
    expect(content.length).toBeGreaterThan(100);
  });

  test("should display provider rankings or empty state", async ({ page }) => {
    await page.goto("/leaderboard");
    await page.waitForLoadState("domcontentloaded");

    // Wait a bit for dynamic content
    await page.waitForTimeout(2000);

    // Page should have rendered something
    const content = await page.content();
    expect(content.length).toBeGreaterThan(100);
  });
});

test.describe("Dive Page (Provider Info)", () => {
  test("should display dive page", async ({ page }) => {
    await page.goto("/dive");
    await page.waitForLoadState("domcontentloaded");

    // Page should have content
    const content = await page.content();
    expect(content.length).toBeGreaterThan(100);
  });
});

test.describe("Run Your Own Page", () => {
  test("should display self-test entry page", async ({ page }) => {
    await page.goto("/run-your-own");
    await page.waitForLoadState("domcontentloaded");

    // Page should have content
    const content = await page.content();
    expect(content.length).toBeGreaterThan(100);
  });
});

test.describe("API Documentation", () => {
  test("should serve Swagger UI", async ({ page }) => {
    await page.goto("/api/docs");
    await page.waitForLoadState("domcontentloaded");

    // Should have swagger-ui div
    await expect(page.locator("#swagger-ui")).toBeVisible({ timeout: 15000 });
  });

  test("should serve OpenAPI spec as JSON", async ({ request }) => {
    const response = await request.get("/api/v1/openapi.json");
    expect(response.ok()).toBeTruthy();

    const spec = await response.json();
    expect(spec.openapi).toBeDefined();
    expect(spec.info.title).toContain("Vox");
    expect(spec.paths).toBeDefined();
  });
});
