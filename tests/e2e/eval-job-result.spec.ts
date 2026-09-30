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
    // Not measured shows as N/A, never as a number: the latency boxes (this
    // result has no interruptions) and Other Metrics alike.
    await expect(page.getByText("Interrupt Latency", { exact: true }).locator("../..")).toContainText("N/A");
    for (const metric of ["Network", "Naturalness", "Noise Red."]) {
      await expect(page.getByText(metric, { exact: true }).locator("..")).toContainText("N/A");
    }
    await expect(page.getByText("Naturalness", { exact: true }).locator("..")).not.toContainText("/5");
  } finally {
    await pool.query("DELETE FROM eval_jobs WHERE id = $1", [job.id]);
  }
});

// #217: nothing measures Network / Naturalness / Noise yet, so the leaderboard
// shows N/A for them — never "null%" or "null/5.0" (what it rendered before).
test("the leaderboard shows N/A, not null, for what isn't measured", async ({ page }) => {
  test.skip(!process.env.DATABASE_URL, "needs the dev DB");
  test.setTimeout(90_000);
  const { storage, pool } = await import("../../server/storage");
  // A provider of its own with one mainline result (public + mainline flow and
  // set, principal creator, public agent) that measured none of the three.
  const name = `E2E N/A Provider ${Date.now()}`;
  const provider = await storage.createProvider({ name, sku: "convoai", description: "e2e" } as any);
  const scoutId = (await pool.query("SELECT id FROM users WHERE email = $1", ["scout@vox.ai"])).rows[0].id as number;
  const mainline = { visibility: "public", isMainline: true, config: {}, ownerId: scoutId };
  const job = await storage.createEvalJob({
    evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: scoutId, siteId: null, targetRegion: null, targetTier: null, config: {},
    snapshot: { provider: { id: provider.id, name, platformId: null }, evalFlow: { name: "f", organizationId: null, ...mainline }, evalSet: { name: "s", ...mainline }, creatorPlan: "principal" } as any,
    status: "completed", priority: 0, retryCount: 0, maxRetries: 3, tokenDispatchTier: "public",
  } as any);
  try {
    // A site in an active region: the board's default scope is the regions.
    const base = (await storage.getAllRegionLocations()).find((l) => l.isActive)!.baseId;
    await storage.createEvalResult({
      evalJobId: job.id, providerId: provider.id, siteId: `${base}-01`, responseLatencyMedian: 1000,
      networkResilience: null, naturalness: null, noiseReduction: null,
    } as any);
    // The leaderboard response is cached for 30 s: let a cached copy expire.
    await page.waitForTimeout(31_000);
    await page.goto(`${BASE}/leaderboard`);
    const row = page.getByRole("row").filter({ hasText: name });
    await expect(row).toBeVisible();
    // Each of the three cells says N/A (the old page printed a bare "%").
    for (const cell of ["text-network-", "text-naturalness-", "text-noise-"]) {
      await expect(row.locator(`[data-testid^="${cell}"]`)).toHaveText("N/A");
    }
  } finally {
    await pool.query("DELETE FROM eval_jobs WHERE id = $1", [job.id]);
    await pool.query("DELETE FROM providers WHERE id = $1", [provider.id]);
  }
});
