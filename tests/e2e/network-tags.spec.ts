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
      // .first(): Radix Toast also renders a visually hidden announcement copy of
      // the text for ~1 s, so a bare getByText can match two elements.
      await expect(page.getByText("Eval Flow created").first()).toBeVisible();

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

  test("the access toggle filters the leaderboard and real-time views through the URL", async ({ page }) => {
    test.skip(!process.env.DATABASE_URL, "needs the dev DB");
    test.setTimeout(60_000);
    const { storage, pool } = await import("../../server/storage");
    const stamp = `${Date.now()}`;
    const name = `E2E Access Provider ${stamp}`;
    // A run-unique custom tag on every view: the console caches metrics by
    // parameters for 30 s, so a plain /leaderboard could serve a pre-seed answer.
    const RUN = `e2e-${stamp}`;
    const provider = await storage.createProvider({ name, sku: "convoai", description: "e2e", createdAt: new Date("2000-01-01T00:00:00Z") } as any);
    const scoutId = (await pool.query("SELECT id FROM users WHERE email = $1", ["scout@vox.ai"])).rows[0].id as number;
    const base = (await storage.getAllRegionLocations()).find((l) => l.isActive)!.baseId;
    const mainline = { visibility: "public", isMainline: true, config: {}, ownerId: scoutId };
    const jobIds: number[] = [];
    const seed = async (access: string, latency: number) => {
      const job = await storage.createEvalJob({
        evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: scoutId, siteId: `${base}-01`, targetRegion: null, targetTier: null, config: {},
        snapshot: { provider: { id: provider.id, name, platformId: null }, evalFlow: { name: "f", organizationId: null, ...mainline }, evalSet: { name: "s", ...mainline }, creatorPlan: "principal", transport: "web" } as any,
        status: "completed", priority: 0, retryCount: 0, maxRetries: 3, tokenDispatchTier: "public",
      } as any);
      jobIds.push(job.id);
      await pool.query("UPDATE eval_jobs SET completed_at = now(), tags = $2::jsonb WHERE id = $1",
        [job.id, JSON.stringify([{ key: "access", value: access, source: "detected", reason: "v1: test" }, { key: "run", value: RUN, source: "flow" }])]);
      await storage.createEvalResult({ evalJobId: job.id, providerId: provider.id, siteId: `${base}-01`, responseLatencyMedian: latency } as any);
    };
    try {
      await seed("lastmile", 1010);
      await seed("datacenter", 2030);

      await page.goto(`/leaderboard?tag=run%3A${RUN}`);
      const rows = page.getByRole("row").filter({ hasText: name });
      await expect(rows).toHaveCount(1);
      // All (default): the row averages both, and shows the split under it.
      await expect(page.getByTestId("access-toggle-all")).toHaveAttribute("data-state", "on");
      await expect(rows).toContainText("1520");
      await expect(rows.locator('[data-testid^="text-response-access-"]')).toHaveText("1010 / 2030");
      await expect(rows.locator('[data-testid^="text-access-count-"]')).toHaveText("1 / 1");

      // Last mile: the filter lands in the URL and the tag chips; the split column goes.
      await page.getByTestId("access-toggle-lastmile").click();
      await expect(page).toHaveURL(/tag=access%3Alastmile/);
      await expect(page.getByTestId("metrics-tag-filter-chip-access")).toHaveText("access:lastmile");
      await expect(rows).toContainText("1010");
      await expect(rows).not.toContainText("2030");
      await expect(page.getByTestId("header-access")).toHaveCount(0);

      await page.getByTestId("access-toggle-datacenter").click();
      await expect(page).toHaveURL(/tag=access%3Adatacenter/);
      await expect(page).not.toHaveURL(/access%3Alastmile/);
      await expect(rows).toContainText("2030");

      await page.getByTestId("access-toggle-all").click();
      await expect(page).not.toHaveURL(/tag=access/);
      await expect(page).toHaveURL(new RegExp(`tag=run%3A${RUN}`)); // other filters stay
      await expect(rows).toContainText("1520");

      // A filter the toggle has no button for (access:unknown): no button is
      // pressed — not All — and the split columns stay hidden.
      await page.goto(`/leaderboard?tag=run%3A${RUN}&tag=access%3Aunknown`);
      await expect(page.getByTestId("metrics-tag-filter-chip-access")).toHaveText("access:unknown");
      for (const v of ["all", "lastmile", "datacenter"]) {
        await expect(page.getByTestId(`access-toggle-${v}`)).toHaveAttribute("data-state", "off");
      }
      await expect(page.getByTestId("header-access")).toHaveCount(0);

      // Real-time reads the same URL state.
      await page.goto("/realtime?tag=access%3Adatacenter");
      await expect(page.getByTestId("access-toggle-datacenter")).toHaveAttribute("data-state", "on");
      await page.getByTestId("access-toggle-all").click();
      await expect(page).not.toHaveURL(/tag=access/);

      // "Region" in Group by: the leaderboard splits each row by the site's region.
      await page.goto(`/leaderboard?tag=run%3A${RUN}`);
      await selectOption(page, "select-group-by", "Group by region");
      await expect(page).toHaveURL(/groupBy=region/);
      await expect(page.getByTestId("header-group")).toHaveText("region");
      await expect(rows).toHaveCount(1);
    } finally {
      await pool.query("DELETE FROM eval_jobs WHERE id = ANY($1)", [jobIds]);
      await pool.query("DELETE FROM providers WHERE id = $1", [provider.id]);
    }
  });

  test("the Agents page badge follows location trust and access", async ({ page }) => {
    test.skip(!process.env.DATABASE_URL, "needs the dev DB");
    const { pool } = await import("../../server/storage");
    const stamp = `${Date.now()}`;
    const tokenIds: number[] = [];
    const agentIds: number[] = [];
    try {
      // One agent per token (a re-register reuses the row), so one token each.
      const register = async (n: string) => {
        const tok = await (await page.request.post("/api/eval-agent-tokens", { data: { name: `e2e-access-${n}-${stamp}`, dispatchTier: "private" } })).json();
        tokenIds.push(tok.id);
        return (await (await page.request.post("/api/eval-agent/register", {
          headers: { Authorization: `Bearer ${tok.token}` }, data: { name: `${n} ${stamp}`, metadata: {} },
        })).json()).id as number;
      };
      const lm = await register("e2e lastmile");
      const dc = await register("e2e datacenter");
      const unk = await register("e2e unknown");
      const unv = await register("e2e unverified");
      agentIds.push(lm, dc, unk, unv);
      const set = (id: number, trust: string, access: string, reason: string) =>
        pool.query("UPDATE eval_agents SET location_trust = $2, access_class = $3, access_reason = $4 WHERE id = $1", [id, trust, access, reason]);
      await set(lm, "trusted", "lastmile", "v1: eyeball-asn + residential-rdns");
      await set(dc, "datacenter", "datacenter", "v1: dc-range");
      await set(unk, "trusted", "unknown", "v1: insufficient");
      await set(unv, "low_confidence", "unknown", "v1: private-ip");

      await page.goto("/console/eval-agents");
      await expect(page.getByTestId(`agent-location-badge-${lm}`)).toHaveText("Verified · last mile");
      await expect(page.getByTestId(`agent-location-badge-${dc}`)).toHaveText("Verified · datacenter");
      await expect(page.getByTestId(`agent-location-badge-${unk}`)).toHaveText("Verified");
      await expect(page.getByTestId(`agent-location-badge-${unv}`)).toHaveText("Unverified");
      // The tooltip says why, in plain words.
      await page.getByTestId(`agent-location-badge-${lm}`).hover();
      await expect(page.getByRole("tooltip")).toContainText("home ISP + residential address name");
    } finally {
      if (agentIds.length) await pool.query("DELETE FROM eval_agents WHERE id = ANY($1)", [agentIds]);
      if (tokenIds.length) await pool.query("DELETE FROM eval_agent_tokens WHERE id = ANY($1)", [tokenIds]);
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
