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
    test("strict is default; include-all persists in requests and the URL", async ({ page }) => {
      const requests: URL[] = []; await mockNetworkViews(page, requests);
      await page.goto("/realtime");
      const toggle = page.getByTestId("include-unstable-networks");
      await expect(toggle).toHaveAttribute("data-state", "unchecked");
      await expect(page.getByTestId("network-policy")).toContainText("12 verified stable");
      await toggle.click();
      await expect(page).toHaveURL(/network=all/);
      await expect.poll(() => requests.some((url) => url.pathname === "/api/metrics/realtime" && url.searchParams.get("network") === "all")).toBe(true);
      await expect.poll(() => requests.some((url) => url.pathname === "/api/metrics/available-regions" && url.searchParams.get("network") === "all")).toBe(true);
      await page.reload(); await expect(toggle).toHaveAttribute("data-state", "checked");
      await page.goto("/leaderboard?network=all");
      await expect(toggle).toHaveAttribute("data-state", "checked");
      await toggle.click();
      await expect.poll(() => requests.some((url) => url.pathname === "/api/metrics/leaderboard" && url.searchParams.get("network") === "strict")).toBe(true);
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
