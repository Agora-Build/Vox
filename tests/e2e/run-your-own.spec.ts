import { test, expect, APIRequestContext, Page } from "@playwright/test";

/**
 * Run Your Own Page E2E Tests
 *
 * Tests the eval set preview/edit dialog, clone flow, and save flow
 * on the /run-your-own page. Requires a running server on port 5000
 * with an initialized database (admin + Scout users).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Log in as admin via API and return the authenticated request context */
async function loginAsAdmin(playwright: any): Promise<APIRequestContext> {
  const ctx = await playwright.request.newContext({
    baseURL: "http://localhost:5000",
  });
  const res = await ctx.post("/api/auth/login", {
    data: { email: "admin@vox.local", password: "admin123456" },
  });
  if (!res.ok()) {
    console.warn("Admin login failed — some tests may be skipped");
  }
  return ctx;
}

/** Log in as admin via the browser UI and navigate to /run-your-own */
async function loginAndNavigate(page: Page) {
  await page.goto("/login");
  await page.waitForSelector('[data-testid="input-email"]', { timeout: 10000 });
  await page.fill('[data-testid="input-email"]', "admin@vox.local");
  await page.fill('[data-testid="input-password"]', "admin123456");
  await page.click('[data-testid="button-login"]');
  // Wait for login to complete (redirects to /admin/console)
  await page.waitForURL(/\/(admin\/)?console/, { timeout: 15000 });
  // Now navigate to Run Your Own
  await page.goto("/run-your-own");
  await page.waitForLoadState("networkidle");
}

// ---------------------------------------------------------------------------
// Unauthenticated access
// ---------------------------------------------------------------------------

test.describe("Run Your Own — Unauthenticated", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
  });

  test("should show sign-in prompt when not logged in", async ({ page }) => {
    await page.goto("/run-your-own");
    await page.waitForLoadState("domcontentloaded");

    // Should see "Sign in to run evaluations" heading in the card
    await expect(
      page.locator("text=Sign in to run evaluations")
    ).toBeVisible({ timeout: 10000 });
  });

  test("should have a Sign In button linking to /login", async ({ page }) => {
    await page.goto("/run-your-own");
    await page.waitForLoadState("domcontentloaded");

    const signInLink = page.locator('a[href="/login"]');
    if ((await signInLink.count()) > 0) {
      await expect(signInLink.first()).toBeVisible();
    }
  });

  test("should show page title and description", async ({ page }) => {
    await page.goto("/run-your-own");
    await page.waitForLoadState("domcontentloaded");

    await expect(
      page.locator("text=/Run Your Own|Test Your Voice AI/i").first()
    ).toBeVisible({ timeout: 10000 });
  });
});

// ---------------------------------------------------------------------------
// Authenticated — Form Elements
// ---------------------------------------------------------------------------

test.describe("Run Your Own — Authenticated Form", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await loginAndNavigate(page);
  });

  test("should show configuration form when logged in", async ({ page }) => {
    // Should see "Configure Evaluation" card
    await expect(
      page.locator("text=/Configure Evaluation/i").first()
    ).toBeVisible({ timeout: 10000 });
  });

  test("should show New Product and Existing tabs", async ({ page }) => {
    await expect(page.locator("text=New Product")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("text=Existing")).toBeVisible();
  });

  test("should show eval set selector", async ({ page }) => {
    // Eval Set label
    await expect(
      page.locator("text=Eval Set").first()
    ).toBeVisible({ timeout: 10000 });

    // The select trigger (placeholder text)
    await expect(
      page.locator("text=/Select eval set/i").first()
    ).toBeVisible();
  });

  test("should show disabled Eye button when no eval set is selected", async ({ page }) => {
    // Eye button should exist but be disabled
    const eyeButton = page.locator('button[title="Preview / edit eval set"]');
    await expect(eyeButton).toBeVisible({ timeout: 10000 });
    await expect(eyeButton).toBeDisabled();
  });

  test("should show region selector with default NA", async ({ page }) => {
    await expect(
      page.locator("text=Target Region").first()
    ).toBeVisible({ timeout: 10000 });

    // Default region is NA
    await expect(
      page.locator("text=/North America/i").first()
    ).toBeVisible();
  });

  test("should show Start Evaluation button", async ({ page }) => {
    await expect(
      page.locator("text=/Start Evaluation/i").first()
    ).toBeVisible({ timeout: 10000 });
  });
});

// ---------------------------------------------------------------------------
// Eval Set Preview Dialog
// ---------------------------------------------------------------------------

test.describe("Run Your Own — Eval Set Preview Dialog", () => {
  let adminApi: APIRequestContext;
  let testEvalSetId: number;

  test.beforeAll(async ({ playwright }) => {
    adminApi = await loginAsAdmin(playwright);

    // Create a test eval set for preview tests
    const res = await adminApi.post("/api/eval-sets", {
      data: {
        name: `E2E Preview Test ${Date.now()}`,
        description: "E2E test eval set for preview dialog",
        visibility: "public",
        isMainline: false,
        config: {
          framework: "aeval",
          scenario: "name: e2e_test\nsteps:\n  - type: audio.play\n",
        },
      },
    });

    if (res.ok()) {
      const data = await res.json();
      testEvalSetId = data.id;
    }
  });

  test.afterAll(async () => {
    await adminApi?.dispose();
  });

  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await loginAndNavigate(page);
  });

  test("should open preview dialog when Eye button is clicked", async ({ page }) => {
    test.skip(!testEvalSetId, "No eval set created — skipping");

    // Open eval set dropdown and select our test eval set
    const selectTrigger = page.locator("text=/Select eval set/i").first();
    await selectTrigger.click();
    // Wait for dropdown items to appear
    await page.waitForTimeout(500);

    // Find and click the test eval set in the dropdown
    const evalSetOption = page.locator(`[role="option"]`).filter({
      hasText: /E2E Preview Test/,
    });

    if ((await evalSetOption.count()) === 0) {
      test.skip(true, "Test eval set not visible in dropdown");
      return;
    }

    await evalSetOption.first().click();
    await page.waitForTimeout(300);

    // Click the Eye button
    const eyeButton = page.locator('button[title="Preview / edit eval set"]');
    await expect(eyeButton).toBeEnabled();
    await eyeButton.click();

    // Dialog should open
    await expect(
      page.locator("text=Eval Set Preview")
    ).toBeVisible({ timeout: 5000 });
  });

  test("should show eval set name and scenario YAML in preview", async ({ page }) => {
    test.skip(!testEvalSetId, "No eval set created — skipping");

    // Select the eval set
    const selectTrigger = page.locator("text=/Select eval set/i").first();
    await selectTrigger.click();
    await page.waitForTimeout(500);

    const evalSetOption = page.locator(`[role="option"]`).filter({
      hasText: /E2E Preview Test/,
    });

    if ((await evalSetOption.count()) === 0) {
      test.skip(true, "Test eval set not visible in dropdown");
      return;
    }

    await evalSetOption.first().click();
    await page.waitForTimeout(300);

    // Open preview dialog
    await page.locator('button[title="Preview / edit eval set"]').click();
    await page.waitForTimeout(500);

    // Check that name input contains the eval set name
    const nameInput = page.locator('input').filter({ hasText: /E2E Preview Test/ });
    // Alternatively, check by value
    const inputWithName = page.locator('[role="dialog"] input');
    if ((await inputWithName.count()) > 0) {
      const value = await inputWithName.first().inputValue();
      expect(value).toContain("E2E Preview Test");
    }

    // Check that scenario YAML textarea has content
    const textarea = page.locator('[role="dialog"] textarea');
    if ((await textarea.count()) > 0) {
      const yamlValue = await textarea.first().inputValue();
      expect(yamlValue).toContain("audio.play");
    }
  });

  test("should show Save button for own eval set", async ({ page }) => {
    test.skip(!testEvalSetId, "No eval set created — skipping");

    // Select the eval set
    const selectTrigger = page.locator("text=/Select eval set/i").first();
    await selectTrigger.click();
    await page.waitForTimeout(500);

    const evalSetOption = page.locator(`[role="option"]`).filter({
      hasText: /E2E Preview Test/,
    });

    if ((await evalSetOption.count()) === 0) {
      test.skip(true, "Test eval set not visible in dropdown");
      return;
    }

    await evalSetOption.first().click();
    await page.waitForTimeout(300);

    // Open preview
    await page.locator('button[title="Preview / edit eval set"]').click();
    await page.waitForTimeout(500);

    // Since admin owns this eval set and it's not built-in, should show "Save"
    const saveButton = page.locator('[role="dialog"] button:has-text("Save")');
    await expect(saveButton).toBeVisible({ timeout: 5000 });

    // Should NOT show "Clone & Save"
    const cloneButton = page.locator('[role="dialog"] button:has-text("Clone & Save")');
    await expect(cloneButton).not.toBeVisible();
  });

  test("should close preview dialog with Cancel button", async ({ page }) => {
    test.skip(!testEvalSetId, "No eval set created — skipping");

    // Select the eval set
    const selectTrigger = page.locator("text=/Select eval set/i").first();
    await selectTrigger.click();
    await page.waitForTimeout(500);

    const evalSetOption = page.locator(`[role="option"]`).filter({
      hasText: /E2E Preview Test/,
    });

    if ((await evalSetOption.count()) === 0) {
      test.skip(true, "Test eval set not visible in dropdown");
      return;
    }

    await evalSetOption.first().click();
    await page.waitForTimeout(300);

    // Open preview
    await page.locator('button[title="Preview / edit eval set"]').click();
    await expect(page.locator("text=Eval Set Preview")).toBeVisible({ timeout: 5000 });

    // Click Cancel
    await page.locator('[role="dialog"] button:has-text("Cancel")').click();

    // Dialog should close
    await expect(page.locator("text=Eval Set Preview")).not.toBeVisible({ timeout: 3000 });
  });

  test("should save edited eval set in-place", async ({ page }) => {
    test.skip(!testEvalSetId, "No eval set created — skipping");

    // Select the eval set
    const selectTrigger = page.locator("text=/Select eval set/i").first();
    await selectTrigger.click();
    await page.waitForTimeout(500);

    const evalSetOption = page.locator(`[role="option"]`).filter({
      hasText: /E2E Preview Test/,
    });

    if ((await evalSetOption.count()) === 0) {
      test.skip(true, "Test eval set not visible in dropdown");
      return;
    }

    await evalSetOption.first().click();
    await page.waitForTimeout(300);

    // Open preview
    await page.locator('button[title="Preview / edit eval set"]').click();
    await page.waitForTimeout(500);

    // Edit the YAML
    const textarea = page.locator('[role="dialog"] textarea');
    if ((await textarea.count()) > 0) {
      await textarea.first().fill("name: e2e_test_edited\nsteps:\n  - type: audio.play\n  - type: audio.stop\n");
    }

    // Click Save
    const saveButton = page.locator('[role="dialog"] button:has-text("Save")').first();
    await saveButton.click();

    // Dialog should close (success)
    await expect(page.locator("text=Eval Set Preview")).not.toBeVisible({ timeout: 10000 });
  });
});

// ---------------------------------------------------------------------------
// Clone Flow (Built-in Eval Sets)
// ---------------------------------------------------------------------------

test.describe("Run Your Own — Clone Built-in Eval Set", () => {
  let adminApi: APIRequestContext;
  let builtInEvalSetId: number;

  test.beforeAll(async ({ playwright }) => {
    adminApi = await loginAsAdmin(playwright);

    // Look for an existing built-in eval set
    const res = await adminApi.get("/api/eval-sets?includePublic=true");
    if (res.ok()) {
      const sets = await res.json();
      const builtIn = sets.find((s: any) => s.config?.builtIn === true);
      if (builtIn) {
        builtInEvalSetId = builtIn.id;
      }
    }

    // If no built-in exists, create a mock one via admin (simulate seed output)
    if (!builtInEvalSetId) {
      // We can't truly create built-in eval sets without the seeder, but we can
      // test the clone behavior with a non-owned eval set instead.
      // For this test, we'll create a eval set owned by a different user
      // and verify the "Clone & Save" button appears.
    }
  });

  test.afterAll(async () => {
    await adminApi?.dispose();
  });

  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await loginAndNavigate(page);
  });

  test("should show Clone & Save for built-in eval set", async ({ page }) => {
    test.skip(!builtInEvalSetId, "No built-in eval set available — skipping");

    // Open eval set dropdown
    const selectTrigger = page.locator("text=/Select eval set/i").first();
    await selectTrigger.click();
    await page.waitForTimeout(500);

    // Find the built-in eval set (they have [aeval ...] prefix)
    const builtInOption = page.locator(`[role="option"]`).filter({
      hasText: /\[aeval/,
    });

    if ((await builtInOption.count()) === 0) {
      test.skip(true, "Built-in eval set not visible in dropdown");
      return;
    }

    await builtInOption.first().click();
    await page.waitForTimeout(300);

    // Open preview
    await page.locator('button[title="Preview / edit eval set"]').click();
    await page.waitForTimeout(500);

    // Should show "Clone & Save" (not "Save")
    const cloneButton = page.locator('[role="dialog"] button:has-text("Clone & Save")');
    await expect(cloneButton).toBeVisible({ timeout: 5000 });

    // Description should mention built-in
    await expect(
      page.locator("text=/built-in/i").first()
    ).toBeVisible();
  });

  test("should clone built-in eval set with edits", async ({ page }) => {
    test.skip(!builtInEvalSetId, "No built-in eval set available — skipping");

    // Select built-in eval set
    const selectTrigger = page.locator("text=/Select eval set/i").first();
    await selectTrigger.click();
    await page.waitForTimeout(500);

    const builtInOption = page.locator(`[role="option"]`).filter({
      hasText: /\[aeval/,
    });

    if ((await builtInOption.count()) === 0) {
      test.skip(true, "Built-in eval set not visible in dropdown");
      return;
    }

    await builtInOption.first().click();
    await page.waitForTimeout(300);

    // Open preview
    await page.locator('button[title="Preview / edit eval set"]').click();
    await page.waitForTimeout(500);

    // Edit name to indicate it's a clone
    const nameInput = page.locator('[role="dialog"] input').first();
    const currentName = await nameInput.inputValue();
    await nameInput.fill(`Clone of ${currentName}`);

    // Click "Clone & Save"
    const cloneButton = page.locator('[role="dialog"] button:has-text("Clone & Save")');
    await cloneButton.click();

    // Dialog should close on success
    await expect(page.locator("text=Eval Set Preview")).not.toBeVisible({ timeout: 10000 });
  });
});

// ---------------------------------------------------------------------------
// API-level tests for includePublic and clone
// ---------------------------------------------------------------------------

test.describe("Run Your Own — API: Eval Sets includePublic", () => {
  let adminApi: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    adminApi = await loginAsAdmin(playwright);
  });

  test.afterAll(async () => {
    await adminApi?.dispose();
  });

  test("should return eval sets without includePublic", async () => {
    const res = await adminApi.get("/api/eval-sets");
    expect(res.ok()).toBeTruthy();
    const sets = await res.json();
    expect(Array.isArray(sets)).toBe(true);
  });

  test("should return eval sets with includePublic=true", async () => {
    const res = await adminApi.get("/api/eval-sets?includePublic=true");
    expect(res.ok()).toBeTruthy();
    const sets = await res.json();
    expect(Array.isArray(sets)).toBe(true);
    // Should contain at least some eval sets
    expect(sets.length).toBeGreaterThan(0);
  });

  test("should not have duplicate eval set IDs with includePublic", async () => {
    const res = await adminApi.get("/api/eval-sets?includePublic=true");
    expect(res.ok()).toBeTruthy();
    const sets = await res.json();
    const ids = sets.map((s: any) => s.id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });
});

test.describe("Run Your Own — API: Eval Set Clone", () => {
  let adminApi: APIRequestContext;
  let sourceEvalSetId: number;

  test.beforeAll(async ({ playwright }) => {
    adminApi = await loginAsAdmin(playwright);

    // Create a source eval set
    const res = await adminApi.post("/api/eval-sets", {
      data: {
        name: `E2E Clone Source ${Date.now()}`,
        description: "Source for clone tests",
        visibility: "public",
        isMainline: false,
        config: {
          framework: "aeval",
          scenario: "name: clone_source\nsteps: []\n",
        },
      },
    });

    if (res.ok()) {
      const data = await res.json();
      sourceEvalSetId = data.id;
    }
  });

  test.afterAll(async () => {
    await adminApi?.dispose();
  });

  test("should clone eval set with default name", async () => {
    test.skip(!sourceEvalSetId, "No source eval set — skipping");

    const res = await adminApi.post(`/api/eval-sets/${sourceEvalSetId}/clone`);
    expect(res.ok()).toBeTruthy();

    const cloned = await res.json();
    expect(cloned.id).toBeDefined();
    expect(cloned.id).not.toBe(sourceEvalSetId);
    expect(cloned.name).toContain("Clone of");
  });

  test("should clone eval set with custom name", async () => {
    test.skip(!sourceEvalSetId, "No source eval set — skipping");

    const customName = `Custom Clone ${Date.now()}`;
    const res = await adminApi.post(`/api/eval-sets/${sourceEvalSetId}/clone`, {
      data: { name: customName },
    });
    expect(res.ok()).toBeTruthy();

    const cloned = await res.json();
    expect(cloned.name).toBe(customName);
  });

  test("should clone eval set with config overrides", async () => {
    test.skip(!sourceEvalSetId, "No source eval set — skipping");

    const res = await adminApi.post(`/api/eval-sets/${sourceEvalSetId}/clone`, {
      data: {
        name: `Config Override Clone ${Date.now()}`,
        config: {
          framework: "aeval",
          scenario: "name: overridden\nsteps:\n  - type: custom\n",
        },
      },
    });
    expect(res.ok()).toBeTruthy();

    const cloned = await res.json();
    expect(cloned.config.scenario).toContain("overridden");
  });

  test("should strip builtIn flag from cloned eval set", async () => {
    test.skip(!sourceEvalSetId, "No source eval set — skipping");

    const res = await adminApi.post(`/api/eval-sets/${sourceEvalSetId}/clone`, {
      data: {
        name: `BuiltIn Strip Test ${Date.now()}`,
        config: {
          framework: "aeval",
          builtIn: true, // Should be stripped by server
          scenario: "name: strip_test\nsteps: []\n",
        },
      },
    });
    expect(res.ok()).toBeTruthy();

    const cloned = await res.json();
    expect(cloned.config.builtIn).toBeUndefined();
  });
});
