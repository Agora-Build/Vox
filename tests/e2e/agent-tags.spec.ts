import { test, expect } from "@playwright/test";

const manualTags = [{ key: "link", value: "ethernet" }, { key: "codec", value: "opus" }];
const agent = (id: number, overrides: Record<string, unknown>) => ({
  id, name: `Agent ${id}`, siteId: "na-us-seattle-01", siteLabel: "Seattle",
  state: "idle", dispatchTier: "public", capabilities: ["analyze"],
  metadata: null, lastSeenAt: "2026-11-06T00:00:00Z", createdAt: "2026-11-06T00:00:00Z",
  locationTrust: "trusted", accessClass: null, accessReason: null,
  linkType: null, tags: [], canEditTags: false, ...overrides,
});
const agents = [
  agent(1, { accessClass: "lastmile", accessReason: "v1: eyeball-asn + residential-rdns", linkType: "wifi" }),
  agent(2, { accessClass: "datacenter", accessReason: "v1: dc-range", linkType: "ethernet" }),
  agent(3, { accessClass: "unknown", accessReason: "v1: insufficient" }),
  agent(4, { dispatchTier: "private", accessClass: "lastmile", linkType: "wifi", tags: manualTags, canEditTags: true }),
  agent(5, { dispatchTier: "team", locationTrust: "datacenter", accessClass: "datacenter" }),
  agent(6, { dispatchTier: "shared", locationTrust: "low_confidence", accessClass: "unknown" }),
  agent(7, { dispatchTier: "private" }),
  agent(8, { dispatchTier: "private", locationTrust: "datacenter" }),
  agent(9, {}),
];

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/status": { initialized: true, user: {
        id: 1, username: "Builder", email: "builder@example.test", plan: "principal",
        isAdmin: false, isEnabled: true, emailVerified: true, organizationId: null, orgRole: null,
      } },
      "/api/config": { organizationsEnabled: "false" },
      "/api/plugins": [],
      "/api/region-locations": [],
      "/api/eval-agents": agents,
      "/api/eval-agent-tokens": [],
    };
    return route.fulfill({ json: responses[path] ?? {} });
  });
  await page.goto("/console/eval-agents");
});

test("access classifications are read-only detected tags, not tier badges", async ({ page }) => {
  for (const [id, access] of [[1, "lastmile"], [2, "datacenter"], [3, "unknown"]] as const) {
    const tags = page.getByTestId(`agent-tags-${id}`);
    await expect(tags.getByTestId(`agent-access-tag-${id}`)).toHaveText(`access:${access}detected`);
    await expect(tags).not.toContainText("None");
    await expect(page.getByTestId(`agent-tier-${id}`)).toHaveText("Public");
    await expect(page.getByTestId(`agent-location-badge-${id}`)).toHaveCount(0);
    await expect(page.getByTestId(`button-edit-agent-tags-${id}`)).toHaveCount(0);
  }
  await expect(page.getByTestId("agent-tags-1")).toContainText("link:wifi");
  await expect(page.getByTestId("agent-tags-2")).toContainText("link:ethernet");
  await page.getByTestId("agent-access-tag-1").hover();
  await expect(page.getByRole("tooltip")).toContainText("home ISP + residential address name");
  await expect(page.getByRole("tooltip")).toContainText("Set by Vox; cannot be edited");
});

test("location verification stays with Region and does not repeat access classification", async ({ page }) => {
  for (const [id, tier, verified] of [[4, "Private", "Verified"], [5, "Team", "Verified"], [6, "Shared", "Unverified"], [7, "Private", "Verified"], [8, "Private", "Verified"]] as const) {
    await expect(page.getByTestId(`agent-region-${id}`).getByTestId(`agent-location-badge-${id}`)).toHaveText(verified);
    await expect(page.getByTestId(`agent-tier-${id}`)).toHaveText(tier);
    await expect(page.getByTestId(`agent-region-${id}`)).not.toContainText(/lastmile|datacenter/);
  }
  await expect(page.getByTestId("agent-access-tag-8")).toContainText("access:datacenter");
  for (const id of [7, 9]) {
    await expect(page.getByTestId(`agent-tags-${id}`)).toHaveText("None");
    await expect(page.getByTestId(`agent-access-tag-${id}`)).toHaveCount(0);
  }
});

test("editing hand-set tags never sends system access or detected link values", async ({ page }) => {
  let saved: unknown;
  await page.route("**/api/eval-agents/4/tags", async (route) => {
    saved = route.request().postDataJSON();
    await route.fulfill({ json: agents[3] });
  });
  const tags = page.getByTestId("agent-tags-4");
  await expect(tags).toContainText("access:lastmile");
  await expect(tags).toContainText("link:wifi");
  await expect(tags).toContainText("link:ethernet");
  await page.getByTestId("button-edit-agent-tags-4").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("agent-tags-input-chip-link")).toHaveText("link:ethernet");
  await expect(dialog.getByTestId("agent-tags-input-chip-access")).toHaveCount(0);
  await dialog.getByTestId("agent-tags-input-field").fill("access:datacenter");
  await dialog.getByTestId("agent-tags-input-field").press("Enter");
  await expect(dialog.getByTestId("agent-tags-input-error")).toContainText("access is set by Vox");
  await dialog.getByTestId("agent-tags-input-field").fill("");
  await page.getByTestId("button-save-agent-tags").click();
  await expect(dialog).not.toBeVisible();
  expect(saved).toEqual({ tags: manualTags });
});

test("network tags remain accessible in the scrollable table on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const badge = page.getByTestId("agent-access-tag-1");
  await badge.scrollIntoViewIfNeeded();
  await expect(badge).toBeVisible();
  await expect(page.getByTestId("agent-tags-1")).toContainText("link:wifi");
});
