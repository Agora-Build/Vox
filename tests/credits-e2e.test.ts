import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { Pool } from "pg";
import { loadPlugins, type LoadedPlugins } from "../server/plugins/loader";
import { BUILTIN_PLUGINS } from "../plugins/index";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("credits plugin end-to-end", () => {
  let pool: Pool;
  let loaded: LoadedPlugins;
  let app: express.Express;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(`DROP SCHEMA IF EXISTS plugin_credits CASCADE`);
    await pool.query(`DELETE FROM _plugin_schema_versions WHERE plugin_id = 'credits'`).catch(() => {});
    process.env.VOX_PLUGINS = "credits";
    app = express();
    app.use(express.json());
    loaded = await loadPlugins(app, pool, BUILTIN_PLUGINS);
  });

  afterAll(async () => {
    await loaded.shutdown();
    await pool.query(`DROP SCHEMA IF EXISTS plugin_credits CASCADE`);
    await pool.query(`DELETE FROM _plugin_schema_versions WHERE plugin_id = 'credits'`).catch(() => {});
    delete process.env.VOX_PLUGINS;
    await pool.end();
  });

  it("creates all four tables via migration", async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'plugin_credits' ORDER BY table_name`);
    expect(rows.map((r) => r.table_name)).toEqual(
      ["accounts", "credit_holds", "idempotency_keys", "ledger_entries"]);
  });

  it("seeds exactly the three system accounts with zero balance", async () => {
    const { rows } = await pool.query(
      `SELECT system_key, balance_credits FROM plugin_credits.accounts
       WHERE kind = 'system' ORDER BY system_key`);
    expect(rows).toEqual([
      { system_key: "escrow", balance_credits: "0" },
      { system_key: "external", balance_credits: "0" },
      { system_key: "platform", balance_credits: "0" },
    ]);
  });

  it("reports health ok and lists the plugin", async () => {
    const health = await request(app).get("/api/plugins/credits/health");
    expect(health.body).toEqual({ status: "ok" });
    const list = await request(app).get("/api/plugins");
    expect(list.body).toContainEqual(
      { id: "credits", version: "1.0.0", servicesProvided: ["vox.credits"], servicesRequired: [] });

    const bal = await request(app).get("/api/plugins/credits/balance");
    expect(bal.status).toBe(401); // requireAuth with no session
  });
});
