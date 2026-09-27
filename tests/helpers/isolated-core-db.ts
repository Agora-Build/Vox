import { execFileSync } from "node:child_process";
import { Pool } from "pg";

/**
 * A private, freshly migrated Core database for a suite that drives the
 * scheduler / maintenance workers IN-PROCESS and asserts on what they write.
 *
 * Such a suite cannot share the dev database: the live dev server runs the
 * very same workers every 60s against it, so any due work the suite seeds
 * (armed schedules, backdated pending jobs) is fair game for the server too,
 * and a write the server makes is indistinguishable from one the code under
 * test made. Here nothing else can connect, so every observed write came from
 * the test.
 *
 * Built with the real migration runner (server/migrate.ts) — the same path
 * production takes — and recreated on every run, so no state carries over.
 *
 * Must run before `server/storage` is imported, because storage binds its pool
 * to DATABASE_URL at import. Call it from `vi.hoisted`.
 */
export async function prepareIsolatedCoreDb(baseUrl: string, dbName: string): Promise<string> {
  const admin = new URL(baseUrl);
  admin.pathname = "/postgres";
  const pool = new Pool({ connectionString: admin.toString() });
  try {
    await pool.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await pool.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await pool.end();
  }

  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  execFileSync("npx", ["tsx", "server/migrate.ts"], {
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: "pipe",
  });
  return url.toString();
}
