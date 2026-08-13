import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { writeFile } from "fs/promises";
import { runPluginMigrations } from "../server/plugins/migrate";
import type { PluginManifest } from "../server/plugins/manifest";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const manifest: PluginManifest = {
  id: "mig", version: "1.0.0", voxPluginApi: "^1.0.0",
  providesServices: {}, requiresServices: {}, optionalServices: {}, migrations: "migrations", routes: [],
};
const DIR = "tests/fixtures/plugins";

d("runPluginMigrations (integration)", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(`DROP SCHEMA IF EXISTS plugin_mig CASCADE`);
    await pool.query(`DELETE FROM _plugin_schema_versions WHERE plugin_id = 'mig'`).catch(() => {});
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS plugin_mig CASCADE`);
    await pool.query(`DELETE FROM _plugin_schema_versions WHERE plugin_id = 'mig'`).catch(() => {});
    await pool.end();
  });

  it("creates the schema and applies migrations into it", async () => {
    await runPluginMigrations(pool, [manifest], DIR);
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'plugin_mig' AND table_name = 'thing' ORDER BY column_name`);
    expect(rows.map((r) => r.column_name)).toEqual(["id", "label", "qty"]);
  });

  it("is idempotent (re-running applies nothing new)", async () => {
    await runPluginMigrations(pool, [manifest], DIR);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM _plugin_schema_versions WHERE plugin_id = 'mig'`);
    expect(rows[0].n).toBe(2);
  });

  it("throws when an applied migration file's checksum changed", async () => {
    // tamper with 0002 after it was applied
    const path = `${DIR}/mig/migrations/0002_add.sql`;
    const original = "ALTER TABLE thing ADD COLUMN qty int NOT NULL DEFAULT 0;\n";
    await writeFile(path, original + "-- tampered\n");
    try {
      await expect(runPluginMigrations(pool, [manifest], DIR)).rejects.toThrow(/changed after release/);
    } finally {
      await writeFile(path, original);
    }
  });
});
