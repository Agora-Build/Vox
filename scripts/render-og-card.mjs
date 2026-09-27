// Renders scripts/og-card.html to the two link-preview images:
//   client/public/opengraph.jpg    1200x630  the website's og:image
//   .github/social-preview.png     1280x640  the GitHub repo's social preview
//                                            (upload by hand: Settings → General
//                                            → Social preview; GitHub has no API)
// Usage: node scripts/render-og-card.mjs
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputs = [
  { file: "client/public/opengraph.jpg", width: 1200, height: 630, type: "jpeg" },
  { file: ".github/social-preview.png", width: 1280, height: 640, type: "png" },
];

const browser = await chromium.launch();
for (const { file, width, height, type } of outputs) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(`file://${root}/scripts/og-card.html`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(path.dirname(`${root}/${file}`), { recursive: true });
  await page.screenshot({ path: `${root}/${file}`, type, ...(type === "jpeg" ? { quality: 90 } : {}) });
  await page.close();
  console.log(`wrote ${file} (${width}x${height})`);
}
await browser.close();
