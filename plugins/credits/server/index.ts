import type { VoxPlugin } from "@vox/plugin-sdk";

const creditsPlugin: VoxPlugin = {
  async activate(ctx) {
    ctx.health(async () => {
      try {
        await ctx.db.query("SELECT 1");
        return { status: "ok" };
      } catch (err) {
        return { status: "down", detail: String(err) };
      }
    });
  },
};

export default creditsPlugin;
