import { test, expect } from "@playwright/test";

/**
 * Public Pages E2E Tests
 *
 * Tests the public-facing pages that don't require authentication.
 */

test.describe("Landing Page", () => {
  test("should display landing page", async ({ page }) => {
    await page.goto("/");

    // Check for main content
    await expect(page.locator("body")).toBeVisible();

    // Should have navigation or header
    await expect(
      page.locator("nav, header, [role='navigation']").first()
    ).toBeVisible();
  });

  test("should have working navigation links", async ({ page }) => {
    await page.goto("/");

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

    // Page should load without errors
    await expect(page.locator("body")).toBeVisible();

    // Check for page content - either metrics data or a heading
    const hasContent =
      (await page.locator("h1, h2, [role='heading']").count()) > 0 ||
      (await page.locator("table, [role='table'], .chart, canvas").count()) > 0;
    expect(hasContent).toBeTruthy();
  });
});

test.describe("Leaderboard", () => {
  test("should display leaderboard page", async ({ page }) => {
    await page.goto("/leaderboard");

    // Page should load
    await expect(page.locator("body")).toBeVisible();

    // Should have some content indicating it's the leaderboard
    const pageContent = await page.content();
    const hasLeaderboardContent =
      pageContent.toLowerCase().includes("leaderboard") ||
      pageContent.toLowerCase().includes("ranking") ||
      pageContent.toLowerCase().includes("provider");
    expect(hasLeaderboardContent).toBeTruthy();
  });

  test("should display provider rankings", async ({ page }) => {
    await page.goto("/leaderboard");

    // Wait for content to load
    await page.waitForLoadState("networkidle");

    // Check if there's a table or list of rankings
    const hasRankings =
      (await page.locator("table, [role='table']").count()) > 0 ||
      (await page.locator("li, [role='listitem']").count()) > 0 ||
      (await page.locator(".card, [data-testid='ranking']").count()) > 0;

    // Leaderboard might be empty if no data exists
    expect(hasRankings || (await page.content()).includes("No data")).toBeTruthy();
  });
});

test.describe("Dive Page (Provider Info)", () => {
  test("should display dive page", async ({ page }) => {
    await page.goto("/dive");

    await expect(page.locator("body")).toBeVisible();

    // Page should load without errors
    await page.waitForLoadState("networkidle");
  });
});

test.describe("Run Your Own Page", () => {
  test("should display self-test entry page", async ({ page }) => {
    await page.goto("/run-your-own");

    await expect(page.locator("body")).toBeVisible();

    // Page should load without errors
    await page.waitForLoadState("networkidle");
  });
});

test.describe("API Documentation", () => {
  test("should serve Swagger UI", async ({ page }) => {
    await page.goto("/api/docs");

    // Should load Swagger UI
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
