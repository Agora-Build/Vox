import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { makeConversationWav } from "../fixtures/make-conversation-wav";

/**
 * Tools → Analyze in the console (design 2026-09-30): the collapsible Tools
 * group, the storage gate, and an upload analyzed by the local eval agent,
 * shown in the shared result view.
 */

const BASE = "http://localhost:5000";
const PASSWORD = "TestPass123!";

async function newPremiumUser(playwright: { request: { newContext: (o: { baseURL: string }) => Promise<APIRequestContext> } }) {
  const admin = await playwright.request.newContext({ baseURL: BASE });
  await admin.post("/api/auth/login", { data: { email: "admin@vox.local", password: "admin123456" } });
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `e2e-analyze-${stamp}@example.com`;
  const { token } = await (await admin.post("/api/admin/invite", { data: { email, plan: "premium" } })).json();
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post("/api/auth/register", { data: { username: `e2eanalyze${stamp}`, password: PASSWORD, token } })).ok()).toBe(true);
  await api.post("/api/auth/login", { data: { email, password: PASSWORD } });
  await admin.dispose();
  return { email, api };
}

async function loginUI(page: Page, email: string) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/console/);
}

test.describe("Tools → Analyze", () => {
  test("without storage: the page says to set it up; the Tools group folds and remembers", async ({ page, playwright }) => {
    test.setTimeout(90_000);
    const { email, api } = await newPremiumUser(playwright);
    try {
      await loginUI(page, email);
      await page.goto(`${BASE}/console/tools/analyze`);
      await expect(page.getByTestId("analyze-needs-storage")).toContainText("Set up your storage first");
      await expect(page.getByRole("link", { name: "Set up storage" })).toHaveAttribute("href", "/console/storage-settings");

      const analyzeLink = page.getByTestId("sidebar-tool-analyze");
      await expect(analyzeLink).toBeVisible();
      await page.getByTestId("sidebar-tools-toggle").click();
      await expect(analyzeLink).toBeHidden();
      await page.reload();
      await expect(page.getByTestId("sidebar-tools-toggle")).toBeVisible();
      await expect(page.getByTestId("sidebar-tool-analyze")).toBeHidden(); // stayed closed
      await page.getByTestId("sidebar-tools-toggle").click();
      await expect(page.getByTestId("sidebar-tool-analyze")).toBeVisible();
    } finally {
      await api.dispose();
    }
  });

  test("upload a recording, see it analyzed, open the result, delete it", async ({ page, playwright }) => {
    const s3 = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].map((k) => process.env[k]);
    test.skip(s3.some((v) => !v), "needs S3 settings in the environment (.env)");
    test.setTimeout(5 * 60_000);
    const { email, api } = await newPremiumUser(playwright);
    const wavPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2e-analyze-")), "conversation.wav");
    fs.writeFileSync(wavPath, makeConversationWav());
    try {
      expect((await api.put("/api/user/storage-config", {
        data: { s3Endpoint: s3[0], s3Bucket: s3[1], s3AccessKeyId: s3[2], s3SecretAccessKey: s3[3], s3Region: process.env.S3_REGION || "auto" },
      })).ok()).toBe(true);

      await loginUI(page, email);
      await page.goto(`${BASE}/console/tools/analyze`);
      await page.getByTestId("analyze-file-input").setInputFiles(wavPath);
      await expect(page.getByTestId("analyze-file-row")).toContainText("conversation.wav");
      const submit = page.getByTestId("analyze-submit");
      await expect(submit).toBeDisabled(); // nothing chosen yet

      // Options may be scrolled out of a long list: focus, then Enter.
      const pick = async (which: string, option: string | RegExp) => {
        await page.getByTestId(`analyze-all-${which}`).click();
        await page.getByRole("option", { name: option }).first().focus();
        await page.keyboard.press("Enter");
      };
      await pick("provider", "Agora ConvoAI Engine");
      await pick("region", /.+/);
      await pick("source", "Web session");
      await expect(page.getByTestId("analyze-all-provider")).toContainText("Agora ConvoAI Engine");
      await expect(submit).toBeEnabled();
      await submit.click();

      const row = page.getByTestId("analyze-row").filter({ hasText: "conversation.wav" });
      await expect(row).toBeVisible();
      await expect(page.getByTestId("analyze-file-row")).toHaveCount(0); // the picker cleared

      // The local agent analyzes it (the list refreshes itself).
      await expect(row).toContainText("Done", { timeout: 4 * 60_000 });
      await row.getByRole("link", { name: "conversation.wav" }).click();
      await expect(page.getByTestId("analysis-title")).toContainText("conversation.wav");
      await expect(page.getByText("Response Latency", { exact: true })).toBeVisible();
      await expect(page.getByText("3 turns")).toBeVisible(); // the three turns we built
      await expect(page.getByTestId("analysis-download")).toBeVisible();

      await page.getByRole("link", { name: "Analyze" }).first().click();
      await row.getByTestId("analyze-delete").click();
      await page.getByTestId("analyze-delete-confirm").click();
      await expect(page.getByTestId("analyze-row").filter({ hasText: "conversation.wav" })).toHaveCount(0);
    } finally {
      await api.delete("/api/user/storage-config");
      await api.dispose();
    }
  });

  test("a marketplace agent, for credits: cost shown, consent required, marked on the row", async ({ page, playwright }) => {
    const s3 = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].map((k) => process.env[k]);
    test.skip(s3.some((v) => !v), "needs S3 settings in the environment (.env)");
    test.setTimeout(3 * 60_000);
    const { email, api } = await newPremiumUser(playwright);
    const admin = await playwright.request.newContext({ baseURL: BASE });
    await admin.post("/api/auth/login", { data: { email: "admin@vox.local", password: "admin123456" } });
    const wavPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2e-analyze-")), "paid.wav");
    fs.writeFileSync(wavPath, makeConversationWav());
    // A marketplace agent (the admin's) that can analyze, at 7 credits a file.
    const base = (await (await admin.get("/api/region-locations")).json()).find((r: { isActive: boolean }) => r.isActive).baseId;
    const tok = await (await admin.post("/api/eval-agent-tokens", { data: { name: `e2e-paid-${Date.now()}`, regionLocationBaseId: base, dispatchTier: "public" } })).json();
    try {
      const reg = await admin.post("/api/eval-agent/register", { headers: { Authorization: `Bearer ${tok.token}` }, data: { name: "e2e-paid-agent", capabilities: ["analyze"] } });
      expect(reg.ok()).toBe(true);
      expect((await admin.patch(`/api/eval-agent-tokens/${tok.id}`, { data: { dispatchTier: "shared", pricePerUnit: 7 } })).ok()).toBe(true);
      const me = await (await api.get("/api/auth/status")).json();
      expect((await admin.post("/api/plugins/credits/grants", { data: { userId: me.user.id, credits: 50, reason: "e2e", idempotencyKey: `e2e-paid-${Date.now()}` } })).ok()).toBe(true);
      expect((await api.put("/api/user/storage-config", {
        data: { s3Endpoint: s3[0], s3Bucket: s3[1], s3AccessKeyId: s3[2], s3SecretAccessKey: s3[3], s3Region: process.env.S3_REGION || "auto" },
      })).ok()).toBe(true);

      await loginUI(page, email);
      await page.goto(`${BASE}/console/tools/analyze`);
      await page.getByTestId("analyze-file-input").setInputFiles(wavPath);
      const pick = async (testId: string, option: string | RegExp) => {
        await page.getByTestId(testId).click();
        await page.getByRole("option", { name: option }).first().focus();
        await page.keyboard.press("Enter");
      };
      await pick("analyze-all-provider", "Agora ConvoAI Engine");
      await pick("analyze-all-region", /.+/);
      await pick("analyze-all-source", "Web session");
      const submit = page.getByTestId("analyze-submit");
      await expect(submit).toBeEnabled(); // free: no consent needed

      await pick("analyze-run-on", /7 credits per file/);
      await expect(page.getByTestId("analyze-cost")).toContainText("1 file × 7 = 7 credits");
      await expect(page.getByTestId("analyze-cost")).toContainText("you have 50");
      await expect(submit).toBeDisabled(); // consent first
      await page.getByTestId("analyze-consent").click();
      await expect(submit).toBeEnabled();
      await submit.click();

      const row = page.getByTestId("analyze-row").filter({ hasText: "paid.wav" });
      await expect(row).toContainText("Marketplace");
      expect((await (await api.get("/api/plugins/credits/balance")).json()).credits).toBe(43); // 7 held
    } finally {
      // Delete the queued paid analysis (the sweep refunds its hold), then tidy up.
      for (const a of await (await api.get("/api/tools/analyze")).json()) await api.delete(`/api/tools/analyze/${a.id}`);
      await api.delete("/api/user/storage-config");
      await admin.post(`/api/eval-agent-tokens/${tok.id}/revoke`);
      await api.dispose();
      await admin.dispose();
    }
  });
});
