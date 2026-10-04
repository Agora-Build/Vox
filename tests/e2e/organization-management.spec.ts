import { test, expect, type Page } from "@playwright/test";

async function mockOrganization(page: Page, role: "owner" | "admin" | "member" = "admin") {
  const user = { id: 1, username: "Builder", email: "builder@example.test", plan: "premium", isAdmin: false, isEnabled: true, emailVerified: true, organizationId: 42 as number | null, orgRole: role as string | null, hasPassword: true };
  const organization = { id: 42, name: "Community Builders", address: "100 Community Lane", verified: true, memberCount: 3, totalSeats: 5, usedSeats: 3, orgRole: role, createdAt: "2026-10-04T00:00:00Z" };
  const mutations: Array<{ method: string; path: string; body: unknown }> = [];
  const projects = [{ id: 1, name: "Personal project", organizationId: null as number | null }, { id: 2, name: "Organization project", organizationId: 42 }];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let response: unknown;
    if (request.method() === "PATCH" && path === "/api/organizations/42") {
      const body = request.postDataJSON();
      mutations.push({ method: request.method(), path, body });
      Object.assign(organization, body);
      response = organization;
    } else if (request.method() === "POST" && path === "/api/organizations/move-resources") {
      mutations.push({ method: request.method(), path, body: request.postDataJSON() });
      projects[0].organizationId = 42;
      response = { moved: { projects: 1, evalFlows: 0, evalSets: 0, schedules: 0 } };
    } else if (request.method() === "POST" && path === "/api/organizations/42/leave") {
      mutations.push({ method: request.method(), path, body: null });
      user.organizationId = null;
      user.orgRole = null;
      response = { ok: true };
    } else {
      const responses: Record<string, unknown> = {
        "/api/auth/status": { initialized: true, user },
        "/api/config": { organizationsEnabled: "true" },
        "/api/plugins": [{ id: "organizations" }, { id: "credits" }],
        "/api/user/organization": user.organizationId ? organization : null,
        "/api/projects": projects,
        "/api/eval-flows": [],
        "/api/eval-sets": [],
        "/api/eval-schedules": [],
        "/api/user/security": { totpEnabled: false, hasPassword: true, emailAvailable: false, encryptionConfigured: true },
      };
      response = responses[path] ?? {};
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });
  return { mutations };
}

for (const role of ["owner", "admin"] as const) {
  test(`${role} manages organization details on the dashboard without a second Settings link`, async ({ page }) => {
    await mockOrganization(page, role);
    await page.goto("/console/organization", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Community Builders" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Organization management" })).toBeVisible();
    await expect(page.getByLabel("Organization Name")).toHaveValue("Community Builders");
    await expect(page.getByLabel("Address", { exact: true })).toHaveValue("100 Community Lane");
    await expect(page.getByRole("button", { name: "Move resources from personal to organization" })).toBeVisible();
    await expect(page.locator('a[href="/console/organization/settings"]')).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Organization Settings" })).toHaveCount(0);
    if (role === "owner") await expect(page.getByRole("button", { name: "Leave Organization", exact: true })).toBeDisabled();
    else await expect(page.getByRole("button", { name: "Leave Organization", exact: true })).toBeEnabled();

    await page.getByTestId("button-profile-menu").click();
    await expect(page.getByTestId("popover-profile").locator("button")).toHaveText(["Edit profile", "Settings", "Usage", "Sign out"]);
    await page.getByTestId("link-profile-settings").click();
    await expect(page).toHaveURL(/\/console\/settings$/);
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  });
}

test("saving organization details updates the dashboard and retains the existing API", async ({ page }) => {
  const { mutations } = await mockOrganization(page);
  await page.goto("/console/organization", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Organization Name").fill("Updated Community");
  await page.getByLabel("Address", { exact: true }).fill("200 Builder Street");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByRole("heading", { name: "Updated Community" })).toBeVisible();
  expect(mutations).toEqual([{ method: "PATCH", path: "/api/organizations/42", body: { name: "Updated Community", address: "200 Builder Street" } }]);
});

test("regular members keep a read-only dashboard and cannot see management controls", async ({ page }) => {
  const { mutations } = await mockOrganization(page, "member");
  await page.goto("/console/organization", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Community Builders" })).toBeVisible();
  await expect(page.getByText("100 Community Lane", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Organization management" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save Changes" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Leave Organization", exact: true })).toHaveCount(0);
  await expect(page.locator('a[href="/console/organization/settings"]')).toHaveCount(0);
  expect(mutations).toEqual([]);
});

for (const role of ["owner", "member"] as const) {
  test(`old organization Settings URLs redirect to the dashboard for ${role}s`, async ({ page }) => {
    await mockOrganization(page, role);
    await page.goto("/console/organization/settings", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/console\/organization$/);
    await expect(page.getByRole("heading", { name: "Community Builders" })).toBeVisible();
  });
}

test("resource transfer remains available on the Organization page and lists only personal resources", async ({ page }) => {
  const { mutations } = await mockOrganization(page);
  await page.goto("/console/organization", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Move resources from personal to organization" }).click();
  const dialog = page.getByRole("dialog", { name: "Move Resources to Community Builders" });
  const personalProject = dialog.getByRole("checkbox", { name: /^Personal project/ });
  await expect(personalProject).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: /^Organization project/ })).toHaveCount(0);
  await personalProject.check();
  await dialog.getByRole("button", { name: "Move 1 resource", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(mutations).toEqual([{ method: "POST", path: "/api/organizations/move-resources", body: { projectIds: [1], evalFlowIds: [], evalSetIds: [], scheduleIds: [] } }]);
});

test("organization admins still confirm before leaving", async ({ page }) => {
  const { mutations } = await mockOrganization(page);
  await page.goto("/console/organization", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Leave Organization", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Leave Organization" });
  await expect(dialog).toBeVisible();
  expect(mutations).toEqual([]);
  await dialog.getByRole("button", { name: "Leave Organization", exact: true }).click();
  await expect(page).toHaveURL(/\/console\/organization\/create$/);
  expect(mutations).toEqual([{ method: "POST", path: "/api/organizations/42/leave", body: null }]);
});

test("the consolidated organization controls fit a mobile viewport", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockOrganization(page);
  await page.goto("/console/organization", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Organization Name")).toBeVisible();
  await expect(page.getByRole("button", { name: "Move resources from personal to organization" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("organization-mobile.png"), fullPage: true });
});
