import { test, expect, type Page } from "@playwright/test";

/**
 * E2E: network tags in the console (designs/2026-10-22-network-tags-design.md
 * "Console UI"): tag an eval flow and see it saved; filter and group the
 * leaderboard by a tag, from the URL and from the controls; the admin Twilio
 * Lookup card renders (no credentials are saved).
 */

// The create dialog is tall; fit its footer button without scrolling.
test.use({ viewport: { width: 1440, height: 1800 } });

const ADMIN = { email: "admin@vox.local", password: "admin123456" };

async function login(page: Page) {
  const res = await page.request.post("/api/auth/login", { data: ADMIN });
  expect(res.ok(), "admin login").toBeTruthy();
}

// Radix Select by keyboard typeahead (see eval-flow-provider.spec.ts for why not a click).
async function selectOption(page: Page, testId: string, optionName: string) {
  const trigger = page.getByTestId(testId);
  await trigger.click();
  const option = page.getByRole("option", { name: optionName, exact: true });
  await option.waitFor({ state: "attached" });
  await page.keyboard.type(optionName, { delay: 50 });
  await expect(option).toHaveAttribute("data-highlighted", "");
  await page.keyboard.press("Enter");
  await expect(trigger).toContainText(optionName);
}

test.describe("network tags", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await login(page);
  });

  test("tag an eval flow: invalid tags are refused inline, valid ones are saved", async ({ page }) => {
    const name = `e2e-tags-${Date.now()}`;
    let flowId: number | undefined;
    try {
      await page.goto("/console/eval-flows");
      await page.getByTestId("button-create-eval-flow").click();
      await page.getByTestId("input-eval-flow-name").fill(name);
      await selectOption(page, "select-eval-flow-provider", "Custom");
      // Phone flows say their dialled number goes to Twilio Lookup; web flows don't.
      await expect(page.getByTestId("eval-flow-lookup-disclosure")).toHaveCount(0);
      await selectOption(page, "select-eval-flow-transport", "Phone vs Agent");
      await expect(page.getByTestId("eval-flow-lookup-disclosure")).toContainText("checked with Twilio Lookup");
      await selectOption(page, "select-eval-flow-transport", "Web vs Agent");

      const field = page.getByTestId("eval-flow-tags-field");
      // link is a closed set: the error shows before any save.
      await field.fill("link:carrier-pigeon");
      await field.press("Enter");
      await expect(page.getByTestId("eval-flow-tags-error")).toContainText("must be one of wifi, ethernet, cellular, satellite");
      // A flow takes line + custom keys: isp belongs to the agent (same rule as the server).
      await field.fill("isp:starlink");
      await field.press("Enter");
      await expect(page.getByTestId("eval-flow-tags-error")).toContainText("set it on the agent, not the flow");
      await expect(page.getByTestId("eval-flow-tags-chip-isp")).toHaveCount(0);
      // access and sim are system-only: refused on every end, with why.
      await field.fill("access:lastmile");
      await field.press("Enter");
      await expect(page.getByTestId("eval-flow-tags-error")).toContainText("access is set by Vox from the eval agent's network — it can't be set by hand");
      await field.fill("sim:t-mobile");
      await field.press("Enter");
      await expect(page.getByTestId("eval-flow-tags-error")).toContainText("sim is detected from the phone's SIM and its number — it can't be set by hand");
      await expect(page.getByTestId("eval-flow-tags-chip-access")).toHaveCount(0);
      await expect(page.getByTestId("eval-flow-tags-chip-sim")).toHaveCount(0);
      // ...and none of them is ever offered as a suggestion.
      await field.fill("");
      await expect(page.getByTestId("eval-flow-tags-suggestions")).not.toContainText("isp:");
      await expect(page.getByTestId("eval-flow-tags-suggestions")).not.toContainText("access:");
      await expect(page.getByTestId("eval-flow-tags-suggestions")).not.toContainText("sim:");
      // Normalised the same way the server does.
      await field.fill("Line : Twilio");
      await field.press("Enter");
      await field.fill("codec:opus");
      await field.press("Enter");
      await expect(page.getByTestId("eval-flow-tags-chip-line")).toHaveText("line:twilio");
      await expect(page.getByTestId("eval-flow-tags-chip-codec")).toHaveText("codec:opus");

      await page.getByTestId("button-submit-eval-flow").click();
      await expect(page.getByText("Eval Flow created")).toBeVisible();

      const list = (await (await page.request.get("/api/eval-flows")).json()) as Array<{ id: number; name: string; tags: Array<{ key: string; value: string }> }>;
      const flow = list.find((f) => f.name === name);
      expect(flow, "flow saved").toBeTruthy();
      flowId = flow!.id;
      expect(flow!.tags).toEqual([{ key: "line", value: "twilio" }, { key: "codec", value: "opus" }]);

      await page.goto(`/console/eval-flows/${flowId}`);
      await expect(page.getByTestId("eval-flow-tags")).toContainText("line:twilio");
      await expect(page.getByTestId("eval-flow-tags")).toContainText("codec:opus");
    } finally {
      if (flowId) await page.request.delete(`/api/eval-flows/${flowId}`);
    }
  });

  test("filter and group the leaderboard by a tag", async ({ page }) => {
    test.skip(!process.env.DATABASE_URL, "needs the dev DB");
    test.setTimeout(60_000);
    const { storage, pool } = await import("../../server/storage");
    // Run-unique tag values: the leaderboard caches by parameters, and nothing
    // else on the shared dev DB can match them.
    const stamp = `${Date.now()}`;
    const STARLINK = `starlink-${stamp}`, TWILIO = `twilio-${stamp}`, TELNYX = `telnyx-${stamp}`;
    const name = `E2E Tags Provider ${stamp}`;
    // Old timestamp: sorts last in /api/providers, so no other suite picks it (see eval-job-result.spec.ts).
    const provider = await storage.createProvider({ name, sku: "convoai", description: "e2e", createdAt: new Date("2000-01-01T00:00:00Z") } as any);
    const scoutId = (await pool.query("SELECT id FROM users WHERE email = $1", ["scout@vox.ai"])).rows[0].id as number;
    const base = (await storage.getAllRegionLocations()).find((l) => l.isActive)!.baseId;
    const mainline = { visibility: "public", isMainline: true, config: {}, ownerId: scoutId };
    const jobIds: number[] = [];
    const seed = async (tags: Array<{ key: string; value: string; source: string }>, latency: number) => {
      const job = await storage.createEvalJob({
        evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: scoutId, siteId: `${base}-01`, targetRegion: null, targetTier: null, config: {},
        snapshot: { provider: { id: provider.id, name, platformId: null }, evalFlow: { name: "f", organizationId: null, ...mainline }, evalSet: { name: "s", ...mainline }, creatorPlan: "principal", transport: "web" } as any,
        status: "completed", priority: 0, retryCount: 0, maxRetries: 3, tokenDispatchTier: "public",
      } as any);
      jobIds.push(job.id);
      await pool.query("UPDATE eval_jobs SET completed_at = now(), tags = $2::jsonb WHERE id = $1", [job.id, JSON.stringify(tags)]);
      await storage.createEvalResult({ evalJobId: job.id, providerId: provider.id, siteId: `${base}-01`, responseLatencyMedian: latency } as any);
    };
    try {
      await seed([{ key: "isp", value: STARLINK, source: "detected" }, { key: "line", value: TWILIO, source: "detected" }], 1000);
      await seed([{ key: "isp", value: STARLINK, source: "detected" }, { key: "line", value: TELNYX, source: "detected" }], 1400);
      await seed([{ key: "line", value: TWILIO, source: "detected" }], 2000); // no isp: filtered out

      // From the URL: filtered to the starlink jobs, one row per line provider.
      await page.goto(`/leaderboard?tag=${encodeURIComponent(`isp:${STARLINK}`)}&groupBy=line`);
      const rows = page.getByRole("row").filter({ hasText: name });
      await expect(rows).toHaveCount(2);
      await expect(page.getByTestId("header-group")).toHaveText("line");
      await expect(rows.filter({ hasText: `line:${TWILIO}` })).toContainText("1000");
      await expect(rows.filter({ hasText: `line:${TELNYX}` })).toContainText("1400");
      await expect(page.getByTestId("metrics-tag-filter-chip-isp")).toHaveText(`isp:${STARLINK}`);

      // From the controls: a different filter, then grouping, mirrored into the URL.
      await page.goto("/leaderboard");
      const field = page.getByTestId("metrics-tag-filter-field");
      // The filter (no end) still takes the system keys, and suggests access's values.
      await field.fill("access:");
      await expect(page.getByTestId("metrics-tag-filter-suggestions")).toContainText("access:lastmile");
      await expect(page.getByTestId("metrics-tag-filter-suggestions")).toContainText("access:datacenter");
      await field.fill("");
      await field.fill(`line:${TWILIO}`);
      await field.press("Enter");
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText("1500"); // the two twilio jobs averaged
      await selectOption(page, "select-group-by", "Group by isp (network)");
      await expect(rows).toHaveCount(2);
      await expect(rows.filter({ hasText: `isp:${STARLINK}` })).toContainText("1000");
      await expect(rows.filter({ hasText: "isp: untagged" })).toContainText("2000");
      await expect(page).toHaveURL(new RegExp(`tag=line%3A${TWILIO}.*groupBy=isp`));
    } finally {
      await pool.query("DELETE FROM eval_jobs WHERE id = ANY($1)", [jobIds]);
      await pool.query("DELETE FROM providers WHERE id = $1", [provider.id]);
    }
  });

  test("the admin Regions page shows the Twilio Lookup card", async ({ page }) => {
    await page.goto("/console/regions");
    const card = page.getByTestId("card-twilio-lookup");
    await expect(card).toBeVisible();
    await expect(card).toContainText("$0.008 per number per month");
    await expect(page.getByTestId("twilio-lookup-status")).toContainText(/On|Off/);
    // Off shows the form; On shows Replace, which opens it. Nothing is saved.
    if (await page.getByTestId("button-twilio-replace").isVisible()) await page.getByTestId("button-twilio-replace").click();
    await expect(card.getByLabel("Account SID")).toBeVisible();
    await expect(card.getByLabel("Auth Token")).toHaveAttribute("type", "password");
  });
});
