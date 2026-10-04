import type { VoxPlugin, UserDirectoryService, VerificationService } from "@vox/plugin-sdk";
import { checkInvariants } from "./reconcile";
import { createCreditsService } from "./service";
import { registerCreditsRoutes } from "./routes";
import { createPersonalCredits } from "./personal";

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

const creditsPlugin: VoxPlugin = {
  async activate(ctx) {
    const personal = createPersonalCredits(ctx.db, createCreditsService(ctx.db),
      ctx.services.require<UserDirectoryService>("vox.users", "^1.0.0"),
      ctx.services.require<VerificationService>("vox.verification", "^1.0.0"));
    const service = personal.service;
    let lastIntegrity: { ok: boolean; violation: string | null } = { ok: true, violation: null };

    ctx.http((r) => registerCreditsRoutes(r, service, personal));
    ctx.worker({ id: "welcome", intervalMs: 10_000, singleton: true, run: personal.backfill });
    ctx.worker({ id: "grants", intervalMs: 5000, singleton: true, run: () => personal.runBatch() });

    ctx.worker({
      id: "reconcile",
      intervalMs: RECONCILE_INTERVAL_MS,
      singleton: true,
      run: async () => {
        lastIntegrity = await checkInvariants(ctx.db);
        if (!lastIntegrity.ok) {
          ctx.logger.error("credits ledger invariant violation", { violation: lastIntegrity.violation });
        }
      },
    });

    ctx.health(async () => {
      try {
        await ctx.db.query("SELECT 1");
      } catch (err) {
        return { status: "down", detail: String(err) };
      }
      if (!lastIntegrity.ok) {
        return { status: "degraded", detail: lastIntegrity.violation ?? "ledger invariant violation" };
      }
      return { status: "ok" };
    });

    ctx.provideService("vox.credits", "1.0.0", service);
  },
};

export default creditsPlugin;
