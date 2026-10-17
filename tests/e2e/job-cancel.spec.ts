import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

/**
 * Cancelling a pending job from its page: the button is offered to the job's
 * runner, asks for confirmation, and the job then reads Cancelled (not a red
 * Failed) with who cancelled it — on the page and in the jobs list.
 */

const BASE = "http://localhost:5000";
const PASSWORD = "TestPass123!";

async function newPremiumUser(playwright: { request: { newContext: (o: { baseURL: string }) => Promise<APIRequestContext> } }) {
  const admin = await playwright.request.newContext({ baseURL: BASE });
  await admin.post("/api/auth/login", { data: { email: "admin@vox.local", password: "admin123456" } });
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `e2e-cancel-${stamp}@example.com`;
  const username = `e2ecancel${stamp}`;
  const { token } = await (await admin.post("/api/admin/invite", { data: { email, plan: "premium" } })).json();
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post("/api/auth/register", { data: { username, password: PASSWORD, token } })).ok()).toBe(true);
  await api.post("/api/auth/login", { data: { email, password: PASSWORD } });
  await admin.dispose();
  return { email, username, api };
}

async function loginUI(page: Page, email: string) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/console/);
}

test("a pending job can be cancelled from its page, and then reads Cancelled", async ({ page, playwright }) => {
  test.setTimeout(90_000);
  const { email, username, api } = await newPremiumUser(playwright);
  // A pending job nobody will take: a private-pool run from a user with no agents (like a job waiting for an agent that doesnt exist).
  const providerId = (await (await api.get("/api/providers")).json())[0].id;
  const flow = await (await api.post("/api/eval-flows", { data: { name: `e2e-cancel-${Date.now()}`, providerId, config: { framework: "aeval" } } })).json();
  const set = await (await api.post("/api/eval-sets", { data: { name: `e2e-cancel-${Date.now()}`, config: {} } })).json();
  const run = await api.post(`/api/eval-flows/${flow.id}/run`, { data: { evalSetId: set.id, targetTier: "private", region: "na-us-seattle" } });
  expect(run.ok()).toBe(true);
  const jobId = (await run.json()).job.id;

  await loginUI(page, email);
  await page.goto(`${BASE}/console/eval-jobs/${jobId}`);
  await expect(page.getByText("Pending", { exact: true })).toBeVisible();

  // Cancel → confirm.
  await page.getByTestId("button-cancel-job").click();
  await expect(page.getByText(`Cancel job #${jobId}?`)).toBeVisible();
  await page.getByTestId("button-confirm-cancel-job").click();

  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(page.getByTestId("job-cancelled")).toContainText(`Cancelled by ${username}`);
  await expect(page.getByTestId("button-cancel-job")).toHaveCount(0);
  await expect(page.getByText("Cancelled by user")).toHaveCount(0); // not shown as a red error

  // The jobs list says so too.
  await page.goto(`${BASE}/console/eval-jobs?tab=jobs`);
  await expect(page.getByTestId(`row-job-${jobId}`)).toContainText("cancelled");
  await api.dispose();
});
