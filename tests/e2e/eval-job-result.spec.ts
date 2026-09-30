import { test, expect } from "@playwright/test";

/**
 * The eval job page shows a finished job's result through the shared result
 * view (client/src/components/eval-result-view.tsx, also used by Tools →
 * Analyze): metric cards and the turn-level table with transcripts.
 */

const BASE = "http://localhost:5000";

test("a finished eval job shows its result: cards, turns and transcripts", async ({ page }) => {
  test.skip(!process.env.DATABASE_URL, "needs the dev DB");
  test.setTimeout(60_000);
  const { storage, pool } = await import("../../server/storage");
  const adminId = (await pool.query("SELECT id FROM users WHERE email = $1", ["admin@vox.local"])).rows[0].id as number;
  const provider = (await storage.getAllProviders())[0];
  const job = await storage.createEvalJob({
    evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: adminId,
    siteId: null, targetRegion: null, targetTier: null, config: {},
    snapshot: { provider: { id: provider.id, name: provider.name, platformId: null }, evalFlow: null, evalSet: null, creatorPlan: null } as any,
    status: "completed", priority: 0, retryCount: 0, maxRetries: 3,
  } as any);
  try {
    await storage.createEvalResult({
      evalJobId: job.id, providerId: provider.id, siteId: null,
      responseLatencyMedian: 1234, networkResilience: null, naturalness: null, noiseReduction: null,
      rawData: { response_metrics: { latency: { turn_level: [
        { turn_index: 0, latency_ms: 1234, turn_start: 0.5, turn_end: 3.2, response_kind: "normal_response", user_transcript: "hello there", agent_transcript: "hi, how can I help" },
      ] } } },
    } as any);

    await page.goto(`${BASE}/login`);
    await page.fill('input[type="email"]', "admin@vox.local");
    await page.fill('input[type="password"]', "admin123456");
    await page.click('button[type="submit"]');
    await page.waitForURL(/console/);
    await page.goto(`${BASE}/console/eval-jobs/${job.id}`);

    await expect(page.getByText("Response Latency", { exact: true })).toBeVisible();
    await expect(page.getByText("1234ms").first()).toBeVisible();
    await expect(page.getByText("Response Turn-Level Latency")).toBeVisible();
    await expect(page.getByText("A: hi, how can I help")).toBeVisible();
    // Not measured shows as NA (like the latency cards), never as a number.
    for (const metric of ["Network", "Naturalness", "Noise Red."]) {
      await expect(page.getByText(metric, { exact: true }).locator("..")).toContainText("NA");
    }
    await expect(page.getByText("Naturalness", { exact: true }).locator("..")).not.toContainText("/5");
  } finally {
    await pool.query("DELETE FROM eval_jobs WHERE id = $1", [job.id]);
  }
});
