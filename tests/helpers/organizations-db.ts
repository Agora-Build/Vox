import { Pool } from "pg";
import { readdirSync, readFileSync } from "fs";
import { createPluginDb } from "../../server/plugins/db";
import { createOrganizationsProvider } from "../../plugins/organizations/server/provider";
import type { OrganizationsProvider } from "../../plugins/organizations/server/types";
import type { PluginDb } from "@vox/plugin-sdk";
import { TEST_PLUGIN_DATABASE_URL, ensurePluginTestDatabase } from "./plugin-test-db";

export interface OrgsHarness {
  pool: Pool;
  db: PluginDb;
  provider: OrganizationsProvider;
  schema: string;
}

// Per-worker schema: vitest runs test FILES in parallel workers against one
// shared DB. If every file shared the fixed `plugin_organizations` schema, one
// file's DROP/CREATE (below) would yank the tables out from under another
// file running concurrently in a different worker. Files within the SAME
// worker run sequentially, so sharing a schema across the
// organizations-*.test.ts files in one worker is safe; only cross-worker
// sharing is the hazard.
const schema = `plugin_organizations_${process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? process.pid}`;

const MIGRATIONS_DIR = "plugins/organizations/migrations";

export async function setupOrganizationsDb(): Promise<OrgsHarness> {
  // DEDICATED database only — never DATABASE_URL. This drops/rebuilds a
  // schema, and DATABASE_URL is the same database the live dev server uses.
  await ensurePluginTestDatabase();
  const pool = new Pool({ connectionString: TEST_PLUGIN_DATABASE_URL });
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.query(`CREATE SCHEMA "${schema}"`);

  // Apply the plugin's migration SQL directly into this worker-scoped schema.
  // We deliberately bypass runPluginMigrations here: it's hard-coupled to the
  // fixed `plugin_organizations` schema name (via schemaForPlugin) and to the
  // shared `_plugin_schema_versions` bookkeeping table, neither of which fits
  // a dynamic per-worker schema. The migration SQL itself uses unqualified
  // table names, so SET LOCAL search_path is what routes it into `schema`.
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    for (const file of files) {
      const contents = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf-8");
      const statements = contents.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
      for (const statement of statements) await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const db = createPluginDb(pool, schema);
  const provider = createOrganizationsProvider(db);
  return { pool, db, provider, schema };
}
