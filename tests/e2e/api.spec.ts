import { test, expect } from "@playwright/test";

/**
 * API E2E Tests
 *
 * Tests the public API endpoints that don't require authentication.
 */

test.describe("Public API Endpoints", () => {
  test("GET /api/v1/providers - should list providers", async ({ request }) => {
    const response = await request.get("/api/v1/providers");
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBeTruthy();
    expect(body.meta.total).toBeGreaterThanOrEqual(0);
  });

  test("GET /api/v1/metrics/realtime - should return realtime metrics", async ({
    request,
  }) => {
    const response = await request.get("/api/v1/metrics/realtime");
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBeTruthy();
    expect(body.meta.timestamp).toBeDefined();
  });

  test("GET /api/v1/metrics/leaderboard - should return leaderboard", async ({
    request,
  }) => {
    const response = await request.get("/api/v1/metrics/leaderboard");
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBeTruthy();
    expect(body.meta.timestamp).toBeDefined();
    expect(body.meta.region).toBeDefined();
  });

  test("GET /api/v1/metrics/leaderboard?region=na - should filter by region", async ({
    request,
  }) => {
    const response = await request.get("/api/v1/metrics/leaderboard?region=na");
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.meta.region).toBe("na");
  });
});

test.describe("Auth Status API", () => {
  test("GET /api/auth/status - should return auth status", async ({
    request,
  }) => {
    const response = await request.get("/api/auth/status");
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.initialized).toBeDefined();
    expect(typeof body.initialized).toBe("boolean");
    // user can be null if not logged in
  });
});

test.describe("Protected API Endpoints (Unauthorized)", () => {
  test("GET /api/v1/workflows - should require auth", async ({ request }) => {
    const response = await request.get("/api/v1/workflows");
    expect(response.status()).toBe(401);

    const body = await response.json();
    expect(body.error).toBeDefined();
  });

  test("GET /api/v1/user - should require auth", async ({ request }) => {
    const response = await request.get("/api/v1/user");
    expect(response.status()).toBe(401);

    const body = await response.json();
    expect(body.error).toBeDefined();
  });

  test("POST /api/v1/workflows - should require auth", async ({ request }) => {
    const response = await request.post("/api/v1/workflows", {
      data: { name: "Test Workflow" },
    });
    expect(response.status()).toBe(401);
  });

  test("GET /api/v1/jobs - should require auth", async ({ request }) => {
    const response = await request.get("/api/v1/jobs");
    expect(response.status()).toBe(401);
  });

  test("GET /api/v1/results - should require auth", async ({ request }) => {
    const response = await request.get("/api/v1/results");
    expect(response.status()).toBe(401);
  });

  test("GET /api/v1/projects - should require auth", async ({ request }) => {
    const response = await request.get("/api/v1/projects");
    expect(response.status()).toBe(401);
  });

  test("GET /api/v1/eval-sets - should require auth", async ({ request }) => {
    const response = await request.get("/api/v1/eval-sets");
    expect(response.status()).toBe(401);
  });
});

test.describe("Stripe Configuration", () => {
  test("GET /api/payments/stripe-config - should return stripe status", async ({
    request,
  }) => {
    const response = await request.get("/api/payments/stripe-config");
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(typeof body.enabled).toBe("boolean");
    // publishableKey can be null if Stripe is not configured
  });
});

test.describe("System Configuration", () => {
  test("GET /api/config - should return system config", async ({ request }) => {
    const response = await request.get("/api/config");
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    // Should return some configuration (may vary based on setup)
    expect(body).toBeDefined();
  });

  test("GET /api/auth/google/status - should return OAuth status", async ({
    request,
  }) => {
    const response = await request.get("/api/auth/google/status");
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(typeof body.enabled).toBe("boolean");
  });
});

test.describe("Rate Limiting", () => {
  test("should not rate limit normal requests", async ({ request }) => {
    // Make a few requests in quick succession
    const responses = await Promise.all([
      request.get("/api/v1/providers"),
      request.get("/api/v1/providers"),
      request.get("/api/v1/providers"),
    ]);

    // All should succeed
    responses.forEach((response) => {
      expect(response.ok()).toBeTruthy();
    });
  });
});
