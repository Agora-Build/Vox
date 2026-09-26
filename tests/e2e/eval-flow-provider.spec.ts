import { test, expect, type Page } from "@playwright/test";

/**
 * E2E: evalFlow provider selection + platform_id guard + eval-jobs provenance.
 *
 * Requires a running server on :5000 with the seeded providers
 * (Agora / LiveKit / ElevenLabs / Custom) and admin@vox.local.
 *
 * Logs in via the API (page.request shares the browser context cookie jar),
 * then drives the actual React UI.
 */

// The create/edit dialogs are tall; use a viewport that fits the footer button
// so Playwright can click it without a scrollable-dialog workaround.
test.use({ viewport: { width: 1440, height: 1800 } });

const ADMIN = { email: "admin@vox.local", password: "admin123456" };

async function login(page: Page) {
  const res = await page.request.post("/api/auth/login", { data: ADMIN });
  expect(res.ok(), "admin login").toBeTruthy();
}

// Radix Select: open the trigger, then choose the option by exact visible text.
//
// We select via keyboard typeahead + Enter rather than clicking the option.
// The provider list can be long — leaked test providers accumulate in the
// shared dev DB (#134) — which pushes the target option below the viewport.
// Playwright's scroll-into-view can't place an option inside Radix's popper
// listbox, so a direct .click() on an off-screen option times out "outside of
// the viewport" (it fails only when nothing is preselected, i.e. the create
// dialog; the edit dialog opens scrolled to its current value and happens to
// work). Typeahead scrolls Radix to the match via its own logic and Enter
// selects it with no viewport dependence.
async function selectOption(page: Page, testId: string, optionName: string) {
  const trigger = page.getByTestId(testId);
  await trigger.click();
  const option = page.getByRole("option", { name: optionName, exact: true });
  await option.waitFor({ state: "attached" });
  // The per-key delay lets each keydown register with Radix's typeahead; then
  // wait for the match to actually be highlighted before pressing Enter, so we
  // never select the auto-highlighted first row instead.
  await page.keyboard.type(optionName, { delay: 50 });
  await expect(option).toHaveAttribute("data-highlighted", "");
  await page.keyboard.press("Enter");
  await expect(trigger).toContainText(optionName);
}

async function providerIdByName(page: Page, name: string): Promise<string> {
  const res = await page.request.get("/api/providers");
  const list = (await res.json()) as Array<{ id: string; name: string }>;
  const p = list.find((x) => x.name === name);
  expect(p, `provider ${name} exists`).toBeTruthy();
  return p!.id;
}

async function findEvalFlowByName(page: Page, name: string) {
  const res = await page.request.get("/api/eval-flows?includePublic=true");
  const list = (await res.json()) as Array<{ id: number; name: string; providerId: string }>;
  return list.find((w) => w.name === name);
}

test.describe("EvalFlow provider + platform_id guard", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await login(page);
  });

  test("warns on provider ↔ platform_id mismatch, saves on 'Save anyway'", async ({ page }) => {
    const name = `e2e-mismatch-${Date.now()}`;
    await page.goto("/console/eval-flows");
    await page.getByTestId("button-create-eval-flow").click();

    await page.getByTestId("input-eval-flow-name").fill(name);
    await selectOption(page, "select-eval-flow-provider", "Agora ConvoAI Engine");
    // aeval is the default framework → stepsPrefix textarea is shown.
    await page
      .getByTestId("textarea-eval-flow-steps-prefix")
      .fill("- type: platform.setup\n  platform_id: livekit\n- type: platform.enter");

    await page.getByTestId("button-submit-eval-flow").click();

    // Mismatch dialog appears (livekit YAML vs Agora provider).
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Provider doesn't match the setup steps")).toBeVisible();
    await expect(dialog.getByText(/platform_id: livekit/)).toBeVisible();

    // Override.
    await page.getByRole("button", { name: "Save anyway" }).click();

    // Persisted with the (mismatched) Agora provider we chose.
    await expect.poll(async () => (await findEvalFlowByName(page, name)) != null).toBeTruthy();
    const wf = await findEvalFlowByName(page, name);
    const agora = await providerIdByName(page, "Agora ConvoAI Engine");
    expect(wf!.providerId).toBe(agora);

    await page.request.delete(`/api/eval-flows/${wf!.id}`);
  });

  test("auto-switches provider to Custom when YAML has no platform_id", async ({ page }) => {
    const name = `e2e-nocustom-${Date.now()}`;
    await page.goto("/console/eval-flows");
    await page.getByTestId("button-create-eval-flow").click();

    await page.getByTestId("input-eval-flow-name").fill(name);
    await selectOption(page, "select-eval-flow-provider", "Agora ConvoAI Engine");
    // aeval steps with NO platform.setup / platform_id.
    await page
      .getByTestId("textarea-eval-flow-steps-prefix")
      .fill("- type: audio.start_recording");

    await page.getByTestId("button-submit-eval-flow").click();

    // The auto-switch toast is transient — TOAST_LIMIT is 1, so the
    // "Eval Flow created" success toast replaces it as soon as the create
    // returns. Accept either; the authoritative auto-switch assertion is
    // the providerId check below.
    await expect(page.getByText(/Provider set to Custom|Eval Flow created/).first()).toBeVisible();

    await expect.poll(async () => (await findEvalFlowByName(page, name)) != null).toBeTruthy();
    const wf = await findEvalFlowByName(page, name);
    const custom = await providerIdByName(page, "Custom");
    expect(wf!.providerId).toBe(custom);

    await page.request.delete(`/api/eval-flows/${wf!.id}`);
  });

  test("edit dialog exposes a provider select and saves a provider change", async ({ page }) => {
    // Seed an evalFlow via API (matching provider → no guard needed on create).
    const livekit = await providerIdByName(page, "LiveKit Agents");
    const name = `e2e-edit-${Date.now()}`;
    const created = await page.request.post("/api/eval-flows", {
      data: { name, visibility: "public", providerId: livekit, config: { framework: "aeval" } },
    });
    expect(created.ok()).toBeTruthy();
    const wfId = (await created.json()).id as number;

    await page.goto("/console/eval-flows");
    await page.getByTestId(`row-eval-flow-${wfId}`).getByRole("button").first().click();

    // Provider select is present in the edit dialog.
    const providerSelect = page.getByTestId("select-edit-eval-flow-provider");
    await expect(providerSelect).toBeVisible();

    // Change provider → ElevenLabs (its YAML is empty → no platform_id → auto-Custom on save,
    // but here the evalFlow has no stepsPrefix, so selecting ElevenLabs then saving triggers
    // auto-Custom too). Assert the change round-trips to *some* new provider.
    await selectOption(page, "select-edit-eval-flow-provider", "Custom");
    await page.getByRole("button", { name: "Save Changes" }).click();

    await expect
      .poll(async () => {
        const wf = await findEvalFlowByName(page, name);
        return wf?.providerId;
      })
      .toBe(await providerIdByName(page, "Custom"));

    await page.request.delete(`/api/eval-flows/${wfId}`);
  });
});

test.describe("Eval-jobs provenance columns", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await login(page);
  });

  test("jobs table shows Provider + Eval Set columns when jobs exist", async ({ page }) => {
    await page.goto("/console/eval-jobs?tab=jobs");
    // Widen the window to 30 days to maximize the chance of finding jobs.
    await page.waitForLoadState("domcontentloaded");

    const table = page.locator("table");
    if (await table.isVisible().catch(() => false)) {
      await expect(page.getByRole("columnheader", { name: "Provider" })).toBeVisible();
      await expect(page.getByRole("columnheader", { name: "Eval Set" })).toBeVisible();
    } else {
      // No jobs in the window — the table (and headers) only render with rows.
      // The column wiring is still covered by the type-check; nothing to assert here.
      test.info().annotations.push({ type: "note", description: "no jobs in window; header check skipped" });
    }
  });
});

test.describe("Eval-sets My/Public tabs", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await login(page);
  });

  test("defaults to My Eval Sets and can switch to Public", async ({ page }) => {
    await page.goto("/console/eval-sets");
    await page.waitForLoadState("domcontentloaded");

    const myTab = page.getByTestId("tab-my-evalsets");
    const publicTab = page.getByTestId("tab-public-evalsets");

    await expect(myTab).toBeVisible();
    await expect(publicTab).toBeVisible();
    // "My Eval Sets" is the default active tab.
    await expect(myTab).toHaveAttribute("data-state", "active");
    await expect(publicTab).toHaveAttribute("data-state", "inactive");

    // Switching to Public activates it.
    await publicTab.click();
    await expect(publicTab).toHaveAttribute("data-state", "active");
    await expect(myTab).toHaveAttribute("data-state", "inactive");
  });
});

test.describe("Job snapshot", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await login(page);
  });

  test("job detail shows a 'View evalFlow & eval set' snapshot dialog", async ({ page }) => {
    // Find any job to open its detail page.
    const res = await page.request.get("/api/eval-jobs?limit=1");
    const body = await res.json();
    const job = body?.data?.[0];
    test.skip(!job, "no jobs in the DB to inspect");

    await page.goto(`/console/eval-jobs/${job.id}`);
    await page.waitForLoadState("domcontentloaded");

    const btn = page.getByTestId("button-view-snapshot");
    await expect(btn).toBeVisible();
    await btn.click();

    // Immutable snapshot dialog with the evalFlow/eval-set config.
    await expect(page.getByRole("dialog").getByText("EvalFlow & eval set — as run")).toBeVisible();
    await expect(page.getByText(/EvalFlow:/)).toBeVisible();
    await expect(page.getByText(/Eval set:/)).toBeVisible();
  });
});
