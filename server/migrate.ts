import { pool, db } from "./storage";

async function runMigrations() {
  // Bootstrap: if this is an existing database that was never managed by drizzle
  // (users table exists but __drizzle_migrations is empty), mark migration 0000 as
  // already applied so drizzle skips it and only runs new migrations (0001+).
  const { rows: usersExists } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users' LIMIT 1`
  );
  if (usersExists.length > 0) {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS drizzle."__drizzle_migrations" (
        id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
      )
    `);
    // Check specifically if 0000 is tracked (not just whether the table is empty)
    const { rows: baseline } = await pool.query(
      `SELECT 1 FROM drizzle."__drizzle_migrations" WHERE hash = $1 LIMIT 1`,
      ["0000_opposite_hobgoblin"]
    );
    if (baseline.length === 0) {
      await pool.query(
        `INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
        ["0000_opposite_hobgoblin", 1775597495926]
      );
      console.log("[db] Existing database detected — baseline migration marked as applied");
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
