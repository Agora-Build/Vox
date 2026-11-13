import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pool } from "../server/storage";

const d = process.env.DATABASE_URL ? describe : describe.skip;
const routing = readFileSync(new URL("../migrations/0069_core_connection_routing.sql", import.meta.url), "utf8");
const concurrent = readFileSync(new URL("../migrations/0070_concurrent_browser_viewers.sql", import.meta.url), "utf8");

d("concurrent-viewer migration", () => {
  it.each(["key", "unique"])("removes the %s constraint naming variant without leaving exclusive admission", async (suffix) => {
    const client = await pool.connect();
    const schema = `browser_migration_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query("CREATE TABLE users (id integer PRIMARY KEY); CREATE TABLE eval_jobs (id integer PRIMARY KEY)");
      await client.query(routing);
      if (suffix === "unique") await client.query("ALTER TABLE browser_viewer_grants RENAME CONSTRAINT browser_viewer_grants_target_key_key TO browser_viewer_grants_target_key_unique");
      await client.query(concurrent);
      await client.query("INSERT INTO users VALUES (1); INSERT INTO eval_jobs VALUES (1)");
      for (let i = 0; i < 2; i++) await client.query(`INSERT INTO browser_viewer_grants
        (id, user_id, job_id, target_key, target, expires_at) VALUES ($1, 1, 1, 'shared-target', '{}', clock_timestamp() + interval '6 seconds')`, [randomUUID()]);
      expect((await client.query("SELECT count(*)::integer AS count FROM browser_viewer_grants")).rows[0].count).toBe(2);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
