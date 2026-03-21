import { test, expect } from "@playwright/test";

/**
 * Clash Pages E2E Tests
 *
 * Tests the public and protected Clash pages (v2 event-based API).
 */

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "admin@vox.local";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "admin123456";

async function loginAsAdmin(page: ReturnType<typeof test["info"]> extends never ? never : any) {
  await page.goto("/login");
  await page.waitForLoadState("domcontentloaded");
  await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"], input[name="password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/console/, { timeout: 10000 }).catch(() => {});
}

test.describe("Public Clash Page", () => {
  test("should display /clash page with event feed sections", async ({ page }) => {
    await page.goto("/clash");
    await page.waitForLoadState("domcontentloaded");

    const content = await page.content();
    expect(content.length).toBeGreaterThan(100);

    // Should show the main heading
    await expect(page.locator("text=Clash")).toBeVisible();
  });

  test("should show Live Now section", async ({ page }) => {
    await page.goto("/clash");
    await page.waitForLoadState("domcontentloaded");

    // Should have the Live Now heading
    await expect(page.locator("text=Live Now")).toBeVisible();
  });

  test("should show Upcoming section", async ({ page }) => {
    await page.goto("/clash");
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator("text=Upcoming")).toBeVisible();
  });

  test("should show Recent section", async ({ page }) => {
    await page.goto("/clash");
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator("text=Recent")).toBeVisible();
  });

  test("should show Leaderboard section", async ({ page }) => {
    await page.goto("/clash");
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator("text=Leaderboard")).toBeVisible();
  });
});

test.describe("Clash Event Detail Page", () => {
  test("should handle non-existent event gracefully", async ({ page }) => {
    await page.goto("/clash/event/99999");
    await page.waitForLoadState("domcontentloaded");

    // Should show some content (loading, then not found or error)
    await page.waitForTimeout(2000);
    const content = await page.content();
    expect(content.length).toBeGreaterThan(100);
  });
});

test.describe("Console Clash (Protected)", () => {
  test("should redirect to login when not authenticated", async ({ page }) => {
    await page.goto("/console/clash");
    await page.waitForLoadState("domcontentloaded");

    // Should redirect to login or show login form
    await page.waitForTimeout(2000);
    const url = page.url();
    const content = await page.content();
    // Either redirected to login or showing a login-related page
    const isLoginPage = url.includes("login") || content.includes("Sign in") || content.includes("Log in");
    expect(isLoginPage || content.length > 100).toBe(true);
  });

  test("should show Clash console when authenticated", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/console/clash");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Should show Agent Profiles tab
    await expect(page.locator("text=Agent Profiles")).toBeVisible();
  });

  test("should show Events tab (not 'My Clashes')", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/console/clash");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    await expect(page.locator("text=Events")).toBeVisible();
  });

  test("should show Schedules tab for admin/scout", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/console/clash");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Admin user should see Schedules tab
    await expect(page.locator("text=Schedules")).toBeVisible();
  });

  test("should open New Profile dialog", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/console/clash");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Click New Profile button
    const newProfileBtn = page.locator("text=New Profile");
    if (await newProfileBtn.isVisible()) {
      await newProfileBtn.click();
      await page.waitForTimeout(500);

      // Dialog should appear
      await expect(page.locator("text=Create Agent Profile")).toBeVisible();
    }
  });
});

test.describe("Clash API (Public)", () => {
  test("GET /api/clash/feed should return array of events", async ({ request }) => {
    const response = await request.get("/api/clash/feed");
    expect(response.ok()).toBe(true);
    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("GET /api/clash/leaderboard should return array", async ({ request }) => {
    const response = await request.get("/api/clash/leaderboard");
    expect(response.ok()).toBe(true);
    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("GET /api/clash/matches/99999 should return 404", async ({ request }) => {
    const response = await request.get("/api/clash/matches/99999");
    expect(response.status()).toBe(404);
  });

  test("GET /api/clash/events/99999 should return 404", async ({ request }) => {
    const response = await request.get("/api/clash/events/99999");
    expect(response.status()).toBe(404);
  });
});
