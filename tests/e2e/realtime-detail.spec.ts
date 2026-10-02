import { test, expect, type Page } from "@playwright/test";

const DAY = 86400000;
const HOUR = 3600000;
const START = Date.UTC(2026, 0, 1);
const END = START + 180 * DAY;

function metric(timestamp: number, index: number) {
  return {
    id: index, providerId: "alpha", provider: "Alpha", siteId: "test-01",
    responseLatency: 500 + (index % 8) * 20, interruptLatency: 200,
    turnSuccessRate: 0.95, timestamp: new Date(timestamp).toISOString(),
  };
}

async function mockDashboard(page: Page, requests: URL[], truncated = false) {
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    let data: unknown = [];
    if (url.pathname === "/api/auth/status") data = { initialized: true, user: null };
    else if (url.pathname === "/api/config") data = {};
    else if (url.pathname === "/api/health") data = { status: "operational", agents: { total: 1, online: 1, offline: 0 } };
    else if (url.pathname === "/api/providers") data = [{ id: "alpha", name: "Alpha", brandColor: "#f97316" }];
    else if (url.pathname === "/api/metrics/available-regions") data = { availableRegions: [], hasUnverified: false };
    else if (url.pathname.endsWith("/detail")) {
      requests.push(url);
      const from = Number(url.searchParams.get("from"));
      const to = Number(url.searchParams.get("to"));
      const raw = to - from <= 7 * DAY;
      const step = raw ? 15 * 60000 : HOUR;
      const metrics = [];
      for (let time = Math.max(from, START), i = 0; time < Math.min(to, END); time += step, i++) metrics.push(metric(time, i));
      // Allow assertions while the chart still displays the coarse data.
      await new Promise(resolve => setTimeout(resolve, 350));
      data = { from, to, resolution: raw ? "raw" : "hour", truncated, metrics };
    } else if (url.pathname.startsWith("/api/metrics/")) {
      data = Array.from({ length: 180 }, (_, i) => metric(END - (i + 1) * DAY, i));
    }
    await route.fulfill({ json: data });
  });
}

async function pinch(chart: ReturnType<Page["locator"]>, deltaY: number, count: number) {
  await chart.scrollIntoViewIfNeeded();
  // Frame-paced events avoid automation round trips being mistaken for gesture ends.
  const result = await chart.evaluate(async (element, { deltaY, count }) => {
    const box = element.getBoundingClientRect();
    const readTicks = () => Array.from(element.querySelectorAll(".recharts-xAxis .recharts-cartesian-axis-tick-value"), tick => tick.textContent).join("|");
    const before = readTicks();
    let during = before;
    for (let i = 0; i < count; i++) {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY, ctrlKey: true, bubbles: true, cancelable: true, clientX: box.x + box.width * 0.5, clientY: box.y + box.height * 0.5 }));
      await new Promise(requestAnimationFrame);
      if (i === 2) during = readTicks();
    }
    return { before, during };
  }, { deltaY, count });
  if (deltaY < 0 && count > 3) expect(result.during).not.toEqual(result.before);
}

test("All time loads hourly and individual detail without moving the viewed dates", async ({ page }) => {
  const requests: URL[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await mockDashboard(page, requests);
  await page.goto("/realtime");
  await page.getByRole("combobox").filter({ hasText: "7 days" }).click();
  await page.getByRole("option", { name: "All time" }).click();
  const chart = page.locator(".recharts-wrapper").first();
  const ticks = chart.locator(".recharts-xAxis .recharts-cartesian-axis-tick-value");
  const path = chart.locator(".recharts-line-curve").first();
  const status = page.getByTestId("chart-detail-status");
  await expect(status).toHaveText("Daily averages");
  await expect(path).toHaveAttribute("d", /[LC]/);
  expect(requests).toHaveLength(0);

  await pinch(chart, -60, 8);
  await expect(status).toHaveText("Loading detail...");
  const hourlyDates = await ticks.allTextContents();
  const coarsePath = await path.getAttribute("d");
  await expect(status).toHaveText("Hourly averages");
  expect(await ticks.allTextContents()).toEqual(hourlyDates);
  expect((await path.getAttribute("d"))!.length).toBeGreaterThan(coarsePath!.length);
  expect(requests).toHaveLength(1);
  expect(Number(requests[0].searchParams.get("to")) - Number(requests[0].searchParams.get("from"))).toBeLessThan(90 * DAY);

  await pinch(chart, -60, 12);
  await expect(status).toHaveText("Loading detail...");
  const rawDates = await ticks.allTextContents();
  await expect(status).toHaveText("Individual tests");
  expect(await ticks.allTextContents()).toEqual(rawDates);
  expect(requests).toHaveLength(2);
  expect(Number(requests[1].searchParams.get("to")) - Number(requests[1].searchParams.get("from"))).toBeLessThan(7 * DAY);

  // Panning loads a historical absolute window instead of "the last N hours".
  const box = (await chart.boundingBox())!;
  const previousFrom = Number(requests[1].searchParams.get("from"));
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => requests.length).toBe(3);
  await expect(status).toHaveText("Individual tests");
  expect(Number(requests[2].searchParams.get("from"))).toBeLessThan(previousFrom);
  expect(requests[2].searchParams.get("transport")).toBe("web");

  await pinch(chart, 100, 20);
  await expect(status).toHaveText("Daily averages");
  await expect(path).toHaveAttribute("d", /[LC]/);
  expect(errors).toEqual([]);
});

test("an in-flight detail response cannot bleed across transport filters", async ({ page }) => {
  const requests: URL[] = [];
  await mockDashboard(page, requests);
  await page.goto("/realtime");
  await page.getByRole("combobox").filter({ hasText: "7 days" }).click();
  await page.getByRole("option", { name: "All time" }).click();
  const chart = page.locator(".recharts-wrapper").first();
  const status = page.getByTestId("chart-detail-status");
  await expect(status).toHaveText("Daily averages");
  await pinch(chart, -60, 8);
  await expect(status).toHaveText("Loading detail...");
  await page.getByTestId("tab-mode-phone").click();
  await expect(status).toHaveText("Daily averages");
  await page.waitForTimeout(450);
  await expect(status).toHaveText("Daily averages");
  await pinch(chart, -60, 8);
  await expect(status).toHaveText("Hourly averages");
  expect(requests.at(-1)?.searchParams.get("transport")).toBe("phone");
});

test("an incomplete detail response keeps the complete cached overview", async ({ page }) => {
  const requests: URL[] = [];
  await mockDashboard(page, requests, true);
  await page.goto("/realtime");
  await page.getByRole("combobox").filter({ hasText: "7 days" }).click();
  await page.getByRole("option", { name: "All time" }).click();
  const chart = page.locator(".recharts-wrapper").first();
  const status = page.getByTestId("chart-detail-status");
  await expect(status).toHaveText("Daily averages");
  await pinch(chart, -60, 8);
  await expect(status).toHaveText("Loading detail...");
  const ticks = await chart.locator(".recharts-xAxis .recharts-cartesian-axis-tick-value").allTextContents();
  const path = await chart.locator(".recharts-line-curve").first().getAttribute("d");
  await expect(status).toHaveText("Detail limit reached - showing cached data");
  expect(await chart.locator(".recharts-xAxis .recharts-cartesian-axis-tick-value").allTextContents()).toEqual(ticks);
  expect(await chart.locator(".recharts-line-curve").first().getAttribute("d")).toEqual(path);
});
