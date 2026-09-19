import type { VoxPlugin, VoxPluginContext } from "@vox/plugin-sdk";
import { createOrganizationsProvider } from "./provider";

const plugin: VoxPlugin = {
  async activate(ctx: VoxPluginContext): Promise<void> {
    const provider = createOrganizationsProvider(ctx.db);
    ctx.health(async () => {
      try {
        await ctx.db.query("SELECT 1");
      } catch (err) {
        return { status: "down", detail: String(err) };
      }
      const orphans = await ctx.db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM memberships m WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = m.org_ref)",
      );
      if (orphans.rows[0].n !== "0") return { status: "degraded", detail: `${orphans.rows[0].n} orphaned memberships` };
      return { status: "ok" };
    });
    ctx.provideService("vox.organizations", "1.0.0", provider);
  },
};
export default plugin;
