import { test, expect } from "@playwright/test";

/**
 * Secrets page: a value shorter than 4 characters cannot be saved. Vox can't
 * keep such a value out of logs and artifacts, so the form says so and keeps
 * Save disabled (the server refuses it too — tests/secrets.test.ts).
 */

const BASE = "http://localhost:5000";

async function loginUI(page: import("@playwright/test").Page) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', "admin@vox.local");
  await page.fill('input[type="password"]', "admin123456");
  await page.click('button[type="submit"]');
  await page.waitForURL(/console/);
}

test.describe("Secrets page", () => {
  test("a value shorter than 4 characters can't be saved", async ({ page }) => {
    test.setTimeout(60_000);
    await loginUI(page);
    await page.goto(`${BASE}/console/secrets`);

    const add = page.getByRole("button", { name: "Add Secret" }).first();
    await expect(add).toBeVisible();
    test.skip(await add.isDisabled(), "credential encryption is not configured on this server");
    await add.click();

    await page.fill("#secret-name", "E2E_SHORT_VALUE");
    const save = page.getByRole("button", { name: "Save Secret" });
    const hint = page.locator("#secret-value-hint");
    await expect(hint).toHaveText("At least 4 characters.");

    await page.fill("#secret-value", "abc");
    await expect(hint).toContainText("must be at least 4 characters");
    await expect(page.locator("#secret-value")).toHaveAttribute("aria-invalid", "true");
    await expect(save).toBeDisabled();

    await page.fill("#secret-value", "abcd");
    await expect(hint).toHaveText("At least 4 characters.");
    await expect(save).toBeEnabled();
    // Nothing is saved: this test only checks the form.
  });

  // #197: a value stored before the value rule is flagged on its row. The API
  // no longer accepts such a value, so the row is written through storage.
  test("a runtime secret stored before the value rule is flagged on the page", async ({ page }) => {
    test.skip(!process.env.DATABASE_URL || !process.env.CREDENTIAL_ENCRYPTION_KEY, "needs the dev DB and encryption key");
    test.setTimeout(60_000);
    const { storage, encryptValue, pool } = await import("../../server/storage");
    const adminId = (await pool.query("SELECT id FROM users WHERE email = $1", ["admin@vox.local"])).rows[0].id as number;
    const name = `E2E_OLD_SHORT_${Date.now()}`;
    await storage.createOrUpdateSecret(adminId, name, encryptValue("abc"));
    try {
      await loginUI(page);
      await page.goto(`${BASE}/console/secrets`);
      const row = page.getByRole("row").filter({ hasText: name });
      await expect(row.getByTestId("secret-value-problem")).toContainText("at least 4 characters");
      await expect(row.getByTestId("secret-value-problem")).toContainText("Jobs that use it are refused");
      await expect(row).not.toContainText("abc");
    } finally {
      await storage.deleteSecret(adminId, name);
    }
  });
});

// #198: the run dialog says up front that an eval set may not use this eval
// flow's secrets, and disables Run — instead of the click returning a 400.
test.describe("Run dialog — untrusted eval set", () => {
  test("picking someone else's eval set that uses secrets shows why, and Run stays disabled", async ({ page, playwright }) => {
    test.setTimeout(90_000);
    const stamp = `${Date.now()}`;
    const admin = await playwright.request.newContext({ baseURL: BASE });
    await admin.post("/api/auth/login", { data: { email: "admin@vox.local", password: "admin123456" } });

    // Someone else, with a public eval set that asks for a secret.
    const email = `e2e-untrusted-${stamp}@example.com`;
    const { token } = await (await admin.post("/api/admin/invite", { data: { email, plan: "premium" } })).json();
    const other = await playwright.request.newContext({ baseURL: BASE });
    expect((await other.post("/api/auth/register", { data: { username: `e2euntrusted${stamp}`, password: "TestPass123!", token } })).ok()).toBe(true);
    await other.post("/api/auth/login", { data: { email, password: "TestPass123!" } });
    const setName = `e2e-untrusted-set-${stamp}`;
    const set = await (await other.post("/api/eval-sets", {
      data: { name: setName, visibility: "public", config: { scenario: "steps:\n  - type: audio.wait_for_speech\n    description: ${secrets.E2E_OWNER_KEY}\n" } },
    })).json();
    // A clean one of the same author's, as the control: nothing else blocks Run.
    const cleanName = `e2e-clean-set-${stamp}`;
    const clean = await (await other.post("/api/eval-sets", {
      data: { name: cleanName, visibility: "public", config: { scenario: "steps:\n  - type: audio.wait_for_speech\n" } },
    })).json();

    // The admin's own eval flow.
    const providerId = (await (await admin.get("/api/providers")).json())[0].id;
    const flow = await (await admin.post("/api/eval-flows", {
      data: { name: `e2e-untrusted-flow-${stamp}`, visibility: "public", providerId, config: {} },
    })).json();

    // Options may be scrolled out of the (long) list: focus, then Enter.
    const pick = async (combobox: import("@playwright/test").Locator, option: import("@playwright/test").Locator) => {
      await combobox.click();
      await option.first().focus();
      await page.keyboard.press("Enter");
    };

    try {
      await loginUI(page);
      await page.goto(`${BASE}/console/eval-flows/${flow.id}`);
      await page.getByRole("button", { name: "Run Eval Flow" }).click();
      const dialog = page.getByRole("dialog");
      const evalSetPicker = dialog.getByRole("combobox").first();
      const run = dialog.getByRole("button", { name: "Run Evaluation" });

      await pick(evalSetPicker, page.getByRole("option", { name: setName }));
      await expect(evalSetPicker).toContainText(setName);
      await pick(dialog.getByTestId("select-run-target"), page.getByRole("option", { name: /^Any (public agent|of my agents here)/ }));

      await expect(dialog.getByTestId("eval-set-problem")).toContainText("E2E_OWNER_KEY");
      await expect(dialog.getByTestId("eval-set-problem")).toContainText("may not use this eval flow's secrets");
      await expect(run).toBeDisabled();

      // Control: the same author's clean eval set, same target — Run is enabled.
      await pick(evalSetPicker, page.getByRole("option", { name: cleanName }));
      await expect(dialog.getByTestId("eval-set-problem")).toHaveCount(0);
      await pick(dialog.getByTestId("select-run-target"), page.getByRole("option", { name: /^Any (public agent|of my agents here)/ }));
      await expect(run).toBeEnabled();
    } finally {
      await admin.delete(`/api/eval-flows/${flow.id}`);
      await other.delete(`/api/eval-sets/${set.id}`);
      await other.delete(`/api/eval-sets/${clean.id}`);
      await admin.dispose();
      await other.dispose();
    }
  });
});

