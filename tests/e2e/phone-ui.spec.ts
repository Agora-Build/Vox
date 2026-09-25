import { test, expect } from "@playwright/test";

/**
 * Phone vs Agent UI E2E (Phase D, design 2026-09-21 §11):
 * - evalflow create dialog offers the Evaluation Mode selector; a phone
 *   evalflow persists transport + call.dial Setup Steps and shows the badge
 * - the realtime page carries the Web vs Agent | Phone vs Agent switch and
 *   Phone mode renders without error (empty state is fine)
 */

const BASE = "http://localhost:5000";
const suffix = `${Date.now()}`;
const wfName = `e2e-phone-wf-${suffix}`;

async function loginUI(page: import("@playwright/test").Page) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', "admin@vox.local");
  await page.fill('input[type="password"]', "admin123456");
  await page.click('button[type="submit"]');
  await page.waitForURL(/console/);
}

test.describe("Phone vs Agent UI", () => {
  test.afterAll(async ({ playwright }) => {
    // Cleanup the created evalflow via API.
    const api = await playwright.request.newContext({ baseURL: BASE });
    await api.post("/api/auth/login", { data: { email: "admin@vox.local", password: "admin123456" } });
    const list = await api.get("/api/evalflows?includePublic=true");
    if (list.ok()) {
      const rows = (await list.json()) as Array<{ id: number; name: string }>;
      for (const w of rows.filter((r) => r.name === wfName)) {
        await api.delete(`/api/evalflows/${w.id}`);
      }
    }
    await api.dispose();
  });

  test("create dialog: phone mode persists transport + call.dial Setup Steps and shows the badge", async ({ page }) => {
    await loginUI(page);
    await page.goto(`${BASE}/console/evalflows`);
    await page.getByTestId("button-create-evalflow").click();

    await page.getByTestId("input-evalflow-name").fill(wfName);
    await page.getByTestId("select-evalflow-provider").click();
    await page.getByRole("option").first().click();

    await page.getByTestId("select-evalflow-transport").click();
    await page.getByRole("option", { name: "Phone vs Agent" }).click();
    // Unified steps model: the same Setup/Teardown textareas serve phone mode.
    await page.getByTestId("textarea-evalflow-steps-prefix")
      .fill('- type: call.dial\n  number: "+1 555 010 1234"\n- type: call.wait_answered');
    await page.getByTestId("textarea-evalflow-steps-suffix").fill("- type: call.hangup");

    await page.getByTestId("button-submit-evalflow").click();

    // Row appears with the Phone badge.
    const row = page.getByRole("row", { name: new RegExp(wfName) });
    await expect(row).toBeVisible();
    await expect(row.getByText("Phone", { exact: true })).toBeVisible();

    // Persisted server-side.
    const api = await page.request.get(`${BASE}/api/evalflows?includePublic=true`);
    const rows = (await api.json()) as Array<{ name: string; transport: string; config: { stepsPrefix?: string; stepsSuffix?: string } }>;
    const created = rows.find((r) => r.name === wfName);
    expect(created?.transport).toBe("phone");
    expect(created?.config?.stepsPrefix).toContain("call.dial");
    expect(created?.config?.stepsPrefix).toContain("+1 555 010 1234");
    expect(created?.config?.stepsSuffix).toContain("call.hangup");
  });

  test("realtime page: Evaluation Mode switch renders and Phone mode loads", async ({ page }) => {
    await page.goto(`${BASE}/realtime`);
    await expect(page.getByTestId("tabs-eval-mode")).toBeVisible();
    await expect(page.getByTestId("tab-mode-web")).toHaveAttribute("data-state", "active");

    const phoneFetch = page.waitForResponse((r) => r.url().includes("transport=phone") && r.ok());
    await page.getByTestId("tab-mode-phone").click();
    await phoneFetch; // the switch refetches with the transport param
    await expect(page.getByTestId("tab-mode-phone")).toHaveAttribute("data-state", "active");
  });
});
