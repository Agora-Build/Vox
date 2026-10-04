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
  // Everything under test is ONE single-process Vite dev server, so workers
  // past a handful do not buy parallelism — they queue on the same event loop
  // and push login round trips and first-hit module transforms past the
  // assertion budgets. Playwright's default is half the cores (8 here), which
  // is tuned for independent workers and wrong for a shared backend: it made
  // the auth specs fail intermittently on load alone. CI already runs 1.
  // One dev server (a single Node process serving the API and every Vite
  // module) can't serve 4 browsers at once: page loads timed out mid-run
  // (#201). 2 measured clean of those; CI runs 1.
  workers: process.env.CI ? 1 : 2,
  reporter: "html",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5000",
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
