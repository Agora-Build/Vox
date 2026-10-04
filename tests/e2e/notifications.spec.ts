import { test, expect } from "@playwright/test";

const groupId = "22e14166-cc4e-4a98-9823-9f66b0fe63b9";
const channelId = "730e283d-bc47-49d4-bc62-3fcba622b6ab";
async function mock(page: import("@playwright/test").Page, { enabled = true, admin = false, editor = false } = {}) {
  const user = { id: 1, username: "Builder", email: "builder@example.test", plan: "basic", isAdmin: admin, isEnabled: true, emailVerified: true, hasPassword: true, organizationId: null, orgRole: null };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const response: Record<string, unknown> = {
      "/api/auth/status": { initialized: true, user }, "/api/config": { organizationsEnabled: "false" },
      "/api/plugins": enabled ? [{ id: "notifications" }] : [],
      "/api/user/security": { totpEnabled: false, hasPassword: true, emailAvailable: false, encryptionConfigured: true },
      "/api/plugins/notifications/settings": { permission: { isAdmin: admin, canEdit: editor || admin, canScript: editor || admin, canLlm: false, groupIds: editor ? [groupId] : [] }, emailAvailable: true, encryptionConfigured: true, llmAvailable: false, llmDailyLimit: 100, metrics: ["credits.available", "eval.responseLatencyMs"], groups: [{ id: groupId, name: "Selected users" }] },
      "/api/plugins/notifications/channels": [{ id: channelId, name: "My email", kind: "email", owner_ref: 1, group_id: null, enabled: true, revision: groupId }],
      "/api/plugins/notifications/rules": [], "/api/plugins/notifications/activity": [],
      "/api/plugins/notifications/access": { permissions: [], groups: [{ id: groupId, name: "Selected users", user_refs: [1, 2] }], audit: [] },
      "/api/plugins/notifications/preview": { matched: true, summary: "Low credits", subjectId: 1 },
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response[url.pathname] ?? { id: channelId, ok: true }) });
  });
}

test("settings links to notifications only when the plugin is enabled", async ({ page }) => {
  await mock(page);
  await page.goto("/console/settings", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("link", { name: "Notification channels & rules" })).toBeVisible();
});
test("disabled notifications does not load plugin APIs or UI", async ({ page }) => {
  const requests: string[] = []; page.on("request", (request) => requests.push(request.url()));
  await mock(page, { enabled: false });
  await page.goto("/console/notifications", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("The notifications plugin is disabled.")).toBeVisible();
  expect(requests.some((url) => url.includes("/api/plugins/notifications/"))).toBe(false);
});
test("ordinary users manage destinations but do not see privileged controls", async ({ page }) => {
  await mock(page); await page.goto("/console/notifications", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Notifications", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Access & Groups" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Rules & Content" }).click();
  await expect(page.getByText("An admin can assign Scout / Editor access", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create rule", exact: true })).toHaveCount(0);
});
test("editors can preview comparisons and use JavaScript without enabling unconfigured LLMs", async ({ page }) => {
  await mock(page, { editor: true }); await page.goto("/console/notifications", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Rules & Content" }).click();
  await page.getByLabel("My email (email)", { exact: true }).check();
  await expect(page.getByLabel("Enable this rule")).not.toBeChecked();
  await page.getByRole("button", { name: "Preview rule", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Preview for user #1" })).toContainText("Would trigger");
  await page.getByLabel("Trigger mode").selectOption("javascript");
  await expect(page.getByLabel("JavaScript", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Trigger mode").locator('option[value="llm"]')).toBeDisabled();
});
test("admins configure selected audiences and independent permissions", async ({ page }) => {
  await mock(page, { admin: true }); await page.goto("/console/notifications", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Access & Groups" }).click();
  await expect(page.getByText("Scout / Editor permissions", { exact: true })).toBeVisible();
  await page.getByLabel("User ID", { exact: true }).fill("2");
  await page.getByLabel("Edit rules & content", { exact: true }).check();
  await page.getByLabel("JavaScript", { exact: true }).check();
  await page.getByLabel("Selected users", { exact: true }).check();
  const request = page.waitForRequest((req) => req.url().endsWith("/api/plugins/notifications/access") && req.method() === "POST");
  await page.getByRole("button", { name: "Save access", exact: true }).click();
  expect((await request).postDataJSON()).toEqual({ userId: 2, canEdit: true, canScript: true, canLlm: false, groupIds: [groupId] });
});
test("mobile notification editor fits the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await mock(page, { admin: true });
  await page.goto("/console/notifications", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Rules & Content" }).click();
  await expect(page.getByRole("button", { name: "Create rule", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
