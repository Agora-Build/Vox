import { Pool } from "pg";

// =====================================================================
// Dedicated database for DESTRUCTIVE plugin-schema tests (DROP SCHEMA
// ... CASCADE, schema rebuilds, etc).
//
// These tests must NEVER run against the same database as the live dev
// server (DATABASE_URL) — a drop/rebuild window landing under a live
// request previously 500'd plugin routes and once crashed the process.
// This file is the ONLY place that resolves the destructive-test
// connection string; every helper/test that tears schemas down should
// import TEST_PLUGIN_DATABASE_URL (or ensurePluginTestDatabase) from
// here instead of reading DATABASE_URL directly.
//
// There is deliberately no fallback to DATABASE_URL: if the dedicated
// database can't be reached or created, we fail loudly rather than
// silently reintroducing the hazard.
// =====================================================================

const DEFAULT_TEST_PLUGIN_DATABASE_URL = "postgresql://vox:vox123@localhost:5432/vox_plugin_test";

export const TEST_PLUGIN_DATABASE_URL =
  process.env.TEST_PLUGIN_DATABASE_URL ?? DEFAULT_TEST_PLUGIN_DATABASE_URL;

function maintenanceUrlFor(connectionString: string): { url: string; dbName: string } {
  const target = new URL(connectionString);
  const dbName = target.pathname.replace(/^\//, "");
  if (!dbName) {
    throw new Error(`TEST_PLUGIN_DATABASE_URL has no database name: ${connectionString}`);
  }
  const maintenance = new URL(connectionString);
  maintenance.pathname = "/postgres"; // CREATE DATABASE can't run against the DB it would create
  return { url: maintenance.toString(), dbName };
}

async function createDatabaseIfMissing(): Promise<void> {
  const { url, dbName } = maintenanceUrlFor(TEST_PLUGIN_DATABASE_URL);
  const admin = new Pool({ connectionString: url });
  try {
    // CREATE DATABASE cannot run inside a transaction block, so this is a
    // single bare statement on its own connection (pg issues DDL like this
    // outside an implicit transaction by default).
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "42P04") {
      // 42P04 = duplicate_database (already exists) — anything else is a
      // real failure, and we refuse to silently fall back to DATABASE_URL.
      throw new Error(
        `[plugin-test-db] Could not create the dedicated destructive-test database ` +
          `"${dbName}" via ${url}. Destructive plugin-schema tests refuse to fall back to ` +
          `DATABASE_URL (that would drop schemas the live dev server depends on). Create it ` +
          `manually (e.g. \`docker exec <postgres-container> psql -U vox -d postgres -c ` +
          `'CREATE DATABASE ${dbName}'\`) or point TEST_PLUGIN_DATABASE_URL somewhere reachable. ` +
          `Original error: ${(err as Error).message}`,
      );
    }
  } finally {
    await admin.end();
  }
}

let ensured: Promise<void> | undefined;

/** Idempotently ensures the dedicated destructive-test database exists. Safe to call from every test file/helper — repeated calls share one in-flight/settled promise. */
export function ensurePluginTestDatabase(): Promise<void> {
  if (!ensured) {
    ensured = createDatabaseIfMissing().catch((err) => {
      ensured = undefined; // don't cache a permanent failure — allow a later retry
      throw err;
    });
  }
  return ensured;
}

/** Returns a ready-to-use Pool against the dedicated destructive-test database, creating the database first if needed. */
export async function getPluginTestPool(): Promise<Pool> {
  await ensurePluginTestDatabase();
  return new Pool({ connectionString: TEST_PLUGIN_DATABASE_URL });
}
