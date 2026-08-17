import type { VoxPlugin } from "@vox/plugin-sdk";
import { createMarketplaceService, type CreditsPort } from "./service";

const LEAK_REAPER_INTERVAL_MS = 5 * 60 * 1000;
const LEAK_TTL_MS = 26 * 60 * 60 * 1000; // > max legitimate job lifetime (24h pending + 90m run)
const LEAK_REAP_LIMIT = 200;

const sharedAgentsPlugin: VoxPlugin = {
  async activate(ctx) {
    const credits = ctx.services.require<CreditsPort>("vox.credits", "^1.0.0");
    const service = createMarketplaceService(ctx.db, credits);

    ctx.worker({
      id: "leak-reaper",
      intervalMs: LEAK_REAPER_INTERVAL_MS,
      singleton: true,
      run: async () => {
        const n = await service.reapLeaks(LEAK_TTL_MS, LEAK_REAP_LIMIT);
        if (n > 0) ctx.logger.warn("released leaked shared-agent dispatch holds", { count: n });
      },
    });

    ctx.health(async () => {
      try {
        await ctx.db.query("SELECT 1");
      } catch (err) {
        return { status: "down", detail: String(err) };
      }
      const stuck = await service.countStuckPending(LEAK_TTL_MS);
      if (stuck > 0) return { status: "degraded", detail: `${stuck} settlement(s) stuck pending past TTL` };
      return { status: "ok" };
    });

    ctx.provideService("vox.eval-marketplace", "1.0.0", service);
  },
};

export default sharedAgentsPlugin;
