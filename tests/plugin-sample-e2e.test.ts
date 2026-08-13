import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { Pool } from "pg";
import { loadPlugins, type LoadedPlugins } from "../server/plugins/loader";
import { BUILTIN_PLUGINS } from "../plugins/index";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("sample plugin end-to-end", () => {
  let pool: Pool;
  let loaded: LoadedPlugins;
  let app: express.Express;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(`DROP SCHEMA IF EXISTS plugin_sample CASCADE`);
    await pool.query(`DELETE FROM _plugin_schema_versions WHERE plugin_id = 'sample'`).catch(() => {});
    process.env.VOX_PLUGINS = "sample";
    app = express();
    app.use(express.json());
    loaded = await loadPlugins(app, pool, BUILTIN_PLUGINS);
  });

  afterAll(async () => {
    await loaded.shutdown();
    await pool.query(`DROP SCHEMA IF EXISTS plugin_sample CASCADE`);
    await pool.query(`DELETE FROM _plugin_schema_versions WHERE plugin_id = 'sample'`).catch(() => {});
    delete process.env.VOX_PLUGINS;
    await pool.end();
  });

  it("creates the plugin schema and notes table via migration", async () => {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'plugin_sample' AND table_name = 'notes'`);
    expect(rows.length).toBe(1);
  });

  it("reports health ok and lists the plugin", async () => {
    const health = await request(app).get("/api/plugins/sample/health");
    expect(health.body).toEqual({ status: "ok" });
    const list = await request(app).get("/api/plugins");
    expect(list.body).toEqual([
      { id: "sample", version: "1.0.0", servicesProvided: ["vox.sample"], servicesRequired: [] },
    ]);
  });

  it("round-trips a note through ctx.db", async () => {
    await pool.query(`SET search_path TO plugin_sample`);
    await pool.query(`INSERT INTO plugin_sample.notes (body) VALUES ('hello')`);
    const { rows } = await pool.query(`SELECT body FROM plugin_sample.notes`);
    expect(rows.map((r) => r.body)).toContain("hello");
  });
});
