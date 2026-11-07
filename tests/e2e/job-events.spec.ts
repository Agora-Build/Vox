import { expect, test, type Page } from "@playwright/test";

async function mockJob(page: Page, { unavailable = false, onEventsRequest = () => {}, withArtifacts = false }: {
  unavailable?: boolean; onEventsRequest?: () => void; withArtifacts?: boolean;
} = {}) {
  const startedAt = "2026-11-07T00:00:00.000Z", timestamp = Date.parse(startedAt);
  const snapshot = { ruleVersion: 1, cpuPercent: 42, memoryPercent: 54 };
  const event = (id: number, name: string, offsetMs: number, data?: object) => ({ id, event: name, source: id === 1 ? "core" : "agent", seq: id,
    offsetMs, timestamp: timestamp + offsetMs, tags: name === "initial" ? { isp: "att", link: "ethernet", access: "unknown" }
      : name === "monitoring_start" ? { link: "ethernet" } : {}, changed: [], ...(data ? { data } : {}) });
  const events = unavailable ? [event(1, "initial", 0), { ...event(2, "monitoring_start", 0), tags: { link: null } },
    event(3, "monitoring_gap", 0), event(4, "monitoring_end", 1588200)] : [
    event(1, "initial", 0), event(2, "monitoring_start", 0), event(3, "host_start", 0, snapshot),
    event(4, "host_high", 31000, { ruleVersion: 1, metric: "cpu", valuePercent: 87, thresholdPercent: 80, durationMs: 30000, peakPercent: 91 }),
    event(5, "host_rise", 300000, { ruleVersion: 1, metric: "memory", previousPercent: 54, valuePercent: 77, windowMs: 300000, risePoints: 20 }),
    event(6, "host_recovered", 330000, { ruleVersion: 1, metric: "cpu", valuePercent: 68, thresholdPercent: 75, durationMs: 330000, peakPercent: 91 }),
    event(7, "host_end", 1588200, snapshot), event(8, "monitoring_end", 1588200),
  ];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let data: unknown = [];
    if (url.pathname === "/api/auth/status") data = { initialized: true, user: { id: 1, username: "Scout", isAdmin: false, plan: "principal" } };
    else if (url.pathname === "/api/config") data = {};
    else if (url.pathname === "/api/health") data = { status: "operational", agents: { total: 1, online: 1, offline: 0 } };
    else if (url.pathname === "/api/eval-jobs/42/detail") data = { job: { id: 42, kind: "eval", status: "completed", startedAt, completedAt: new Date(timestamp + 1588200).toISOString(), createdAt: startedAt,
      config: {}, snapshot: null, siteId: null, tags: [{ key: "isp", value: "att", source: "detected" }] }, result: withArtifacts ? {
        id: 42, evalJobId: 42, artifactStatus: "uploaded", rawData: {}, artifactFiles: [
          { name: "snapshot.png", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jmhkAAAAASUVORK5CYII=", size: 68, contentType: "image/png" },
          { name: "eval.log", url: "/events-fixture/eval.log", size: 2048, contentType: "text/plain" },
        ],
      } : null, evalFlowName: "Host resource evaluation", creatorName: "Scout" };
    else if (url.pathname === "/api/eval-jobs/42/events") {
      onEventsRequest();
      data = { events, nextCursor: null, networkChanged: false, changeCount: 0,
        monitoring: unavailable ? "incomplete" : "complete", resources: unavailable ? null : { ruleVersion: 1, monitoring: "complete", highUsage: true, rapidRise: true } };
    }
    await route.fulfill({ json: data });
  });
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test.describe(`evaluation Events ${viewport.width}px`, () => {
    test.use({ viewport });
    test("starts folded, loads on expansion, supports keyboard toggling and resets on reload", async ({ page }, testInfo) => {
      let requests = 0;
      await mockJob(page, { onEventsRequest: () => { requests++; } });
      await page.goto("/console/eval-jobs/42");
      const panel = page.getByTestId("job-network-timeline"), toggle = panel.getByRole("button", { name: "Events", exact: true });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(panel.getByRole("group", { name: "Event category" })).not.toBeVisible();
      await expect(panel.getByTestId("network-event-summary")).not.toBeVisible();
      expect(requests).toBe(0);
      await page.screenshot({ path: testInfo.outputPath("events-folded.png") });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(panel.getByTestId("job-event-4")).toContainText("Host CPU high");
      expect(requests).toBeGreaterThan(0);
      await toggle.focus();
      await toggle.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(panel.getByTestId("host-event-summary")).not.toBeVisible();
      await expect(panel.getByTestId("job-event-4")).not.toBeVisible();
      await toggle.press("Space");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(panel.getByTestId("job-event-4")).toBeVisible();
      const beforeReload = requests;
      await page.reload();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(panel.getByTestId("job-event-4")).not.toBeVisible();
      expect(requests).toBe(beforeReload);
    });
    test("places folded Events directly above Screenshots and folds Artifact Files by default", async ({ page }, testInfo) => {
      await mockJob(page, { withArtifacts: true });
      await page.goto("/console/eval-jobs/42");
      const events = page.getByTestId("job-network-timeline"), screenshots = page.getByTestId("result-screenshots");
      const files = page.getByTestId("result-artifact-files"), toggle = files.getByRole("button", { name: "Artifact Files", exact: true });
      await expect(events).toHaveCount(1);
      await expect(screenshots).toBeVisible();
      expect(await events.evaluate((element) => element.nextElementSibling?.getAttribute("data-testid"))).toBe("result-screenshots");
      await expect(events.getByRole("button", { name: "Events", exact: true })).toHaveAttribute("aria-expanded", "false");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(files).toContainText("2 files uploaded");
      await expect(files.getByRole("table")).not.toBeVisible();
      await events.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("events-above-screenshots.png") });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(files.getByRole("table")).toBeVisible();
      await expect(files.getByRole("row").filter({ hasText: "eval.log" }).getByRole("link")).toHaveAttribute("href", "/events-fixture/eval.log");
      await toggle.focus();
      await toggle.press("Space");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(files.getByRole("table")).not.toBeVisible();
      await toggle.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await page.reload();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(files.getByRole("table")).not.toBeVisible();
    });
    test("shows resource conditions, independent summaries, category filters and technical details", async ({ page }, testInfo) => {
      await mockJob(page); await page.goto("/console/eval-jobs/42");
      const panel = page.getByTestId("job-network-timeline");
      await expect(panel.getByRole("heading", { name: "Events", exact: true })).toBeVisible();
      await panel.getByRole("button", { name: "Events", exact: true }).click();
      await expect(panel.getByTestId("network-event-summary")).toContainText("Eligible for Strict");
      await expect(panel.getByTestId("host-event-summary")).toContainText("High host usage recorded");
      await expect(panel.getByTestId("job-event-4")).toContainText("Host CPU high");
      await expect(panel.getByTestId("job-event-5")).toContainText("54% to 77% in 5 minutes (+23 percentage points)");
      await expect(panel.getByTestId("job-event-6")).toContainText("Host CPU recovered");
      await expect(panel.getByTestId("job-event-8")).toContainText("+26m 28s");
      await expect(panel.getByTestId("job-event-4").getByText("thresholdPercent", { exact: true })).not.toBeVisible();
      await panel.getByTestId("job-event-4").locator("summary").click();
      await expect(panel.getByTestId("job-event-4").getByText("thresholdPercent", { exact: true })).toBeVisible();
      await panel.getByTestId("job-event-4").locator("summary").click();
      await panel.getByRole("heading", { name: "Events", exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("events.png") });
      await panel.getByTestId("job-event-4").scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("events-conditions.png") });
      await panel.getByRole("button", { name: "CPU", exact: true }).click();
      await expect(panel.getByTestId("job-event-4")).toBeVisible();
      await expect(panel.getByTestId("job-event-5")).toHaveCount(0);
      await panel.getByRole("button", { name: "Memory", exact: true }).click();
      await expect(panel.getByTestId("job-event-5")).toBeVisible();
      await expect(panel.getByTestId("job-event-4")).toHaveCount(0);
      await panel.getByRole("button", { name: "Network", exact: true }).click();
      await expect(panel.getByTestId("job-event-1")).toBeVisible();
      await expect(panel.getByTestId("job-event-5")).toHaveCount(0);
      expect(await page.locator("body").evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true);
    });
    test("explains unavailable initial tracking without implying a network outage or healthy host", async ({ page }, testInfo) => {
      await mockJob(page, { unavailable: true }); await page.goto("/console/eval-jobs/42");
      const panel = page.getByTestId("job-network-timeline");
      await panel.getByRole("button", { name: "Events", exact: true }).click();
      await expect(panel.getByTestId("job-event-3")).toContainText("Network tracking unavailable");
      await expect(panel.getByTestId("job-event-3")).toContainText("does not mean the Internet was disconnected");
      await expect(panel.getByTestId("network-event-summary")).toContainText("Excluded from Strict");
      await expect(panel.getByTestId("host-event-summary")).toContainText("Host resources not monitored");
      await expect(panel).not.toContainText("isp:unknown");
      await expect(panel).not.toContainText("until complete monitoring");
      await expect(panel.getByText("End", { exact: true })).toBeVisible();
      await panel.getByRole("heading", { name: "Events", exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("events-unavailable.png") });
      expect(await page.locator("body").evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true);
    });
  });
}
