import type { VoxPlugin } from "@vox/plugin-sdk";

const samplePlugin: VoxPlugin = {
  async activate(ctx) {
    ctx.http((r) => {
      r.get("/notes", r.requireAuth, async (_req, res) => {
        const { rows } = await ctx.db.query(
          "SELECT id, body, created_at FROM notes ORDER BY id DESC LIMIT 100");
        res.json(rows);
      });
      r.post("/notes", r.requireAuth, async (req, res) => {
        const body = String((req.body?.body ?? "")).slice(0, 500);
        const { rows } = await ctx.db.query(
          "INSERT INTO notes (body) VALUES ($1) RETURNING id, body, created_at", [body]);
        res.status(201).json(rows[0]);
      });
    });

    ctx.worker({
      id: "prune",
      intervalMs: 60_000,
      singleton: true,
      run: async () => {
        await ctx.db.query("DELETE FROM notes WHERE created_at < now() - interval '30 days'");
      },
    });

    ctx.health(async () => {
      try {
        await ctx.db.query("SELECT 1");
        return { status: "ok" };
      } catch (err) {
        return { status: "down", detail: String(err) };
      }
    });

    ctx.provideService("vox.sample", "1.0.0", {
      count: async (): Promise<number> => {
        const { rows } = await ctx.db.query<{ n: string }>("SELECT count(*)::text AS n FROM notes");
        return Number(rows[0].n);
      },
    });
  },
};

export default samplePlugin;
