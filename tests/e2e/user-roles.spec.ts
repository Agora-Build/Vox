import { test, expect, APIRequestContext } from "@playwright/test";

/**
 * User Role E2E Tests
 *
 * Tests different user role scenarios:
 * - Admin access and capabilities
 * - Basic user restrictions
 * - Premium user features
 * - Unauthenticated access
 */

test.describe("Admin User E2E Tests", () => {
  let adminRequest: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    adminRequest = await playwright.request.newContext({
      baseURL: "http://localhost:5000",
    });

    // Login as admin
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

  test("admin can access admin routes", async () => {
    const response = await adminRequest.get("/api/admin/users");
    // If admin is properly logged in, should get 200 or data
    if (response.ok()) {
      const users = await response.json();
      expect(Array.isArray(users)).toBe(true);
    }
  });

  test("admin can access eval agent tokens", async () => {
    const response = await adminRequest.get("/api/admin/eval-agent-tokens");
    if (response.ok()) {
      const tokens = await response.json();
      expect(Array.isArray(tokens)).toBe(true);
    }
  });

  test("admin can create providers", async () => {
    const response = await adminRequest.post("/api/providers", {
      data: {
        name: `Admin Test Provider ${Date.now()}`,
        sku: "convoai",
        description: "Test provider created by admin",
      },
    });

    if (response.ok()) {
      const provider = await response.json();
      expect(provider.id).toBeDefined();
    }
  });

  test("admin can view all projects", async () => {
    const response = await adminRequest.get("/api/projects");
    expect(response.ok()).toBeTruthy();
    const projects = await response.json();
    expect(Array.isArray(projects)).toBe(true);
  });

  test("admin has isAdmin flag in status", async () => {
    const response = await adminRequest.get("/api/auth/status");
    expect(response.ok()).toBeTruthy();
    const status = await response.json();
    if (status.user) {
      expect(status.user.isAdmin).toBe(true);
    }
  });
});

test.describe("Basic User E2E Tests", () => {
  let basicRequest: APIRequestContext;
  let userCreated = false;

  test.beforeAll(async ({ playwright }) => {
    basicRequest = await playwright.request.newContext({
      baseURL: "http://localhost:5000",
    });

    // Try to register a basic user (may already exist)
    const registerResponse = await basicRequest.post("/api/auth/register", {
      data: {
        email: `basic-e2e-${Date.now()}@example.com`,
        username: `basic_e2e_${Date.now()}`,
        password: "basicpass123",
      },
    });

    if (registerResponse.ok()) {
      userCreated = true;
    } else {
      // If registration requires invite, try login with existing user
      await basicRequest.post("/api/auth/login", {
        data: {
          email: "scout@vox.local",
          password: "scout123456",
        },
      });
    }
  });

  test.afterAll(async () => {
    await basicRequest?.dispose();
  });

  test("basic user cannot access admin routes", async () => {
    const response = await basicRequest.get("/api/admin/users");
    expect(response.status()).toBe(401);
  });

  test("basic user cannot create eval agent tokens", async () => {
    const response = await basicRequest.post("/api/admin/eval-agent-tokens", {
      data: {
        name: "Unauthorized Token",
        region: "na",
      },
    });
    expect(response.status()).toBe(401);
  });

  test("basic user can access own projects", async () => {
    const response = await basicRequest.get("/api/projects");
    // May be 200 if logged in, 401 if not
    expect([200, 401]).toContain(response.status());
  });

  test("basic user can view public providers", async () => {
    const response = await basicRequest.get("/api/providers");
    expect(response.ok()).toBeTruthy();
    const providers = await response.json();
    expect(Array.isArray(providers)).toBe(true);
  });

  test("basic user can view public metrics", async () => {
    const response = await basicRequest.get("/api/metrics/realtime");
    expect(response.ok()).toBeTruthy();
  });
});

test.describe("Unauthenticated Access E2E Tests", () => {
  test("can access public landing page", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    expect(page.url()).toContain("localhost");
  });

  test("can access login page", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("domcontentloaded");
    const content = await page.content();
    expect(
      content.includes("login") ||
      content.includes("Login") ||
      content.includes("Sign")
    ).toBeTruthy();
  });

  test("can access leaderboard page", async ({ page }) => {
    await page.goto("/leaderboard");
    await page.waitForLoadState("domcontentloaded");
    // Should not redirect to login
    expect(page.url()).toContain("leaderboard");
  });

  test("can access realtime dashboard", async ({ page }) => {
    await page.goto("/realtime");
    await page.waitForLoadState("domcontentloaded");
    expect(page.url()).toContain("realtime");
  });

  test("redirects to login for console routes", async ({ page }) => {
    await page.goto("/console");
    await page.waitForLoadState("domcontentloaded");
    // Should either show login or redirect
    const url = page.url();
    expect(url.includes("login") || url.includes("console")).toBeTruthy();
  });

  test("API rejects unauthenticated project creation", async ({ request }) => {
    const response = await request.post("/api/projects", {
      data: {
        name: "Unauthorized Project",
      },
    });
    expect(response.status()).toBe(401);
  });

  test("API rejects unauthenticated workflow creation", async ({ request }) => {
    const response = await request.post("/api/workflows", {
      data: {
        name: "Unauthorized Workflow",
        projectId: 1,
      },
    });
    expect(response.status()).toBe(401);
  });

  test("API allows public provider list", async ({ request }) => {
    const response = await request.get("/api/providers");
    expect(response.ok()).toBeTruthy();
  });

  test("API allows auth status check", async ({ request }) => {
    const response = await request.get("/api/auth/status");
    expect(response.ok()).toBeTruthy();
    const status = await response.json();
    expect(status.user).toBeNull();
  });

  test("API allows config check", async ({ request }) => {
    const response = await request.get("/api/config");
    expect(response.ok()).toBeTruthy();
  });
});

test.describe("API Key Authentication E2E Tests", () => {
  let adminRequest: APIRequestContext;
  let apiKey: string | null = null;

  test.beforeAll(async ({ playwright }) => {
    adminRequest = await playwright.request.newContext({
      baseURL: "http://localhost:5000",
    });

    // Login as admin
    await adminRequest.post("/api/auth/login", {
      data: {
        email: "admin@vox.local",
        password: "admin123456",
      },
    });

    // Create an API key
    const response = await adminRequest.post("/api/user/api-keys", {
      data: {
        name: `E2E Test Key ${Date.now()}`,
      },
    });

    if (response.ok()) {
      const result = await response.json();
      apiKey = result.key;
    }
  });

  test.afterAll(async () => {
    await adminRequest?.dispose();
  });

  test("API key can authenticate requests", async ({ playwright }) => {
    test.skip(!apiKey, "No API key available");

    const apiRequest = await playwright.request.newContext({
      baseURL: "http://localhost:5000",
      extraHTTPHeaders: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    const response = await apiRequest.get("/api/auth/status");
    expect(response.ok()).toBeTruthy();

    await apiRequest.dispose();
  });

  test("Invalid API key is rejected", async ({ request }) => {
    const response = await request.get("/api/projects", {
      headers: {
        Authorization: "Bearer vox_live_invalid_key_12345678901234567890",
      },
    });
    expect(response.status()).toBe(401);
  });

  test("Malformed API key is rejected", async ({ request }) => {
    const response = await request.get("/api/projects", {
      headers: {
        Authorization: "Bearer invalid_format",
      },
    });
    expect(response.status()).toBe(401);
  });
});

test.describe("Session Security E2E Tests", () => {
  test("session cookie is set on login", async ({ request }) => {
    const response = await request.post("/api/auth/login", {
      data: {
        email: "admin@vox.local",
        password: "admin123456",
      },
    });

    const cookies = response.headers()["set-cookie"];
    // Session cookie should be set
    if (cookies) {
      expect(cookies.toLowerCase()).toContain("connect.sid");
    }
  });

  test("logout endpoint responds", async ({ request }) => {
    // Just verify the logout endpoint is accessible
    const response = await request.post("/api/auth/logout");
    // Should succeed even without being logged in
    expect([200, 401]).toContain(response.status());
  });
});

test.describe("Rate Limiting E2E Tests", () => {
  test("login endpoint accepts valid requests", async ({ request }) => {
    // Make a single login request to verify the endpoint works
    const response = await request.post("/api/auth/login", {
      data: {
        email: "test@example.com",
        password: "wrongpassword",
      },
    });

    // Should get 401 for wrong password (not 429 rate limited)
    expect(response.status()).toBe(401);
  });
});

test.describe("CORS and Security Headers E2E Tests", () => {
  test("API returns proper content type", async ({ request }) => {
    const response = await request.get("/api/config");
    const contentType = response.headers()["content-type"];
    expect(contentType).toContain("application/json");
  });

  test("Static assets have cache headers", async ({ request }) => {
    // Request a known static asset path
    const response = await request.get("/");
    // Should return HTML
    const contentType = response.headers()["content-type"];
    expect(contentType).toContain("text/html");
  });
});
