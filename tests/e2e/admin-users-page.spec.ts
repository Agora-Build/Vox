import { test, expect } from "@playwright/test";

/**
 * #209: the Users page shows one page of users with a search, instead of
 * rendering every user (5,485 froze the browser).
 */
const BASE = "http://localhost:5000";

test("Users page: one page at a time, searchable, counts from the server", async ({ page, playwright }) => {
  test.setTimeout(90_000);
  const admin = await playwright.request.newContext({ baseURL: BASE });
  await admin.post("/api/auth/login", { data: { email: "admin@vox.local", password: "admin123456" } });
  const stamp = `${Date.now()}`;
  const email = `e2e-users-page-${stamp}@example.com`;
  const { token } = await (await admin.post("/api/admin/invite", { data: { email, plan: "basic" } })).json();
  const fresh = await playwright.request.newContext({ baseURL: BASE }); // registering logs that context in as the new user
  await fresh.post("/api/auth/register", { data: { username: `e2euserspage${stamp}`, password: "TestPass123!", token } });
  await fresh.dispose();
  const stats = (await (await admin.get("/api/admin/users?limit=1")).json()).stats;
  try {
    await page.goto(`${BASE}/login`);
    await page.fill('input[type="email"]', "admin@vox.local");
    await page.fill('input[type="password"]', "admin123456");
    await page.click('button[type="submit"]');
    await page.waitForURL(/console/);
    await page.goto(`${BASE}/console/users`);

    await expect(page.getByTestId("text-total-users")).toHaveText(String(stats.total));
    const rows = page.locator('[data-testid^="row-user-"]');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeLessThanOrEqual(50);
    await expect(page.getByTestId("text-user-range")).toContainText(`of ${stats.total}`);

    await page.getByTestId("input-user-search").fill(`e2e-users-page-${stamp}`);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(email);
    await expect(page.getByTestId("text-user-range")).toHaveText("1–1 of 1");
    await expect(page.getByTestId("button-users-next")).toBeDisabled();
  } finally {
    if (process.env.DATABASE_URL) {
      const { pool } = await import("../../server/storage");
      await pool.query("DELETE FROM users WHERE email = $1", [email]);
    }
    await admin.dispose();
  }
});
