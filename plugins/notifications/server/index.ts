import type { VoxPlugin, SecretEncryptionService } from "@vox/plugin-sdk";
import { createAccess } from "./access";
import { createAutomation } from "./automation";
import { createDelivery } from "./delivery";
import { registerRoutes } from "./routes";

const plugin: VoxPlugin = {
  async activate(ctx) {
    const encryption = ctx.services.require<SecretEncryptionService>("vox.encryption", "^1.0.0");
    const access = createAccess(ctx);
    const automation = createAutomation(ctx, encryption, access);
    const delivery = createDelivery(ctx, encryption, automation.eligible);
    registerRoutes(ctx, encryption, access, automation, delivery.emailAvailable);
    // Durable per-row leases support replicas without reserving a database
    // connection through SMTP, JavaScript, or LLM execution.
    ctx.worker({ id: "delivery", intervalMs: 5000, run: async () => {
      const deadline = Date.now() + 2500;
      for (let count = 0; count < 10; count++) {
        if (!await delivery.deliver() || Date.now() >= deadline) break;
      }
    } });
    ctx.worker({ id: "rules", intervalMs: 5000, run: automation.run });
    ctx.provideService("vox.notifications", "1.0.0", delivery.service);
    ctx.health(async () => {
      await ctx.db.query("SELECT 1");
      return { status: "ok", detail: delivery.emailAvailable() ? "Email and automation ready" : "Configure SMTP for email; Discord is independent" };
    });
  },
};
export default plugin;
