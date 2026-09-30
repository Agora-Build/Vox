import type { VoxPlugin } from "@vox/plugin-sdk";
import { createMarketplaceService, type CreditsPort } from "./service";

export const LEAK_REAPER_INTERVAL_MS = 5 * 60 * 1000;
// A dispatch hold older than this is a leak and gets refunded. It must exceed
// the longest legitimate hold — Core's 24h pending backstop + 90m run cap =
// 25.5h — and stay below credits' stale-hold alarm (STALE_HOLD_MS, 32h), so the
// reaper refunds a leak before credits calls it an invariant violation (#91).
// Pinned by tests/shared-agents-timing.test.ts.
export const LEAK_TTL_MS = 30 * 60 * 60 * 1000;
const LEAK_REAP_LIMIT = 200;

const sharedAgentsPlugin: VoxPlugin = {
  async activate(ctx) {
    const credits = ctx.services.require<CreditsPort>("vox.credits", "^1.0.0");
    const service = createMarketplaceService(ctx.db, credits, ctx.logger);

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
