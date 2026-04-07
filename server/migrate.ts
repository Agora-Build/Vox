import { pool, db } from "./storage";

async function runMigrations() {
  // Detect current database state
  const { rows: usersExists } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users' LIMIT 1`
  );
  const { rows: clashExists } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'clash_events' LIMIT 1`
  );

  const isExistingDb = usersExists.length > 0;
  const hasClashTables = clashExists.length > 0;

  if (isExistingDb) {
    // Ensure drizzle migration tracking schema/table exists
    await pool.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS drizzle."__drizzle_migrations" (
        id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
      )
    `);

    // Ensure migration 0000 (original schema baseline) is marked as applied
    const { rows: baseline } = await pool.query(
      `SELECT 1 FROM drizzle."__drizzle_migrations" WHERE hash = $1 LIMIT 1`,
      ["0000_opposite_hobgoblin"]
    );
    if (baseline.length === 0) {
      await pool.query(
        `INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
        ["0000_opposite_hobgoblin", 1775597495926]
      );
      console.log("[db] Baseline migration 0000 marked as applied");
    }

    // If clash tables don't exist but tracking records newer than 0000 exist,
    // those records are stale (tracked but never applied). Remove them so drizzle re-runs.
    if (!hasClashTables) {
      const { rowCount } = await pool.query(
        `DELETE FROM drizzle."__drizzle_migrations" WHERE created_at > $1`,
        [1775597495926]
      );
      if (rowCount && rowCount > 0) {
        console.log(`[db] Removed ${rowCount} stale tracking record(s) — clash tables will be created`);
      }
    }
  }

  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  await migrate(db, { migrationsFolder: "./migrations" });
  console.log("[db] Database migrations applied");
}

runMigrations()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("Failed to run database migrations:", err);
    process.exit(1);
  });
