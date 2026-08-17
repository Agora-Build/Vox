import { Pool } from "pg";
import { readdirSync, readFileSync } from "fs";
import { createPluginDb } from "../../server/plugins/db";
import { createCreditsService, type CreditsService } from "../../plugins/credits/server/service";
import type { PluginDb } from "@vox/plugin-sdk";

export interface MarketplaceHarness {
  pool: Pool;
  marketplaceDb: PluginDb;
  creditsDb: PluginDb;
  credits: CreditsService;
  sharedSchema: string;
  creditsSchema: string;
}

const suffix = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? String(process.pid);
const SHARED_SCHEMA = `plugin_shared_agents_${suffix}`;
const CREDITS_SCHEMA = `plugin_credits_sa_${suffix}`;

async function applyMigrations(pool: Pool, schema: string, dir: string): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    for (const file of files) {
      const contents = readFileSync(`${dir}/${file}`, "utf-8");
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
}

export async function setupMarketplaceDb(): Promise<MarketplaceHarness> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await applyMigrations(pool, CREDITS_SCHEMA, "plugins/credits/migrations");
  await applyMigrations(pool, SHARED_SCHEMA, "plugins/shared-agents/migrations");
  const creditsDb = createPluginDb(pool, CREDITS_SCHEMA);
  const marketplaceDb = createPluginDb(pool, SHARED_SCHEMA);
  const credits = createCreditsService(creditsDb);
  return { pool, marketplaceDb, creditsDb, credits, sharedSchema: SHARED_SCHEMA, creditsSchema: CREDITS_SCHEMA };
}

export async function teardownMarketplaceDb(h: MarketplaceHarness): Promise<void> {
  await h.pool.query(`DROP SCHEMA IF EXISTS "${h.sharedSchema}" CASCADE`);
  await h.pool.query(`DROP SCHEMA IF EXISTS "${h.creditsSchema}" CASCADE`);
  await h.pool.end();
}
