/**
 * Version-based schema migration runner.
 *
 * How it works:
 * - DB stores current schema version in `_schema_version` table (single row)
 * - Code defines MIGRATIONS list — one entry per version step, pointing to SQL file
 * - On startup: compare DB version vs TARGET_VERSION; run any missing steps in order
 * - Each step runs in a transaction and updates the version atomically
 * - PostgreSQL advisory lock prevents concurrent migrations (safe for multi-instance deploys)
 *
 * Adding a new migration:
 * 1. Run `npm run db:generate` → creates SQL file in migrations/
 * 2. Append a new entry to MIGRATIONS below
 * 3. TARGET_VERSION updates automatically (last entry's version)
 * 4. Commit both files together
 */

import { readFile } from "fs/promises";
import { pool } from "./storage";

// Migration history — append only, never modify existing entries
// version: monotonically increasing integer
// file: SQL filename in migrations/ folder, or null for baseline (no SQL to run)
const MIGRATIONS: Array<{ version: number; description: string; file: string | null }> = [
  { version: 1, description: "baseline — original schema", file: "0000_opposite_hobgoblin.sql" },
  { version: 2, description: "clash tables",               file: "0001_clash_tables.sql" },
];

const TARGET_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

// Arbitrary fixed lock ID for pg_advisory_lock — prevents concurrent migration runs
const PG_LOCK_ID = 987654321;

async function ensureVersionTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _schema_version (
      version integer NOT NULL
    )
  `);
}

async function getDbVersion(): Promise<number> {
  await ensureVersionTable();
  const { rows } = await pool.query(`SELECT version FROM _schema_version LIMIT 1`);
  return rows.length > 0 ? (rows[0].version as number) : 0;
}

async function runMigrations(): Promise<void> {
  // Acquire advisory lock — blocks if another instance is migrating
  await pool.query(`SELECT pg_advisory_lock($1)`, [PG_LOCK_ID]);

  try {
    await ensureVersionTable();

    let currentVersion = await getDbVersion();

    // Bootstrap: if DB has existing tables but no version record,
    // it's at baseline (version 1) — no need to re-run the original schema.
    if (currentVersion === 0) {
      const { rows } = await pool.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'users' LIMIT 1`
      );
      if (rows.length > 0) {
        currentVersion = 1;
        await pool.query(`INSERT INTO _schema_version (version) VALUES ($1)`, [1]);
        console.log("[db] Existing database detected — initialized at schema version 1");
      }
    }

    if (currentVersion >= TARGET_VERSION) {
      console.log(`[db] Schema is up to date (version ${currentVersion})`);
      return;
    }

    console.log(`[db] Migrating schema: version ${currentVersion} → ${TARGET_VERSION}`);

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) continue;
      if (!migration.file) continue;

      console.log(`[db] Applying v${migration.version}: ${migration.description}`);

      const sql = await readFile(`./migrations/${migration.file}`, "utf-8");

      // Split on drizzle's statement-breakpoint markers and run each statement
      const statements = sql
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const statement of statements) {
          await client.query(statement);
        }
        // Update version atomically in the same transaction
        await client.query(`DELETE FROM _schema_version`);
        await client.query(`INSERT INTO _schema_version (version) VALUES ($1)`, [migration.version]);
        await client.query("COMMIT");
        console.log(`[db] v${migration.version} applied (${migration.description})`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    console.log(`[db] Schema migration complete — now at version ${TARGET_VERSION}`);
  } finally {
    await pool.query(`SELECT pg_advisory_unlock($1)`, [PG_LOCK_ID]);
  }
}

runMigrations()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[db] Migration failed:", err);
    process.exit(1);
  });
