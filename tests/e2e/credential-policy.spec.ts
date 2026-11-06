import { test, expect, type Page, type Route } from "@playwright/test";

const secret = { id: 1, name: "SERVICE_KEY", brokerType: null, isTestAccount: false, createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z" };
const flow = { id: 42, name: "Owner's public flow", ownerId: 2, visibility: "public", providerId: "alpha", config: {}, createdAt: "2026-11-05T00:00:00Z" };
const scenario = { id: 7, name: "Owner scenario", ownerId: 2, visibility: "public", config: {} };
const region = { baseId: "na-us-seattle", displayName: "Seattle", countryName: "United States", macroRegionName: "North America", isActive: true, allocatedRegions: ["na-us-seattle-01"] };

async function mockPage(page: Page, options: {
  orgRole?: string; targets?: object; onDelete?: (route: Route) => Promise<void>; onRun?: (body: Record<string, unknown>) => void;
} = {}) {
  await page.route("**/api/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() === "DELETE" && /\/api\/(org-)?secrets\//.test(path) && options.onDelete) return options.onDelete(route);
    let data: unknown = [];
    if (path === "/api/auth/status") data = { initialized: true, user: { id: 1, username: "Owner", email: "owner@test.local", plan: "premium", isAdmin: false, organizationId: 10, orgRole: options.orgRole ?? "admin" } };
    else if (path === "/api/config") data = { organizationsEnabled: "true" };
    else if (path === "/api/plugins") data = [];
    else if (path === "/api/health") data = { status: "operational", agents: { total: 1, online: 1, offline: 0 } };
    else if (path === "/api/secrets") data = { encryptionConfigured: true, secrets: [secret] };
    else if (path === "/api/org-secrets") data = [secret];
    else if (path === "/api/broker-types") data = [{ id: "auth-session", live: true }];
    else if (path.startsWith("/api/credential-trials/")) data = { enabled: false, maxRuns30Days: 0, used30Days: 0 };
    else if (path === "/api/providers") data = [{ id: "alpha", name: "Alpha", sku: "convoai" }];
    else if (path === "/api/region-locations") data = [region];
    else if (path === "/api/eval-flows/42/run-targets") data = options.targets ?? {};
    else if (path === "/api/eval-flows/42/run") { options.onRun?.(req.postDataJSON()); data = { job: { id: 99 } }; }
    else if (path === "/api/eval-flows/42/clone") data = { ...flow, id: 43, ownerId: 1, missingSecrets: ["SERVICE_KEY"] };
    else if (path === "/api/eval-flows") data = [flow];
    else if (path === "/api/eval-flows/42" || path === "/api/eval-flows/43") data = flow;
    else if (path === "/api/eval-sets") data = [scenario];
    else if (path === "/api/eval-jobs") data = { data: [], total: 0 };
    await route.fulfill({ json: data });
  });
}

for (const scope of ["personal", "org"] as const) {
  test(`confirm ${scope} deletion; opening/canceling sends no request; pending prevents repeats`, async ({ page }) => {
    let deletes = 0;
    let finish: (() => void) | undefined;
    await mockPage(page, { onDelete: async (route) => {
      deletes++;
      await new Promise<void>((resolve) => { finish = resolve; });
      await route.fulfill({ json: { message: "Deleted" } });
    } });
    await page.goto(`/console/secrets?tab=${scope}`);
    const remove = page.getByRole("row").filter({ hasText: secret.name }).getByRole("button", { name: "Delete", exact: true });
    await remove.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(secret.name);
    await expect(dialog).toContainText(scope === "org" ? "organization's secrets" : "personal secrets");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    expect(deletes).toBe(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(deletes).toBe(0);
    await remove.click();
    await dialog.getByRole("button", { name: "Delete secret", exact: true }).click();
    await expect.poll(() => deletes).toBe(1);
    await expect(dialog.getByRole("button", { name: "Deleting..." })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    finish!();
    await expect(dialog).toBeHidden();
    expect(deletes).toBe(1);
  });
}

test("a failed deletion stays visible and can be canceled without retrying", async ({ page }) => {
  let deletes = 0;
  await mockPage(page, { onDelete: async (route) => { deletes++; await route.fulfill({ status: 403, json: { error: "Permission changed" } }); } });
  await page.goto("/console/secrets");
  await page.getByRole("row").filter({ hasText: secret.name }).getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Delete secret", exact: true }).click();
  await expect(page.getByText("Failed to delete secret", { exact: true }).first()).toBeVisible();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(deletes).toBe(1);
});

test("org members cannot delete or configure org borrowing; test-account attestation is gone", async ({ page }) => {
  await mockPage(page, { orgRole: "member" });
  await page.goto("/console/secrets?tab=org");
  await expect(page.getByRole("row").filter({ hasText: secret.name })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("trial-settings-organization")).toHaveCount(0);
  await page.goto("/console/secrets?tab=personal");
  await page.getByRole("button", { name: "Add Secret" }).click();
  await expect(page.getByText("Dedicated test account", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toContainText("Other people's Shared agents require Brokered secrets");
});

const publicTargets = {
  agents: { mine: [], shared: [], public: [{ siteId: "na-us-seattle-01", region: region.baseId, state: "idle" }] },
  referencedSecrets: [], runtimeSecretNames: [],
  tiers: [{ tier: "public", available: true }, { tier: "private", available: false }, { tier: "team", available: false }],
};
test("public flow creation offers 5/80 defaults and saves custom limits", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await mockPage(page);
  let created: Record<string, unknown> | undefined;
  await page.route(/\/api\/eval-flows(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      created = route.request().postDataJSON();
      return route.fulfill({ json: { ...flow, ...created, id: 44 } });
    }
    await route.fulfill({ json: [flow] });
  });
  await page.goto("/console/eval-flows");
  await page.getByTestId("button-create-eval-flow").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("#create-trial-daily")).toHaveValue("5");
  await expect(dialog.locator("#create-trial-monthly")).toHaveValue("80");
  await dialog.getByTestId("input-eval-flow-name").fill("My public flow");
  await dialog.getByTestId("select-eval-flow-provider").click();
  await page.getByRole("option", { name: "Alpha", exact: true }).click();
  await dialog.locator("#create-trial-daily").fill("-1");
  await expect(dialog.getByTestId("button-submit-eval-flow")).toBeDisabled();
  await dialog.locator("#create-trial-daily").fill("9");
  await dialog.locator("#create-trial-monthly").fill("120");
  await dialog.getByTestId("button-submit-eval-flow").click();
  await expect.poll(() => created).toMatchObject({ visibility: "public", trialLimit24Hours: 9, trialLimit30Days: 120 });
});

test("publishing a private flow exposes editable limits and retains them when visibility changes", async ({ page }) => {
  await mockPage(page);
  const mine = { ...flow, ownerId: 1, organizationId: null, visibility: "private", trialLimit24Hours: 7, trialLimit30Days: 99 };
  let updated: Record<string, unknown> | undefined;
  await page.route(/\/api\/eval-flows(?:\?.*)?$/, (route) => route.fulfill({ json: [mine] }));
  await page.route("**/api/eval-flows/42", async (route) => {
    if (route.request().method() === "PATCH") updated = route.request().postDataJSON();
    await route.fulfill({ json: { ...mine, ...updated } });
  });
  await page.goto("/console/eval-flows");
  await page.getByTestId("row-eval-flow-42").getByRole("button").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("edit-trial-limits")).toHaveCount(0);
  await dialog.getByRole("combobox").filter({ hasText: "Private" }).click();
  await page.getByRole("option", { name: "Public", exact: true }).click();
  await expect(dialog.locator("#edit-trial-daily")).toHaveValue("7");
  await expect(dialog.locator("#edit-trial-monthly")).toHaveValue("99");
  await dialog.locator("#edit-trial-daily").fill("2");
  await dialog.locator("#edit-trial-monthly").fill("20");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect.poll(() => updated).toMatchObject({ visibility: "public", trialLimit24Hours: 2, trialLimit30Days: 20 });
});

test("trial notice displays the flow's configured limits, not fixed defaults", async ({ page }) => {
  await mockPage(page, { targets: { ...publicTargets, trial: { required: true, available: true, remaining24Hours: 2, remaining30Days: 18, trialLimit24Hours: 4, trialLimit30Days: 20, reason: null } } });
  const dialog = await openRun(page);
  await expect(dialog.getByTestId("credential-trial-notice")).toContainText("2 of 4 runs left in 24 hours and 18 of 20 in 30 days for this flow");
});

test("own Shared agent is preferred and permits Runtime and Brokered use without third-party consent", async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  const own = { tokenId: 8, name: "My Shared Seattle", dispatchTier: "shared", siteId: "na-us-seattle-02", region: region.baseId, price: null, ownCredentialAgent: true };
  await mockPage(page, { onRun: (body) => { submitted = body; }, targets: { ...publicTargets, agents: { ...publicTargets.agents, mine: [own] }, preferredTokenId: 8, requiresSessionConsent: true, runtimeSecretNames: ["SERVICE_KEY"] } });
  const dialog = await openRun(page);
  await expect(dialog.getByTestId("select-run-target")).toContainText("My Shared Seattle");
  await expect(dialog.getByTestId("own-shared-credentials")).toBeVisible();
  await expect(dialog.getByTestId("shared-runtime-blocked")).toHaveCount(0);
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Run Evaluation", exact: true }).click();
  await expect.poll(() => submitted?.targetTokenId).toBe(8);
});

for (const tier of ["private", "shared"] as const) {
  test(`Run Your Own prefers an own ${tier} agent and preserves an explicit alternative`, async ({ page }) => {
    const own = { tokenId: 8, name: `My ${tier} Seattle`, dispatchTier: tier, siteId: "na-us-seattle-02", region: region.baseId, price: null, ownCredentialAgent: true };
    await mockPage(page, { targets: { ...publicTargets, agents: { ...publicTargets.agents, mine: [own] }, preferredTokenId: 8, requiresSessionConsent: true, runtimeSecretNames: ["SERVICE_KEY"] } });
    await page.route(/\/api\/eval-sets(?:\?.*)?$/, (route) => route.fulfill({ json: [scenario, { ...scenario, id: 8, name: "Another scenario" }] }));
    await page.goto("/run-your-own");
    await page.getByRole("combobox").filter({ hasText: "Choose an Eval Flow" }).click();
    await page.getByRole("option", { name: flow.name }).click();
    await page.getByRole("combobox").filter({ hasText: "Select eval set" }).click();
    await page.getByRole("option", { name: scenario.name }).click();
    await page.getByRole("combobox").filter({ hasText: "Select a region" }).click();
    await page.getByRole("option", { name: /Seattle/ }).click();
    const picker = page.getByRole("combobox").filter({ hasText: own.name });
    await expect(picker).toBeVisible();
    await expect(page.getByRole("button", { name: "Start Evaluation", exact: true })).toBeEnabled();
    await expect(page.getByTestId("shared-runtime-blocked")).toHaveCount(0);
    await picker.click();
    await page.getByRole("option", { name: "Any available in region", exact: true }).click();
    await page.getByRole("combobox").filter({ hasText: scenario.name }).click();
    await page.getByRole("option", { name: "Another scenario", exact: true }).click();
    await expect(page.getByRole("combobox").filter({ hasText: "Any available in region" })).toBeVisible();
  });
}

async function openRun(page: Page) {
  await page.goto("/console/eval-flows/42");
  await page.getByRole("button", { name: "Run Eval Flow", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: scenario.name, exact: true }).click();
  return dialog;
}

for (const width of [1440, 390]) {
  test(`borrowed allowance and BYOC copy are explicit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await mockPage(page, { targets: { ...publicTargets, trial: { required: true, available: false, remaining24Hours: 0, remaining30Days: 7, reason: "Trial allowance exhausted. Bring your own credentials or wait." } } });
    const dialog = await openRun(page);
    await expect(dialog.getByTestId("credential-trial-notice")).toContainText("Trial allowance exhausted");
    await expect(dialog.getByRole("button", { name: "Run Evaluation", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Bring your own credentials", exact: true }).click();
    await expect(page).toHaveURL(/\/console\/eval-flows\/43$/);
  });
}

test("Shared Runtime cannot be acknowledged away, even if a stale picker offers the agent", async ({ page }) => {
  const shared = { tokenId: 8, name: "Shared Seattle", dispatchTier: "shared", siteId: "na-us-seattle-02", region: region.baseId, price: 1 };
  await mockPage(page, { targets: { ...publicTargets, agents: { ...publicTargets.agents, shared: [shared] }, runtimeSecretNames: ["SERVICE_KEY"] } });
  const dialog = await openRun(page);
  await dialog.getByTestId("select-run-target").click();
  await page.getByRole("option", { name: /Shared Seattle/ }).click();
  await expect(dialog.getByTestId("shared-runtime-blocked")).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Run Evaluation", exact: true })).toBeDisabled();
});

test("Shared Brokered sessions require explicit consent and submit only the session consent flag", async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  const shared = { tokenId: 8, name: "Shared Seattle", dispatchTier: "shared", siteId: "na-us-seattle-02", region: region.baseId, price: 1 };
  await mockPage(page, { onRun: (body) => { submitted = body; }, targets: { ...publicTargets, agents: { ...publicTargets.agents, shared: [shared] }, requiresSessionConsent: true } });
  const dialog = await openRun(page);
  await dialog.getByTestId("select-run-target").click();
  await page.getByRole("option", { name: /Shared Seattle/ }).click();
  const run = dialog.getByRole("button", { name: "Run Evaluation", exact: true });
  await expect(run).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await expect(run).toBeEnabled();
  await run.click();
  await expect.poll(() => submitted?.credentialConsent).toBe(true);
  expect(submitted).not.toHaveProperty("runtimeSecretConsent");
});

test("a lost borrowed-trial response retries the same submission ID, including without randomUUID", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(crypto, "randomUUID", { value: undefined }); });
  await mockPage(page, { targets: { ...publicTargets, trial: { required: true, available: true, remaining24Hours: 5, remaining30Days: 80, trialLimit24Hours: 5, trialLimit30Days: 80, reason: null } } });
  const requests: Array<Record<string, unknown>> = [];
  await page.route("**/api/eval-flows/42/run", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) return route.abort("failed");
    await route.fulfill({ json: { job: { id: 99 } } });
  });
  const dialog = await openRun(page);
  await dialog.getByTestId("select-run-target").click();
  await page.getByRole("option", { name: /Any public agent/ }).click();
  await dialog.getByRole("button", { name: "Run Evaluation", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(requests[1].requestId).toBe(requests[0].requestId);
  await expect(dialog).toBeHidden();
});

test("Run Your Own shows the same exhausted allowance and keeps Start disabled", async ({ page }) => {
  await mockPage(page, { targets: { ...publicTargets, trial: { required: true, available: false, remaining24Hours: 0, remaining30Days: 7, reason: "Trial allowance exhausted" } } });
  await page.goto("/run-your-own");
  await page.getByRole("combobox").filter({ hasText: "Choose an Eval Flow" }).click();
  await page.getByRole("option", { name: flow.name }).click();
  await page.getByRole("combobox").filter({ hasText: "Select eval set" }).click();
  await page.getByRole("option", { name: scenario.name }).click();
  await page.getByRole("combobox").filter({ hasText: "Select a region" }).click();
  await page.getByRole("option", { name: /Seattle/ }).click();
  await expect(page.getByTestId("credential-trial-notice")).toContainText("Trial allowance exhausted");
  await expect(page.getByRole("button", { name: "Start Evaluation", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Bring your own credentials" })).toBeVisible();
});

test("a pending trial keeps its original payload when the form changes before a retry", async ({ page }) => {
  await mockPage(page, { targets: { ...publicTargets, trial: { required: true, available: true, remaining24Hours: 5, remaining30Days: 80, trialLimit24Hours: 5, trialLimit30Days: 80, reason: null } } });
  await page.route(/\/api\/eval-sets(?:\?.*)?$/, (route) => route.fulfill({ json: [scenario, { ...scenario, id: 8, name: "Another owner scenario" }] }));
  const requests: Array<Record<string, unknown>> = [];
  let rejectFirst: (() => Promise<void>) | undefined;
  await page.route("**/api/eval-flows/42/run", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      await new Promise<void>((resolve) => {
        rejectFirst = async () => { await route.abort("failed"); resolve(); };
      });
    } else await route.fulfill({ json: { job: { id: 99 } } });
  });
  const dialog = await openRun(page);
  await dialog.getByTestId("select-run-target").click();
  await page.getByRole("option", { name: /Any public agent/ }).click();
  await dialog.getByRole("button", { name: "Run Evaluation", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Another owner scenario" }).click();
  await expect(dialog.getByRole("combobox").first()).toContainText("Another owner scenario");
  await rejectFirst!();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[1].evalSetId).toBe(scenario.id);
  await expect(dialog).toBeHidden();
});

test("public trials default off and require an explicit positive owner budget", async ({ page }) => {
  await mockPage(page);
  let saved: Record<string, unknown> | undefined;
  await page.route("**/api/credential-trials/personal", async (route) => {
    if (route.request().method() === "PUT") saved = route.request().postDataJSON();
    await route.fulfill({ json: saved ? { ...saved, used30Days: 0 } : { enabled: false, maxRuns30Days: 0, used30Days: 0 } });
  });
  await page.goto("/console/secrets");
  const settings = page.getByTestId("trial-settings-personal");
  await expect(settings.getByRole("switch")).not.toBeChecked();
  await settings.getByRole("switch").check();
  await expect(settings.getByRole("button", { name: "Save trial settings" })).toBeDisabled();
  await settings.getByRole("spinbutton").fill("25");
  await settings.getByRole("button", { name: "Save trial settings" }).click();
  await expect.poll(() => saved).toEqual({ enabled: true, maxRuns30Days: 25 });
});
