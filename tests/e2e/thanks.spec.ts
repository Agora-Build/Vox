import { test, expect } from "@playwright/test";
import { acknowledgmentGroups } from "../../client/src/lib/acknowledgments";
import { GEOIP_ATTRIBUTIONS } from "../../shared/geoip-attribution";

test.describe("Thanks page", () => {
  test("is public and has page-specific search metadata", async ({ page }) => {
    await page.goto("/thanks");
    await expect(page.getByRole("heading", { level: 1, name: "Thanks." })).toBeVisible();
    await expect(page).toHaveTitle("Thanks | Vox");
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /open-source projects/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /index, follow/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://vox.agora.build/thanks");
    for (const title of ["Evaluation & audio", "Data attribution"]) {
      await expect(page.getByRole("heading", { level: 2, name: title, exact: true })).toBeVisible();
    }
  });

  test("omits the interface, platform, and building/shipping sections and category links", async ({ page }) => {
    await page.goto("/thanks");
    await expect(page.getByRole("heading", { level: 1, name: "Thanks." })).toBeVisible();
    const categories = page.getByRole("navigation", { name: "Acknowledgment categories" });
    for (const name of ["The interface", "The platform", "Building & shipping"]) {
      await expect(page.getByRole("heading", { level: 2, name, exact: true })).toHaveCount(0);
      await expect(categories.getByRole("link", { name, exact: true })).toHaveCount(0);
    }
    await expect(page.locator("main #interface, main #platform, main #tooling")).toHaveCount(0);
    await expect(page.locator("main h2")).toHaveCount(2);
  });

  test("does not show the removed commercial-company credits", async ({ page }) => {
    await page.goto("/thanks");
    await expect(page.getByRole("heading", { level: 1, name: "Thanks." })).toBeVisible();
    for (const name of ["Stripe", "Google", "Discord", "Anthropic", "MaxMind"]) {
      await expect(page.locator("main").getByRole("link", { name: new RegExp(`^${name}\\b`) })).toHaveCount(0);
    }
  });

  test("is reachable through the public footer", async ({ page }) => {
    await page.goto("/privacy");
    const link = page.getByTestId("link-footer-thanks");
    await expect(link).toHaveCount(1);
    await expect(page.getByTestId("footer-community-credit").getByTestId("link-footer-thanks")).toHaveCount(1);
    await expect(link).toHaveAttribute("href", "/thanks");
    await link.click();
    await expect(page).toHaveURL(/\/thanks$/);
    await expect(page.getByRole("heading", { level: 1, name: "Thanks." })).toBeVisible();
  });

  test("places the Thanks link in the footer's left-side community credit", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/thanks");
    const credit = page.getByTestId("footer-community-credit");
    await expect(credit).toContainText("Built with");
    const thanks = credit.getByTestId("link-footer-thanks");
    await thanks.scrollIntoViewIfNeeded();
    await expect(thanks).toBeVisible();
    const thanksBox = (await thanks.boundingBox())!;
    const privacyBox = (await page.getByTestId("link-footer-privacy").boundingBox())!;
    expect(thanksBox.x).toBeLessThan(privacyBox.x);
  });

  test("links to real projects and their license notices safely", async ({ page, request }) => {
    await page.goto("/thanks");
    const projects = page.locator('main section li > a:first-child');
    await expect(projects).toHaveCount(acknowledgmentGroups.reduce((count, group) => count + group.projects.length, 0));
    for (const link of await projects.all()) {
      await expect(link).toHaveAttribute("href", /^https:\/\//);
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    await expect(page.locator('#evaluation a[href="https://github.com/Agora-Build/aeval"]')).toBeVisible();
    await expect(page.getByRole("link", { name: "MPL-2.0 license & source" })).toHaveAttribute("href", "/licenses/mediabunny.txt");
    await expect(page.getByRole("link", { name: "CC BY 4.0" })).toHaveAttribute("href", "https://creativecommons.org/licenses/by/4.0/");
    const license = await request.get("/licenses/mediabunny.txt");
    expect(license.ok()).toBeTruthy();
    expect(await license.text()).toContain("Mozilla Public License");
  });

  test("supports category navigation", async ({ page }) => {
    await page.goto("/thanks");
    await page.getByRole("navigation", { name: "Acknowledgment categories" }).getByRole("link", { name: "Data attribution" }).click();
    await expect(page).toHaveURL(/\/thanks#integrations$/);
    await expect(page.locator("#integrations")).toBeInViewport();
    await expect(page.locator("#integrations")).toContainText("active source depends on the deployment's configuration");
  });

  for (const source of ["dbip", "geolite2"] as const) {
    test(`preserves the ${source} license notice in the footer, not the Thanks credits`, async ({ page }) => {
      const credit = GEOIP_ATTRIBUTIONS[source];
      await page.setViewportSize({ width: 375, height: 812 });
      await page.route("**/api/geoip/attribution", (route) => route.fulfill({
        json: { system_initialized: "true", geoipAttribution: credit.attribution },
      }));
      await page.goto("/thanks");
      const notice = page.getByTestId("text-geoip-attribution");
      await notice.scrollIntoViewIfNeeded();
      await expect(notice).toContainText(`This product includes ${credit.dataName} data created by ${credit.provider}`);
      const provider = notice.getByRole("link", { name: credit.provider, exact: true });
      await expect(provider).toHaveAttribute("href", credit.url);
      await expect(provider).toHaveAttribute("rel", "noopener noreferrer");
      await expect(page.locator("main").getByRole("link", { name: /^MaxMind\b/ })).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }

  test("does not show a data-provider notice without an active source", async ({ page }) => {
    await page.route("**/api/config", (route) => route.fulfill({ json: { system_initialized: "true" } }));
    await page.route("**/api/geoip/attribution", (route) => route.fulfill({ json: { geoipAttribution: null } }));
    await page.goto("/thanks");
    await expect(page.getByTestId("link-footer-thanks")).toBeVisible();
    await expect(page.getByTestId("text-geoip-attribution")).toHaveCount(0);
  });

  test("retains a server license notice that differs from the client bundle", async ({ page }) => {
    const attribution = "GeoLite2 data created by MaxMind, https://www.maxmind.com (updated wording).";
    await page.route("**/api/geoip/attribution", (route) => route.fulfill({ json: { geoipAttribution: attribution } }));
    await page.goto("/thanks");
    await expect(page.getByTestId("text-geoip-attribution")).toHaveText(attribution);
  });

  test("refreshes the notice after the active source changes while the page stays open", async ({ page }) => {
    let source: "dbip" | "geolite2" | null = "dbip";
    let configRequests = 0;
    await page.clock.install();
    await page.route("**/api/config", (route) => {
      configRequests += 1;
      return route.fulfill({ json: { geoipAttribution: "Cached config notice" } });
    });
    await page.route("**/api/geoip/attribution", (route) => route.fulfill({
      json: { geoipAttribution: source ? GEOIP_ATTRIBUTIONS[source].attribution : null },
    }));
    await page.goto("/thanks");
    const notice = page.getByTestId("text-geoip-attribution");
    await expect(notice).toContainText("DB-IP");
    source = "geolite2";
    await page.clock.fastForward(61_000);
    await expect(notice).toContainText("MaxMind");
    await expect(notice).not.toContainText("DB-IP");
    source = null;
    await page.clock.fastForward(61_000);
    await expect(notice).toHaveCount(0);
    expect(configRequests).toBe(1);
  });

  for (const theme of ["dark", "light"]) {
    test(`fits a phone viewport in the ${theme} theme`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.addInitScript((value) => window.localStorage.setItem("vox-theme", value), theme);
      await page.goto("/thanks");
      await expect(page.getByRole("heading", { level: 1, name: "Thanks." })).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.getByTestId("link-footer-thanks").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("link-footer-thanks")).toBeVisible();
      await expect(page.locator("html")).toHaveClass(new RegExp(theme));
    });
  }
});
