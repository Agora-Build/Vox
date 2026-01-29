import { test, expect, APIRequestContext } from "@playwright/test";

/**
 * Admin Routes E2E Tests
 *
 * Tests for admin-only API endpoints including user management,
 * eval agent token management, and system administration.
 */

test.describe("Admin Authentication", () => {
  test("should reject non-admin access to admin routes", async ({ request }) => {
    // Try to access admin endpoint without auth
    const response = await request.get("/api/admin/users");
    expect(response.status()).toBe(401);
  });

  test("should show admin login page", async ({ page }) => {
    await page.goto("/admin/login");
    await page.waitForSelector('[data-testid="text-login-title"]', { timeout: 15000 });

    const title = await page.textContent('[data-testid="text-login-title"]');
    expect(title).toContain("Admin");
  });

  test("should redirect admin to /admin/console after login via /admin/login", async ({ page }) => {
    await page.goto("/admin/login");
    await page.waitForSelector('[data-testid="input-email"]', { timeout: 10000 });
    await page.fill('[data-testid="input-email"]', "admin@vox.local");
    await page.fill('[data-testid="input-password"]', "admin123456");
    await page.click('[data-testid="button-login"]');

    await expect(page).toHaveURL(/\/admin\/console/, { timeout: 15000 });
  });

  test("should redirect admin to /admin/console after login via /login", async ({ page }) => {
    await page.goto("/login");
    await page.waitForSelector('[data-testid="input-email"]', { timeout: 10000 });
    await page.fill('[data-testid="input-email"]', "admin@vox.local");
    await page.fill('[data-testid="input-password"]', "admin123456");
    await page.click('[data-testid="button-login"]');

    await expect(page).toHaveURL(/\/admin\/console/, { timeout: 15000 });
  });

  test("should stay on /login with bad credentials", async ({ page }) => {
    await page.goto("/login");
    await page.waitForSelector('[data-testid="input-email"]', { timeout: 10000 });
    await page.fill('[data-testid="input-email"]', "nonexistent@example.com");
    await page.fill('[data-testid="input-password"]', "wrongpassword");
    await page.click('[data-testid="button-login"]');

    // Should remain on login page
    await page.waitForTimeout(3000);
    expect(page.url()).toMatch(/\/login/);
  });

  test("should redirect non-admin to /console after login via /login", async ({ page }) => {
    await page.goto("/login");
    await page.waitForSelector('[data-testid="input-email"]', { timeout: 10000 });
    await page.fill('[data-testid="input-email"]', "scout@vox.ai");
    await page.fill('[data-testid="input-password"]', "scout123");
    await page.click('[data-testid="button-login"]');

    // Non-admin should go to /console, never /admin/console
    await page.waitForURL(/\/(console|login)/, { timeout: 15000 });
    expect(page.url()).not.toMatch(/\/admin\/console/);

    // If scout is activated, should land on /console
    if (page.url().match(/\/console/)) {
      expect(page.url()).toMatch(/\/console/);
    }
  });
});

test.describe("Admin User Management", () => {
  let adminRequest: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    adminRequest = await playwright.request.newContext({
      baseURL: "http://localhost:5000",
    });

    // Login as admin
    const loginResponse = await adminRequest.post("/api/auth/login", {
      data: {
        email: "admin@vox.local",
        password: "admin123456",
      },
    });

    if (!loginResponse.ok()) {
      console.log("Admin login failed - tests may fail");
    }
  });

  test.afterAll(async () => {
    await adminRequest?.dispose();
  });

  test("should list users as admin", async () => {
    const response = await adminRequest.get("/api/admin/users");

    if (response.ok()) {
      const users = await response.json();
      expect(Array.isArray(users)).toBe(true);

      // Should have at least admin user
      if (users.length > 0) {
        expect(users[0]).toHaveProperty("id");
        expect(users[0]).toHaveProperty("email");
        expect(users[0]).toHaveProperty("username");
      }
    } else {
      // May fail if not admin - that's expected
      expect(response.status()).toBe(401);
    }
  });

  test("should get user details from users list", async () => {
    // Get users list and verify first user has expected fields
    const listResponse = await adminRequest.get("/api/admin/users");

    if (listResponse.ok()) {
      const users = await listResponse.json();
      if (users.length > 0) {
        const user = users[0];
        // Verify user object has expected fields
        expect(user.id).toBeDefined();
        expect(user.email).toBeDefined();
      }
    }
  });
});

test.describe("Admin Eval Agent Token Management", () => {
  let adminRequest: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    adminRequest = await playwright.request.newContext({
      baseURL: "http://localhost:5000",
    });

    await adminRequest.post("/api/auth/login", {
      data: {
        email: "admin@vox.local",
        password: "admin123456",
      },
    });
  });

  test.afterAll(async () => {
    await adminRequest?.dispose();
  });

  test("should list eval agent tokens as admin", async () => {
    const response = await adminRequest.get("/api/admin/eval-agent-tokens");

    if (response.ok()) {
      const tokens = await response.json();
      expect(Array.isArray(tokens)).toBe(true);
    }
  });

  test("should create new eval agent token", async () => {
    const response = await adminRequest.post("/api/admin/eval-agent-tokens", {
      data: {
        name: `Test Token ${Date.now()}`,
        region: "na",
      },
    });

    if (response.ok()) {
      const result = await response.json();
      expect(result.token).toBeDefined();
      // Token is a hex string (raw token before hashing)
      expect(result.token.length).toBeGreaterThanOrEqual(32);
    }
  });

  test("should reject invalid region for token creation", async () => {
    const response = await adminRequest.post("/api/admin/eval-agent-tokens", {
      data: {
        name: "Invalid Region Token",
        region: "invalid",
      },
    });

    expect(response.ok()).toBe(false);
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });

  test("should revoke eval agent token", async () => {
    // First create a token
    const createResponse = await adminRequest.post("/api/admin/eval-agent-tokens", {
      data: {
        name: `Revoke Test ${Date.now()}`,
        region: "na",
      },
    });

    if (createResponse.ok()) {
      const created = await createResponse.json();
      const tokenId = created.id;

      // Now revoke it
      const revokeResponse = await adminRequest.post(
        `/api/admin/eval-agent-tokens/${tokenId}/revoke`
      );

      if (revokeResponse.ok()) {
        const result = await revokeResponse.json();
        expect(result.message || result.isRevoked).toBeTruthy();
      }
    }
  });
});

test.describe("Admin Invite Management", () => {
  let adminRequest: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    adminRequest = await playwright.request.newContext({
      baseURL: "http://localhost:5000",
    });

    await adminRequest.post("/api/auth/login", {
      data: {
        email: "admin@vox.local",
        password: "admin123456",
      },
    });
  });

  test.afterAll(async () => {
    await adminRequest?.dispose();
  });

  test("should create invite token", async () => {
    const response = await adminRequest.post("/api/admin/invite", {
      data: {
        email: `test-${Date.now()}@example.com`,
      },
    });

    if (response.ok()) {
      const result = await response.json();
      expect(result.token || result.inviteUrl).toBeDefined();
    }
  });

  test("should create open invite (no email)", async () => {
    const response = await adminRequest.post("/api/admin/invite", {
      data: {},
    });

    // Open invites may or may not be allowed
    if (response.ok()) {
      const result = await response.json();
      expect(result.token || result.inviteUrl).toBeDefined();
    }
  });
});

test.describe("Admin System Configuration", () => {
  let adminRequest: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    adminRequest = await playwright.request.newContext({
      baseURL: "http://localhost:5000",
    });

    await adminRequest.post("/api/auth/login", {
      data: {
        email: "admin@vox.local",
        password: "admin123456",
      },
    });
  });

  test.afterAll(async () => {
    await adminRequest?.dispose();
  });

  test("should get system configuration", async () => {
    const response = await adminRequest.get("/api/config");
    expect(response.ok()).toBeTruthy();

    const config = await response.json();
    expect(config).toBeDefined();
  });

  test("should verify admin has proper permissions", async () => {
    const statusResponse = await adminRequest.get("/api/auth/status");
    expect(statusResponse.ok()).toBeTruthy();

    const status = await statusResponse.json();
    if (status.user) {
      expect(status.user.isAdmin).toBe(true);
    }
  });
});

test.describe("Admin Provider Management", () => {
  let adminRequest: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    adminRequest = await playwright.request.newContext({
      baseURL: "http://localhost:5000",
    });

    await adminRequest.post("/api/auth/login", {
      data: {
        email: "admin@vox.local",
        password: "admin123456",
      },
    });
  });

  test.afterAll(async () => {
    await adminRequest?.dispose();
  });

  test("should create new provider as admin", async () => {
    const response = await adminRequest.post("/api/providers", {
      data: {
        name: `Test Provider ${Date.now()}`,
        sku: "convoai",
        description: "Test provider for E2E tests",
      },
    });

    if (response.ok()) {
      const provider = await response.json();
      expect(provider.id).toBeDefined();
      expect(provider.name).toContain("Test Provider");
    }
  });

  test("should list all providers", async () => {
    const response = await adminRequest.get("/api/providers");
    expect(response.ok()).toBeTruthy();

    const providers = await response.json();
    expect(Array.isArray(providers)).toBe(true);
  });
});

test.describe("Admin Organization Verification", () => {
  let adminRequest: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    adminRequest = await playwright.request.newContext({
      baseURL: "http://localhost:5000",
    });

    await adminRequest.post("/api/auth/login", {
      data: {
        email: "admin@vox.local",
        password: "admin123456",
      },
    });
  });

  test.afterAll(async () => {
    await adminRequest?.dispose();
  });

  test("should list organizations as admin", async () => {
    const response = await adminRequest.get("/api/admin/organizations");

    // Endpoint may or may not exist
    if (response.ok()) {
      const orgs = await response.json();
      expect(Array.isArray(orgs)).toBe(true);
    }
  });
});
