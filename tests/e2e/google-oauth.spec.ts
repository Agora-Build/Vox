import { test, expect } from "@playwright/test";

/**
 * Google OAuth E2E Tests
 *
 * Tests provider configuration, the login button, and Vox's OAuth redirect.
 * Completing a real Google login remains a separate manual check.
 */

// Test credentials from environment (set in .env.dev.data for local testing)
// These are used by skipped tests that require manual verification
const GOOGLE_EMAIL = process.env.GOOGLE_TEST_EMAIL || "test@example.com";
const GOOGLE_PASSWORD = process.env.GOOGLE_TEST_PASSWORD || "";

test.describe("Google OAuth Integration", () => {
  test.beforeEach(async ({ page }) => {
    // Clear cookies to ensure fresh state
    await page.context().clearCookies();
  });

  test("should show Google OAuth is enabled", async ({ request }) => {
    const response = await request.get("/api/plugins/oauth/providers");
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.google).toBe(true);
  });

  test("should have Google sign-in button on login page", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("domcontentloaded");

    // Look for Google sign-in button
    const googleButton = page.locator(
      'button:has-text("Google"), a:has-text("Google"), [data-testid="google-signin"]'
    );
    await expect(googleButton.first()).toBeVisible({ timeout: 10000 });
  });

  test("should redirect to Google OAuth when clicking sign-in", async ({
    page,
  }) => {
    // Exercise Vox's real redirect, not Google's network/login availability.
    await page.route("https://accounts.google.com/**", (route) => route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>OAuth authorization destination</title>",
    }));
    await page.goto("/login");
    await page.waitForLoadState("domcontentloaded");

    // Click Google sign-in button
    const googleButton = page.locator(
      'button:has-text("Google"), a:has-text("Google"), a[href*="google"]'
    );
    const authorizationRequest = page.waitForRequest("https://accounts.google.com/**");
    await googleButton.first().click();

    // A redirected request proves the browser followed Vox's Location header;
    // waiting for Google's document to load would reintroduce a network dependency.
    const url = new URL((await authorizationRequest).url());
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{48}$/);
    expect(url.searchParams.get("client_id")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/api\/plugins\/oauth\/google\/callback$/);
  });

  test.skip("should complete full Google OAuth flow", async ({ page }) => {
    // SKIPPED: Google blocks automated logins from Playwright/headless browsers
    // with "This browser or app may not be secure" security measure.
    // This test requires manual verification.
    //
    // To manually test:
    // 1. Start server with Google OAuth configured
    // 2. Navigate to /login in a real browser
    // 3. Click "Sign in with Google"
    // 4. Complete Google sign-in with test credentials
    // 5. Verify redirect back to app with authenticated session
    test.setTimeout(120000);

    await page.goto("/login");
    await page.waitForLoadState("domcontentloaded");

    const googleButton = page.locator(
      'button:has-text("Google"), a:has-text("Google"), a[href*="google"]'
    );
    await googleButton.first().click();

    await page.waitForURL(/accounts\.google\.com|google\.com/, {
      timeout: 15000,
    });

    const emailInput = page.locator('input[type="email"]');
    await emailInput.waitFor({ state: "visible", timeout: 10000 });
    await emailInput.fill(GOOGLE_EMAIL);

    const nextButton = page.locator("#identifierNext");
    await nextButton.click();

    const passwordInput = page.locator('input[type="password"]');
    await passwordInput.waitFor({ state: "visible", timeout: 10000 });
    await passwordInput.fill(GOOGLE_PASSWORD);

    const passwordNext = page.locator("#passwordNext");
    await passwordNext.click();

    try {
      const continueButton = page.locator(
        'button:has-text("Continue"), button:has-text("Allow")'
      );
      if (await continueButton.isVisible({ timeout: 5000 })) {
        await continueButton.click();
      }
    } catch {
      // No consent screen
    }

    await page.waitForURL(/localhost:5000/, { timeout: 30000 });

    const response = await page.request.get("/api/auth/status");
    const body = await response.json();

    expect(body.user).toBeDefined();
    expect(body.user.email).toBe(GOOGLE_EMAIL);
  });

  test.skip("should link Google account to existing user", async ({ page }) => {
    // SKIPPED: Google blocks automated logins from Playwright/headless browsers
    // with "This browser or app may not be secure" security measure.
    // This test requires manual verification.
    //
    // To manually test:
    // 1. Register a local account with the same email as Google account
    // 2. Sign in with Google
    // 3. Verify accounts are linked
    test.setTimeout(120000);

    const registerResponse = await page.request.post("/api/auth/register", {
      data: {
        email: GOOGLE_EMAIL,
        password: "localpassword123",
        username: "GoogleTestUser",
      },
    });

    await page.goto("/login");
    await page.waitForLoadState("domcontentloaded");

    const googleButton = page.locator(
      'button:has-text("Google"), a:has-text("Google"), a[href*="google"]'
    );

    if ((await googleButton.count()) > 0) {
      await googleButton.first().click();

      await page.waitForURL(/accounts\.google\.com|google\.com/, {
        timeout: 15000,
      });

      const emailInput = page.locator('input[type="email"]');
      await emailInput.waitFor({ state: "visible", timeout: 10000 });
      await emailInput.fill(GOOGLE_EMAIL);

      const nextButton = page.locator("#identifierNext");
      await nextButton.click();

      const passwordInput = page.locator('input[type="password"]');
      await passwordInput.waitFor({ state: "visible", timeout: 10000 });
      await passwordInput.fill(GOOGLE_PASSWORD);

      const passwordNext = page.locator("#passwordNext");
      await passwordNext.click();

      try {
        const continueButton = page.locator(
          'button:has-text("Continue"), button:has-text("Allow")'
        );
        if (await continueButton.isVisible({ timeout: 5000 })) {
          await continueButton.click();
        }
      } catch {
        // No consent screen
      }

      await page.waitForURL(/localhost:5000/, { timeout: 30000 });

      const response = await page.request.get("/api/auth/status");
      const body = await response.json();
      expect(body.user).toBeDefined();
    }
  });
});
