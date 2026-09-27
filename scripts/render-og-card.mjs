// Renders scripts/og-card.html to client/public/opengraph.jpg (1200x630).
// Usage: node scripts/render-og-card.mjs
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(`file://${root}/scripts/og-card.html`, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: `${root}/client/public/opengraph.jpg`, type: "jpeg", quality: 90 });
await browser.close();
console.log("wrote client/public/opengraph.jpg");
