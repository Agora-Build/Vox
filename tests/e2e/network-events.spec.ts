import { test, expect, type Page } from "@playwright/test";

async function mockNetworkViews(page: Page, requests: URL[]) {
  const startedAt = "2026-11-05T00:00:00.000Z";
  const event = (id: number, name: string) => ({ id, event: name, source: id === 1 ? "core" : "agent", seq: id, timestamp: Date.parse(startedAt) + id * 1000,
    offsetMs: id * 1000, tags: { link: id === 1 ? "wifi" : "cellular", isp: id === 1 ? "att" : null, line: "twilio" }, changed: id === 2 ? ["link"] : [] });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()); requests.push(url);
    let data: unknown = [];
    if (url.pathname === "/api/auth/status") data = { initialized: true, user: { id: 1, username: "Network owner", isAdmin: false, plan: "premium" } };
    else if (url.pathname === "/api/config") data = {};
    else if (url.pathname === "/api/plugins") data = [];
    else if (url.pathname === "/api/health") data = { status: "operational", agents: { total: 1, online: 1, offline: 0 } };
    else if (url.pathname === "/api/providers") data = [{ id: "alpha", name: "Alpha" }];
    else if (url.pathname === "/api/metrics/network-coverage") data = { stable: 12, changed: 2, unverified: 3 };
    else if (url.pathname === "/api/metrics/available-regions") data = { availableRegions: [], hasUnverified: false };
    else if (url.pathname === "/api/eval-jobs/42/detail") data = { job: { id: 42, kind: "eval", status: "completed", startedAt, completedAt: startedAt,
      createdAt: startedAt, config: {}, snapshot: null, siteId: null, tags: [{ key: "isp", value: "att", source: "detected" }] }, result: null, evalFlowName: "Network test", creatorName: "Owner" };
    else if (url.pathname === "/api/eval-jobs/42/network-events") data = { networkChanged: true, monitoring: "incomplete", changeCount: 1,
      events: url.searchParams.get("cursor") === "2" ? [event(3, "monitoring_end")] : [event(1, "initial"), event(2, "network_change")],
      nextCursor: url.searchParams.get("cursor") === "2" ? null : 2 };
    await route.fulfill({ json: data });
  });
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test.describe(`network policy ${viewport.width}px`, () => {
    test.use({ viewport });
    test("real-time defaults to All with hidden filters; Strict changes requests but not the URL", async ({ page }) => {
      const requests: URL[] = []; await mockNetworkViews(page, requests);
      await page.goto("/realtime");
      const all = page.getByTestId("access-toggle-all");
      const toggle = page.getByRole("switch", { name: "Strict", exact: true });
      const primary = page.getByTestId("realtime-primary-filters");
      const extended = page.getByTestId("realtime-network-filters");
      const tabs = page.getByTestId("realtime-tier-tabs");
      await expect(all).toHaveAttribute("data-state", "on");
      await expect(all).toHaveAttribute("aria-expanded", "false");
      await expect(page).toHaveURL(/\/realtime$/);
      await expect(page.getByTestId("access-toggle-lastmile")).toHaveCount(0);
      await expect(page.getByTestId("metrics-tag-filter")).toHaveCount(0);
      await expect(page.getByTestId("select-group-by")).toHaveCount(0);
      await expect(page.getByTestId("network-policy")).toHaveCount(0);
      await expect.poll(() => requests.some((url) => url.pathname === "/api/metrics/realtime" && url.searchParams.get("network") === "all")).toBe(true);
      expect(requests.some((url) => url.pathname === "/api/metrics/network-coverage")).toBe(false);
      const originalTabs = await tabs.boundingBox();
      await all.click();
      await expect(all).toHaveAttribute("data-state", "off");
      await expect(all).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId("access-toggle-lastmile")).toBeVisible();
      await expect(page.getByTestId("metrics-tag-filter")).toBeVisible();
      await expect(page.getByTestId("select-group-by")).toBeVisible();
      await expect(toggle).not.toBeChecked();
      await expect(page.getByTestId("network-policy")).toHaveText("Strict");
      await expect(extended.getByTestId("access-toggle-lastmile")).toBeVisible();
      await expect(extended.getByTestId("metrics-tag-filter")).toBeVisible();
      await expect(extended.getByTestId("select-group-by")).toBeVisible();
      await expect(primary.getByTestId("strict-network-mode")).toBeVisible();
      await expect(extended.getByTestId("strict-network-mode")).toHaveCount(0);
      expect(await toggle.evaluate((element) => element.previousElementSibling?.textContent)).toBe("Strict");
      expect(await primary.evaluate((element) => element.firstElementChild?.getAttribute("data-testid"))).toBe("network-policy");
      const primaryBounds = await primary.boundingBox();
      const extendedBounds = await extended.boundingBox();
      expect(extendedBounds!.y - primaryBounds!.y - primaryBounds!.height).toBeCloseTo(8, 0);
      if (viewport.width >= 1280) {
        expect((await tabs.boundingBox())!.y).toBeCloseTo(originalTabs!.y, 0);
        const status = await page.getByTestId("text-system-status").boundingBox();
        expect((await tabs.boundingBox())!.y - status!.y - status!.height).toBeCloseTo(32, 0);
      } else {
        expect((await tabs.boundingBox())!.y).toBeGreaterThanOrEqual(extendedBounds!.y + extendedBounds!.height);
      }
      await page.getByRole("button", { name: "About strict mode" }).click();
      await expect(page.getByTestId("strict-network-info")).toContainText("Only fully monitored runs");
      await page.keyboard.press("Escape");
      await toggle.click();
      await expect(toggle).toBeChecked();
      await expect(page).toHaveURL(/\/realtime$/);
      await expect.poll(() => requests.some((url) => url.pathname === "/api/metrics/realtime" && url.searchParams.get("network") === "strict")).toBe(true);
      await expect.poll(() => requests.some((url) => url.pathname === "/api/metrics/available-regions" && url.searchParams.get("network") === "strict")).toBe(true);
      await page.reload();
      await expect(all).toHaveAttribute("data-state", "on");
      await expect(page.getByTestId("network-policy")).toHaveCount(0);
      expect(requests.some((url) => url.pathname === "/api/metrics/network-coverage")).toBe(false);
      expect(await page.locator("body").evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true);
    });
    test("All resets network filters and Strict without changing time, transport or providers", async ({ page }) => {
      const requests: URL[] = []; await mockNetworkViews(page, requests);
      await page.goto("/realtime");
      const all = page.getByTestId("access-toggle-all");
      const toggle = page.getByRole("switch", { name: "Strict", exact: true });
      await all.click();
      await page.getByTestId("metrics-tag-filter-field").fill("isp:att");
      await page.getByTestId("metrics-tag-filter-field").press("Enter");
      await page.getByTestId("access-toggle-datacenter").click();
      await page.getByTestId("select-group-by").click();
      await page.getByRole("option", { name: "Group by isp (network)", exact: true }).click();
      await toggle.click();
      await expect(all).toHaveAttribute("data-state", "off");
      await expect(page.getByTestId("access-toggle-datacenter")).toHaveAttribute("data-state", "on");
      await expect(page.getByTestId("select-group-by")).toContainText("Group by isp");
      await expect(toggle).toBeChecked();
      await page.getByRole("combobox").filter({ hasText: "7 days" }).click();
      await page.getByRole("option", { name: "30 days" }).click();
      await page.getByTestId("tab-mode-phone").click();
      await page.getByTestId("button-provider-filter").click();
      await page.getByTestId("button-providers-none").click();
      await page.keyboard.press("Escape");
      await all.click();
      await expect(all).toHaveAttribute("data-state", "on");
      await expect(page.getByTestId("network-policy")).toHaveCount(0);
      await expect(page).toHaveURL(/\/realtime$/);
      await expect(page.getByRole("combobox").filter({ hasText: "30 days" })).toBeVisible();
      await expect(page.getByTestId("tab-mode-phone")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("button-provider-filter")).toContainText("Providers 0/1");
      await expect.poll(() => requests.some((url) => url.pathname === "/api/metrics/realtime" && url.searchParams.get("network") === "all" && url.searchParams.get("hours") === "720" && url.searchParams.get("transport") === "phone" && !url.searchParams.has("tag") && !url.searchParams.has("groupBy"))).toBe(true);
      await all.click();
      await expect(toggle).not.toBeChecked();
      await expect(page.getByTestId("select-group-by")).toHaveText("No grouping");
      await expect(page.getByTestId("metrics-tag-filter-chip-isp")).toHaveCount(0);
      await page.getByTestId("access-toggle-lastmile").click();
      await expect(page.getByTestId("metrics-tag-filter-chip-access")).toHaveText("access:lastmile");
      await expect(page).toHaveURL(/\/realtime$/);
      await page.getByTestId("access-toggle-lastmile").click();
      await expect(page.getByTestId("metrics-tag-filter-chip-access")).toHaveCount(0);
      await all.click();
      for (const [tab, endpoint] of [["Community", "community"], ["My Evals", "my-evals"]]) {
        await page.getByRole("tab", { name: tab, exact: true }).click();
        await expect(page.getByTestId("network-policy")).toHaveCount(0);
        await expect.poll(() => requests.some((url) => url.pathname === `/api/metrics/${endpoint}` && url.searchParams.get("network") === "all")).toBe(true);
        await all.click();
        await expect(toggle).not.toBeChecked();
        await all.click();
      }
    });
    for (const pageName of ["realtime", "leaderboard"]) {
      test(`${pageName} ignores legacy filter URLs and preserves unrelated URL state`, async ({ page }) => {
        const requests: URL[] = []; await mockNetworkViews(page, requests);
        const endpoint = pageName === "realtime" ? "my-evals" : "leaderboard";
        for (const network of ["all", "strict"]) {
          requests.length = 0;
          await page.goto(`/${pageName}?tab=my-evals&tag=isp%3Aatt&tag=access%3Adatacenter&groupBy=link&network=${network}#saved`);
          await expect(page).toHaveURL(new RegExp(`/${pageName}\\?tab=my-evals#saved$`));
          await expect(page.getByTestId("access-toggle-all")).toHaveAttribute("data-state", "on");
          await expect(page.getByTestId(`${pageName}-network-filters`)).toHaveCount(0);
          await expect(page.getByTestId("network-policy")).toHaveCount(0);
          await expect.poll(() => requests.some((url) => url.pathname === `/api/metrics/${endpoint}`)).toBe(true);
          const metricsRequests = requests.filter((url) => url.pathname === `/api/metrics/${endpoint}`);
          expect(metricsRequests.every((url) => url.searchParams.get("network") === "all" && !url.searchParams.has("tag") && !url.searchParams.has("groupBy"))).toBe(true);
        }
      });
      test(`${pageName} resets selected tags, grouping and Strict on refresh`, async ({ page }) => {
        const requests: URL[] = []; await mockNetworkViews(page, requests);
        const endpoint = pageName === "realtime" ? "realtime" : "leaderboard";
        await page.goto(`/${pageName}`);
        const all = page.getByTestId("access-toggle-all");
        await all.click();
        const toggle = page.getByRole("switch", { name: "Strict", exact: true });
        await expect(toggle).not.toBeChecked();
        await page.getByTestId("metrics-tag-filter-field").fill("isp:att");
        await page.getByTestId("metrics-tag-filter-field").press("Enter");
        await page.getByTestId("access-toggle-lastmile").click();
        await page.getByTestId("select-group-by").click();
        await page.getByRole("option", { name: "Group by link (connection)", exact: true }).click();
        await toggle.click();
        await expect.poll(() => requests.some((url) => url.pathname === `/api/metrics/${endpoint}` && url.searchParams.get("network") === "strict" && url.searchParams.getAll("tag").includes("isp:att") && url.searchParams.getAll("tag").includes("access:lastmile") && url.searchParams.get("groupBy") === "link")).toBe(true);
        await expect(page).toHaveURL(new RegExp(`/${pageName}$`));
        requests.length = 0;
        await page.reload();
        await expect(all).toHaveAttribute("data-state", "on");
        await expect(all).toHaveAttribute("aria-expanded", "false");
        await expect(page.getByTestId("network-policy")).toHaveCount(0);
        await expect.poll(() => requests.some((url) => url.pathname === `/api/metrics/${endpoint}` && url.searchParams.get("network") === "all" && !url.searchParams.has("tag") && !url.searchParams.has("groupBy"))).toBe(true);
        await all.click();
        await expect(toggle).not.toBeChecked();
        await expect(page.getByTestId("select-group-by")).toHaveText("No grouping");
        await expect(page.getByTestId("metrics-tag-filter-chip-isp")).toHaveCount(0);
        await expect(page.getByTestId("metrics-tag-filter-chip-access")).toHaveCount(0);
      });
    }
    test("Leaderboard uses the same compact filter rows and All reset", async ({ page }) => {
      const requests: URL[] = []; await mockNetworkViews(page, requests);
      await page.goto("/leaderboard");
      const all = page.getByTestId("access-toggle-all");
      const primary = page.getByTestId("leaderboard-primary-filters");
      const extended = page.getByTestId("leaderboard-network-filters");
      const toggle = page.getByRole("switch", { name: "Strict", exact: true });
      await expect(all).toHaveAttribute("data-state", "on");
      await expect(extended).toHaveCount(0);
      await expect(page.getByTestId("network-policy")).toHaveCount(0);
      await expect(page).toHaveURL(/\/leaderboard$/);
      await expect.poll(() => requests.some((url) => url.pathname === "/api/metrics/leaderboard" && url.searchParams.get("network") === "all")).toBe(true);
      await all.click();
      await expect(toggle).not.toBeChecked();
      await expect(all).toHaveAttribute("data-state", "off");
      await expect(all).toHaveAttribute("aria-expanded", "true");
      await expect(primary.getByTestId("network-policy")).toHaveText("Strict");
      expect(await toggle.evaluate((element) => element.previousElementSibling?.textContent)).toBe("Strict");
      expect(await primary.evaluate((element) => element.firstElementChild?.getAttribute("data-testid"))).toBe("network-policy");
      await expect(extended.getByTestId("access-toggle-lastmile")).toBeVisible();
      await expect(extended.getByTestId("metrics-tag-filter")).toBeVisible();
      await expect(extended.getByTestId("select-group-by")).toBeVisible();
      await expect(extended.getByTestId("network-policy")).toHaveCount(0);
      const primaryBounds = await primary.boundingBox();
      const extendedBounds = await extended.boundingBox();
      expect(extendedBounds!.y - primaryBounds!.y - primaryBounds!.height).toBeCloseTo(8, 0);
      await toggle.click();
      await expect.poll(() => requests.some((url) => url.pathname === "/api/metrics/leaderboard" && url.searchParams.get("network") === "strict")).toBe(true);
      await primary.getByRole("combobox").click();
      await page.getByRole("option", { name: "30 days", exact: true }).click();
      await page.getByTestId("access-toggle-lastmile").click();
      await page.getByTestId("select-group-by").click();
      await page.getByRole("option", { name: "Group by isp (network)", exact: true }).click();
      await expect(page.getByTestId("metrics-tag-filter-chip-access")).toHaveText("access:lastmile");
      await expect(page.getByTestId("select-group-by")).toContainText("Group by isp");
      await expect(page).toHaveURL(/\/leaderboard$/);
      await all.click();
      await expect(all).toHaveAttribute("data-state", "on");
      await expect(all).toHaveAttribute("aria-expanded", "false");
      await expect(extended).toHaveCount(0);
      await expect(page.getByTestId("network-policy")).toHaveCount(0);
      await expect(page).toHaveURL(/\/leaderboard$/);
      await expect(primary.getByRole("combobox")).toContainText("30 days");
      await expect.poll(() => requests.some((url) => url.pathname === "/api/metrics/leaderboard" && url.searchParams.get("network") === "all" && url.searchParams.get("hours") === "720" && !url.searchParams.has("tag") && !url.searchParams.has("groupBy"))).toBe(true);
      await all.click();
      await expect(toggle).not.toBeChecked();
      await expect(page.getByTestId("select-group-by")).toHaveText("No grouping");
      await expect(page.getByTestId("metrics-tag-filter-chip-access")).toHaveCount(0);
      await page.getByRole("button", { name: "About strict mode" }).click();
      await expect(page.getByTestId("strict-network-info")).toContainText("Only fully monitored runs");
      await page.keyboard.press("Escape");
      expect(requests.some((url) => url.pathname === "/api/metrics/network-coverage")).toBe(false);
      expect(await page.locator("body").evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true);
    });
    test("shared filter bar supports custom grouping and keyboard reset on both pages", async ({ page }) => {
      const requests: URL[] = []; await mockNetworkViews(page, requests);
      for (const pageName of ["realtime", "leaderboard"]) {
        await page.goto(`/${pageName}`);
        const all = page.getByRole("button", { name: "All networks", exact: true });
        const extended = page.getByTestId(`${pageName}-network-filters`);
        await all.click();
        await extended.getByTestId("metrics-tag-filter-field").fill("run:reuse");
        await extended.getByTestId("metrics-tag-filter-field").press("Enter");
        await extended.getByTestId("select-group-by").click();
        await page.getByRole("option", { name: "Group by run", exact: true }).click();
        await page.getByRole("switch", { name: "Strict", exact: true }).click();
        await expect(all).toHaveAttribute("aria-controls", `${pageName}-network-filters`);
        await expect(extended).toHaveAttribute("id", `${pageName}-network-filters`);
        await expect(extended.getByTestId("metrics-tag-filter-chip-run")).toHaveText("run:reuse");
        await expect(extended.getByTestId("select-group-by")).toContainText("Group by run");
        await expect(page.getByRole("switch", { name: "Strict", exact: true })).toBeChecked();
        await all.focus();
        await page.keyboard.press("Space");
        await expect(all).toHaveAttribute("data-state", "on");
        await expect(all).toBeFocused();
        await expect(extended).toHaveCount(0);
        await expect(page).toHaveURL(new RegExp(`/${pageName}$`));
        await page.keyboard.press("Space");
        await expect(all).toHaveAttribute("aria-expanded", "true");
        await expect(page.getByRole("switch", { name: "Strict", exact: true })).not.toBeChecked();
        await expect(extended.getByTestId("select-group-by")).toHaveText("No grouping");
        await expect(extended.getByTestId("metrics-tag-filter-chip-run")).toHaveCount(0);
      }
    });
    test("job timeline shows frozen baseline, unknown historical ISP and paginated details", async ({ page }) => {
      const requests: URL[] = []; await mockNetworkViews(page, requests);
      await page.goto("/console/eval-jobs/42");
      const timeline = page.getByTestId("job-network-timeline");
      await expect(timeline).toContainText("Initial network");
      await expect(timeline).toContainText("Network changed");
      await expect(timeline).toContainText("isp:unknown");
      await expect(timeline).toContainText("some event details are missing");
      await expect(page.getByTestId("job-tags")).toContainText("isp:att");
      await timeline.getByRole("button", { name: "Load more events" }).click();
      await expect(timeline).toContainText("Monitoring ended");
      await expect(timeline.getByRole("button", { name: "Load more events" })).toHaveCount(0);
      expect(await timeline.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    });
  });
}
