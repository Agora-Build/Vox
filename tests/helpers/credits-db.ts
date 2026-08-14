import { Pool } from "pg";
import { readFileSync } from "fs";
import { runPluginMigrations } from "../../server/plugins/migrate";
import { parseManifest } from "../../server/plugins/manifest";
import { createPluginDb } from "../../server/plugins/db";
import { createCreditsService, type CreditsService } from "../../plugins/credits/server/service";
import type { PluginDb } from "@vox/plugin-sdk";

export interface CreditsHarness {
  pool: Pool;
  db: PluginDb;
  service: CreditsService;
}

export async function setupCreditsDb(): Promise<CreditsHarness> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`DROP SCHEMA IF EXISTS plugin_credits CASCADE`);
  await pool.query(`DELETE FROM _plugin_schema_versions WHERE plugin_id = 'credits'`).catch(() => {});
  const manifest = parseManifest(JSON.parse(readFileSync("plugins/credits/vox.plugin.json", "utf-8")));
  await runPluginMigrations(pool, [manifest], "plugins");
  const db = createPluginDb(pool, "plugin_credits");
  const service = createCreditsService(db);
  return { pool, db, service };
}
