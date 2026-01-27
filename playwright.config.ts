import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E Test Configuration for Vox
 *
 * Runs against a local development server on port 5000.
 * Start the server with `npm run dev` before running tests.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:5000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // Don't start the server automatically - tests expect it to be running
  webServer: undefined,
});
