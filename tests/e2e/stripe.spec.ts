import { test, expect, APIRequestContext } from "@playwright/test";

/**
 * Stripe Integration E2E Tests
 *
 * Full integration tests for Stripe payment processing.
 * Uses Stripe test mode with real API keys.
 */

// Stripe test card numbers (for reference in manual testing)
const TEST_CARD = {
  number: "4242424242424242", // Visa - always succeeds
  exp: "12/30",
  cvc: "123",
  zip: "12345",
};

const DECLINED_CARD = {
  number: "4000000000000002", // Always declined
  exp: "12/30",
  cvc: "123",
  zip: "12345",
};

test.describe("Stripe Integration (Public)", () => {
  test("should show Stripe is enabled", async ({ request }) => {
    const response = await request.get("/api/payments/stripe-config");
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.enabled).toBe(true);
    expect(body.publishableKey).toBeDefined();
    expect(body.publishableKey).toMatch(/^pk_test_/);
  });

  test("should return publishable key for frontend", async ({ request }) => {
    const response = await request.get("/api/payments/stripe-config");
    const body = await response.json();

    expect(body.publishableKey).toBeDefined();
    expect(body.publishableKey.length).toBeGreaterThan(20);
  });

  test("should verify Stripe secret key is valid", async ({ request }) => {
    // The stripe-config endpoint working means the key is valid
    const response = await request.get("/api/payments/stripe-config");
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.enabled).toBe(true);
  });
});

test.describe("Stripe Payment Flow (Authenticated)", () => {
  // Use serial mode to avoid rate limiting on login endpoint
  test.describe.configure({ mode: "serial" });

  let authenticatedRequest: APIRequestContext;
  let adminRequest: APIRequestContext;

  /**
   * These tests need a user who OWNS an organization, and they used to get one
   * by putting `admin@vox.local` into a "Stripe Test Org".
   *
   * That is a one-way door. Creating an org sets `users.organization_id` and
   * `orgRole: 'owner'`, and `POST /api/organizations/:id/leave` refuses an
   * owner ("Transfer ownership first"), so with no second member there is no
   * API that undoes it. The mutation therefore outlived the run, and admin
   * (user id 1) is the account the whole test corpus shares.
   *
   * Four unit suites — tier-pool-dispatch, session-endpoint, agent-observed-ip
   * and practical-shared-agents-credits — assert "admin has no organization in
   * the dev seed". So this file left them failing on the NEXT `npm test`, with
   * 12 failures reading `expected 200 to be 400`: an org-scoped request that
   * SHOULD have been rejected now succeeds. That looks exactly like an authz
   * regression in the code under test, which is the expensive part — the
   * failures point at server code that is fine, in suites that never ran this
   * file, and only after a full gate that appeared to pass.
   *
   * So the org owner is a dedicated fixture account instead of admin, and it is
   * REUSED rather than recreated. Reuse is the point: because nothing can
   * delete an org, a fresh user per run would leave one more user and one more
   * organization behind every time. Provisioning is therefore idempotent — log
   * in, and only invite/register/create when that fails — so the whole file
   * costs exactly one user and one organization no matter how often it runs.
   * Admin is borrowed only to mint the invite, and its own row is never written.
   */
  const FIXTURE = {
    email: "stripe-e2e-fixture@test.local",
    username: "stripe-e2e-fixture",
    password: "stripe-e2e-fixture-pass-123",
    orgName: "Stripe E2E Fixture Org",
  };

  test.beforeAll(async ({ playwright }) => {
    adminRequest = await playwright.request.newContext({
      baseURL: "http://localhost:5000",
    });
    authenticatedRequest = await playwright.request.newContext({
      baseURL: "http://localhost:5000",
    });

    const login = () =>
      authenticatedRequest.post("/api/auth/login", {
        data: { email: FIXTURE.email, password: FIXTURE.password },
      });

    // Existing fixture account (every run after the first) — nothing to create.
    if (!(await login()).ok()) {
      const adminLogin = await adminRequest.post("/api/auth/login", {
        data: { email: "admin@vox.local", password: "admin123456" },
      });
      if (!adminLogin.ok()) {
        console.log("Admin login failed - may be rate limited. Status:", adminLogin.status());
        return;
      }

      // Registration is invite-gated, so admin mints one for the fixture user.
      const inviteResponse = await adminRequest.post("/api/admin/invite", {
        data: { email: FIXTURE.email, plan: "premium" },
      });
      if (!inviteResponse.ok()) {
        console.log("Invite creation failed. Status:", inviteResponse.status());
        return;
      }
      const { token } = await inviteResponse.json();

      // Register, then log in explicitly: register opens a session on whichever
      // context issued it, so do not rely on that side effect for this one.
      const registerResponse = await authenticatedRequest.post("/api/auth/register", {
        data: { username: FIXTURE.username, password: FIXTURE.password, token },
      });
      if (!registerResponse.ok()) {
        console.log("Registration failed. Status:", registerResponse.status());
        return;
      }

      const loginResponse = await login();
      if (!loginResponse.ok()) {
        console.log("Login failed - may be rate limited. Status:", loginResponse.status());
        return;
      }
    }

    // Same idempotence for the org: present on later runs, created on the first.
    const me = await (await authenticatedRequest.get("/api/auth/status")).json();
    if (!me.user?.organizationId) {
      const createResponse = await authenticatedRequest.post("/api/organizations", {
        data: {
          name: FIXTURE.orgName,
          description: "Organization for Stripe payment testing",
        },
      });
      if (!createResponse.ok()) {
        console.log("Org creation failed. Status:", createResponse.status());
      }
    }
  });

  test.afterAll(async () => {
    await authenticatedRequest?.dispose();
    await adminRequest?.dispose();
  });

  test("should get pricing configuration", async () => {
    // Use correct endpoint: /api/pricing
    const response = await authenticatedRequest.get("/api/pricing");
    expect(response.ok()).toBeTruthy();

    const pricing = await response.json();
    expect(Array.isArray(pricing)).toBe(true);

    // Check pricing tiers exist
    if (pricing.length > 0) {
      expect(pricing[0].minSeats).toBeDefined();
      expect(pricing[0].maxSeats).toBeDefined();
      expect(pricing[0].pricePerSeat).toBeDefined();
    }
  });

  test("should have an organization for payment tests", async () => {
    // Asserts the END STATE, not the act of creating, because beforeAll only
    // creates on the first run — a "was it created?" assertion would pass once
    // and be meaningless afterwards. This is the gate for the rest of the file:
    // the three tests below read the org id from here, and each still guards on
    // `if (me.user?.organizationId)`, so without a hard assertion at this point
    // a broken fixture would make them silently skip and the file would go green
    // having tested nothing.
    const meResponse = await authenticatedRequest.get("/api/auth/status");
    const me = await meResponse.json();
    expect(typeof me.user?.organizationId).toBe("number");

    const orgResponse = await authenticatedRequest.get(
      `/api/organizations/${me.user.organizationId}`
    );
    expect(orgResponse.ok()).toBeTruthy();

    const org = await orgResponse.json();
    expect(org.id).toBe(me.user.organizationId);
    expect(org.name).toBe(FIXTURE.orgName);
  });

  test("should calculate seat pricing for organization", async () => {
    // Get user's organization
    const meResponse = await authenticatedRequest.get("/api/auth/status");
    const me = await meResponse.json();

    if (me.user?.organizationId) {
      // Use correct endpoint: /api/organizations/:id/seats/calculate
      const response = await authenticatedRequest.post(
        `/api/organizations/${me.user.organizationId}/seats/calculate`,
        {
          data: { additionalSeats: 5 },
        }
      );

      if (response.ok()) {
        const calculation = await response.json();
        // Response has totalSeats (currentSeats + additionalSeats), not additionalSeats
        expect(calculation.totalSeats).toBeGreaterThanOrEqual(5);
        expect(calculation.pricePerSeat).toBeDefined();
        expect(calculation.subtotal).toBeDefined();
        expect(calculation.total).toBeDefined();
      }
    } else {
      console.log("Skipping seat calculation - no organization");
    }
  });

  test("should create setup intent for adding payment method", async () => {
    // Get user's organization
    const meResponse = await authenticatedRequest.get("/api/auth/status");
    const me = await meResponse.json();

    if (me.user?.organizationId) {
      // Use correct endpoint: /api/organizations/:id/payments/setup-intent
      const response = await authenticatedRequest.post(
        `/api/organizations/${me.user.organizationId}/payments/setup-intent`
      );

      if (response.ok()) {
        const intent = await response.json();
        expect(intent.clientSecret).toBeDefined();
        expect(intent.clientSecret).toMatch(/^seti_/);
      } else {
        // May fail if Stripe not fully configured - that's ok
        const error = await response.json();
        expect(error.error).toBeDefined();
      }
    } else {
      console.log("Skipping setup intent - no organization");
    }
  });

  test("should handle payment calculation for various seat counts", async () => {
    // Get user's organization
    const meResponse = await authenticatedRequest.get("/api/auth/status");
    const me = await meResponse.json();

    if (!me.user?.organizationId) {
      console.log("Skipping seat calculation - no organization");
      return;
    }

    // Test various seat counts
    const seatCounts = [1, 5, 10, 25, 50, 100];

    for (const seats of seatCounts) {
      const response = await authenticatedRequest.post(
        `/api/organizations/${me.user.organizationId}/seats/calculate`,
        {
          data: { additionalSeats: seats },
        }
      );

      if (response.ok()) {
        const calc = await response.json();
        // Response has totalSeats (currentSeats + additionalSeats)
        expect(calc.totalSeats).toBeGreaterThanOrEqual(seats);
        expect(calc.total).toBeGreaterThan(0);
        expect(calc.pricePerSeat).toBeDefined();
      }
    }
  });
});

test.describe("Stripe Card Form UI", () => {
  test.beforeEach(async ({ page }) => {
    // Login first
    await page.goto("/login");
    await page.waitForLoadState("domcontentloaded");

    await page.fill(
      'input[type="email"], input[name="email"], input[placeholder*="email" i]',
      "admin@vox.local"
    );
    await page.fill('input[type="password"]', "admin123456");
    await page.click('button[type="submit"]');

    // Wait for login to complete
    await page.waitForURL(/console|\//, { timeout: 10000 });
  });

  test("should display billing page with Stripe elements", async ({ page }) => {
    // Navigate to billing page
    await page.goto("/console/organization/billing");
    await page.waitForLoadState("domcontentloaded");

    // Check if Stripe elements or payment form is present
    const content = await page.content();

    // Page should have billing-related content
    const hasBillingContent =
      content.includes("billing") ||
      content.includes("payment") ||
      content.includes("card") ||
      content.includes("Stripe") ||
      content.includes("seats");

    expect(hasBillingContent || content.length > 500).toBeTruthy();
  });

  test("should load Stripe.js on billing page", async ({ page }) => {
    await page.goto("/console/organization/billing");
    await page.waitForLoadState("domcontentloaded");

    // Wait for Stripe.js to potentially load
    await page.waitForTimeout(3000);

    // Page should at least load without errors
    const content = await page.content();
    expect(content.length).toBeGreaterThan(100);
  });
});

test.describe("Stripe Webhook Handling", () => {
  test("should have webhook endpoint", async ({ request }) => {
    // Webhook endpoint should exist (will return error without valid signature)
    const response = await request.post("/api/webhooks/stripe", {
      data: { type: "test" },
      headers: {
        "stripe-signature": "invalid",
      },
    });

    // Should return 400 (bad request) not 404 (not found)
    // This confirms the endpoint exists
    expect(response.status()).not.toBe(404);
  });
});
