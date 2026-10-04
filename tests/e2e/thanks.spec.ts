import { test, expect } from "@playwright/test";

test.describe("Thanks page", () => {
  test("is public and has page-specific search metadata", async ({ page }) => {
    await page.goto("/thanks");
    await expect(page.getByRole("heading", { level: 1, name: "Thanks." })).toBeVisible();
    await expect(page).toHaveTitle("Thanks | Vox");
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /open-source projects/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /index, follow/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://vox.agora.build/thanks");
    for (const title of ["Evaluation & audio", "The interface", "The platform", "Building & shipping", "Data & optional services"]) {
      await expect(page.getByRole("heading", { level: 2, name: title, exact: true })).toBeVisible();
    }
  });

  test("is reachable through the public footer", async ({ page }) => {
    await page.goto("/privacy");
    const link = page.getByTestId("link-footer-thanks");
    await expect(link).toHaveAttribute("href", "/thanks");
    await link.click();
    await expect(page).toHaveURL(/\/thanks$/);
    await expect(page.getByRole("heading", { level: 1, name: "Thanks." })).toBeVisible();
  });

  test("links to real projects and their license notices safely", async ({ page, request }) => {
    await page.goto("/thanks");
    const projects = page.locator('main section li > a:first-child');
    expect(await projects.count()).toBeGreaterThan(25);
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
    await page.getByRole("navigation", { name: "Acknowledgment categories" }).getByRole("link", { name: "Data & optional services" }).click();
    await expect(page).toHaveURL(/\/thanks#integrations$/);
    await expect(page.locator("#integrations")).toBeInViewport();
    await expect(page.locator("#integrations")).toContainText("not a list of services enabled on every deployment");
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
