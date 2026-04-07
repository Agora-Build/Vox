// broadcaster.ts — 3rd headless Chromium browser that captures the Mixed_Sink
// monitor stream and publishes it to an Agora RTC channel for spectators.

import { chromium, type Browser, type Page } from "playwright-core";
import * as path from "path";
import * as fs from "fs";

export interface BroadcastConfig {
  appId: string;
  token: string;
  channelName: string;
  uid: number;
}

export interface BroadcastHandle {
  stop: () => Promise<void>;
}

/**
 * Launch a headless Chromium browser that loads broadcast.html,
 * captures audio from PipeWire's Mixed_Sink, and publishes
 * to the Agora RTC spectator channel.
 */
export async function startBroadcast(config: BroadcastConfig): Promise<BroadcastHandle> {
  const htmlPath = path.join(__dirname, "broadcast.html");
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`broadcast.html not found at ${htmlPath}`);
  }

  const browser: Browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      // Route this browser's mic capture to Mixed_Sink
      "--alsa-output-device=Mixed_Sink",
    ],
  });

  const context = await browser.newContext({
    permissions: ["microphone"],
  });

  const page: Page = await context.newPage();
  await page.goto(`file://${htmlPath}`);

  // Call the broadcast start function exposed in the HTML page
  const result = await page.evaluate(async (cfg) => {
    // @ts-ignore — function is defined in broadcast.html
    return await window.startBroadcast(cfg);
  }, config);

  if (!result?.success) {
    await browser.close();
    throw new Error(`Broadcast failed to start: ${result?.error || "unknown error"}`);
  }

  console.log(`[Broadcaster] Publishing to channel ${config.channelName} as uid ${config.uid}`);

  return {
    stop: async () => {
      try {
        await page.evaluate(async () => {
          // @ts-ignore
          await window.stopBroadcast();
        });
      } catch {
        // Page may already be closed
      }
      await browser.close().catch(() => {});
      console.log("[Broadcaster] Stopped");
    },
  };
}
