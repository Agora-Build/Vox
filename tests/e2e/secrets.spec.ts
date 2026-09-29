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
