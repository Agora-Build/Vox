import { test, expect } from "@playwright/test";
import * as OTPAuth from "otpauth";
test.skip(!process.env.PERSONAL_BILLING_E2E, "Run against the isolated personal billing preview server");

async function mockAccount(page: import("@playwright/test").Page, pluginIds = ["credits", "payments"], admin = false) {
  const user = { id: 1, username: "Builder", email: "builder@example.test", plan: "basic", isAdmin: admin, isEnabled: true, emailVerified: true, organizationId: null, orgRole: null, hasPassword: true };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const catalog = { version: 1, premiumPriceCents: 1200, topupPriceCents: 500, topupCredits: 100 };
    const responses: Record<string, unknown> = {
      "/api/auth/status": { initialized: true, user }, "/api/config": { organizationsEnabled: "false" },
      "/api/plugins": pluginIds.map((id) => ({ id })),
      "/api/plugins/credits/usage": { available: 100, reserved: 0, spent: 0, spentThisMonth: 0 },
      "/api/plugins/credits/statement": { entries: [{ id: 1, amount: 100, reason: "welcome", refType: "welcome", createdAt: "2026-10-04T00:00:00Z" }], nextCursor: null },
      "/api/plugins/payments/usage": { catalog, paymentsEnabled: false, subscription: null, purchases: [] },
      "/api/plugins/payments/pricing": { catalog, history: [], reviews: [] },
      "/api/user/security": { totpEnabled: false, hasPassword: true, emailAvailable: false, encryptionConfigured: true },
      "/api/admin/users": { data: [user, { ...user, id: 2, username: "Second" }], total: 2, stats: { total: 2, admins: 1, premium: 0 } },
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responses[url.pathname] ?? {}) });
  });
}
test("profile menu has Settings then Usage and no API Keys or Organization shortcut", async ({ page }) => {
  await mockAccount(page);
  await page.goto("/console/usage");
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await page.getByTestId("button-profile-menu").click();
  const menu = page.getByTestId("popover-profile");
  await expect(menu.locator("button")).toHaveText(["Edit profile", "Settings", "Usage", "Sign out"]);
  await expect(menu.getByText("API Keys", { exact: true })).toHaveCount(0);
  await expect(menu.getByText("Organization", { exact: true })).toHaveCount(0);
});
test("tabs navigate by URL and preserve free Basic and $12 Premium pricing", async ({ page }) => {
  await mockAccount(page); await page.goto("/console/usage");
  await expect(page.getByText("Welcome credits", { exact: true })).toBeVisible();
  expect(await page.getByTestId("usage-available-credits").evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(36);
  await expect(page.getByText("100 credits for $5.00.", { exact: false })).toBeVisible();
  await page.getByRole("tab", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/tab=plan/);
  await expect(page.getByText("$12.00", { exact: false })).toBeVisible();
  await expect(page.getByText("Feature access only. No recurring credits.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Upgrade to Premium" })).toBeDisabled();
  await page.reload(); await expect(page.getByRole("tab", { name: "Plan", exact: true })).toHaveAttribute("data-state", "active");
});
test("disabled credits hides Usage and does not fetch the plugin's page chunk or APIs", async ({ page }) => {
  await mockAccount(page, []);
  const requests: string[] = []; page.on("request", (request) => requests.push(request.url()));
  await page.goto("/console/settings");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await page.getByTestId("button-profile-menu").click();
  await expect(page.getByTestId("link-profile-usage")).toHaveCount(0);
  await page.goto("/console/usage");
  await expect(page.getByText("Personal Usage is unavailable", { exact: false })).toBeVisible();
  expect(requests.some((url) => /\/assets\/usage-|\/api\/plugins\/credits\//.test(url))).toBe(false);
});
test("credits alone renders both tabs without loading payment UI", async ({ page }) => {
  await mockAccount(page, ["credits"]);
  const requests: string[] = []; page.on("request", (request) => requests.push(request.url()));
  await page.goto("/console/usage?tab=plan");
  await expect(page.getByText("Personal subscriptions require the payments plugin.", { exact: false })).toBeVisible();
  expect(requests.some((url) => /\/assets\/panels-|\/api\/plugins\/payments\//.test(url))).toBe(false);
});
test("admin can select a user batch and preview total credits before verification", async ({ page }) => {
  await mockAccount(page, ["credits", "payments"], true);
  await page.goto("/console/users");
  await page.getByRole("button", { name: "Select this page" }).click();
  await page.getByRole("button", { name: "Grant credits (2)", exact: true }).click();
  await expect(page.getByText("2 recipients \u00b7 200 total credits", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Initialization code", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare verification" })).toBeDisabled();
});
test("mobile Usage fits the viewport and keeps both tabs usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await mockAccount(page);
  await page.goto("/console/usage");
  await expect(page.getByRole("tab", { name: "Credits & Usage" })).toBeVisible();
  await page.getByRole("tab", { name: "Plan", exact: true }).click();
  await expect(page.getByText("$12.00", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("real Core enrollment and protected grant work through the browser", async ({ page }, info) => {
  test.skip(!process.env.PERSONAL_BILLING_REAL_E2E, "Requires the isolated preview fixture");
  const target = new URL(process.env.PLAYWRIGHT_BASE_URL!);
  if (target.port !== "5151" || !["localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Refusing a non-isolated preview server");
  const password = "preview-password-only";
  const login = await page.request.post("/api/auth/login", { data: { email: "billing-preview@example.test", password } });
  expect(login.ok()).toBe(true);
  const status = await (await page.request.get("/api/auth/status")).json();
  const before = await (await page.request.get("/api/plugins/credits/usage")).json();
  await page.goto("/console/settings");
  await page.getByLabel("Current password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();
  await expect(page.getByAltText("Authenticator enrollment QR code")).toBeVisible();
  await page.getByText("Enter setup key manually", { exact: true }).click();
  const secret = await page.locator("code").first().textContent();
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret!), algorithm: "SHA1", digits: 6, period: 30 });
  await page.getByLabel("Authenticator code", { exact: true }).fill(totp.generate({ timestamp: Date.now() - 30_000 }));
  await page.getByRole("button", { name: "Enable authenticator", exact: true }).click();
  await expect(page.getByText("Save your recovery codes now", { exact: true })).toBeVisible();
  const recoveryCode = await page.locator("code").first().textContent();
  try {
    await page.getByRole("button", { name: "I saved these codes" }).click();
    await page.goto("/console/users");
    await page.getByPlaceholder("Search by email or username").fill("billing-preview@example.test");
    await page.getByTestId(`row-user-${status.user.id}`).getByRole("button", { name: "Grant credits", exact: true }).click();
    await page.getByLabel("Reason", { exact: true }).fill("Isolated browser verification");
    await page.getByLabel("Initialization code", { exact: true }).fill("personal-preview-init");
    await page.getByRole("button", { name: "Prepare verification", exact: true }).click();
    await page.getByLabel("Six-digit verification code", { exact: true }).fill(totp.generate());
    await page.getByRole("button", { name: "Approve grant", exact: true }).click();
    await expect(page.getByText("Grant approved.", { exact: false })).toBeVisible();
    await page.goto("/console/usage");
    const after = await (await page.request.get("/api/plugins/credits/usage")).json();
    expect(after.available).toBe(before.available + 100);
    await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("personal-usage-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: info.outputPath("personal-usage-mobile.png"), fullPage: true });
  } finally {
    const recovery = await page.request.post("/api/user/security/totp/recover", { data: { password, recoveryCode } });
    expect(recovery.ok()).toBe(true);
  }
});
