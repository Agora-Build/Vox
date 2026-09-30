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
});
