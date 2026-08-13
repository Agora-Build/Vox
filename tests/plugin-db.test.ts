import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { createPluginDb, schemaForPlugin } from "../server/plugins/db";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

describe("schemaForPlugin", () => {
  it("maps kebab ids to underscore schemas", () => {
    expect(schemaForPlugin("shared-agents")).toBe("plugin_shared_agents");
  });
  it("rejects an invalid id", () => {
    expect(() => schemaForPlugin("Bad ID")).toThrow();
  });
});

d("createPluginDb (integration)", () => {
  let pool: Pool;
  const schema = "plugin_dbtest";

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE ${schema}.t (id serial primary key, n int)`);
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  it("queries within the plugin schema without qualifying names", async () => {
    const db = createPluginDb(pool, schema);
    await db.query("INSERT INTO t (n) VALUES ($1)", [7]);
    const { rows } = await db.query<{ n: number }>("SELECT n FROM t");
    expect(rows[0].n).toBe(7);
  });

  it("commits a successful transaction and rolls back a failing one", async () => {
    const db = createPluginDb(pool, schema);
    await db.withTransaction(async (tx) => { await tx.query("INSERT INTO t (n) VALUES (100)"); });
    let threw = false;
    try {
      await db.withTransaction(async (tx) => {
        await tx.query("INSERT INTO t (n) VALUES (200)");
        throw new Error("boom");
      });
    } catch { threw = true; }
    expect(threw).toBe(true);
    const { rows } = await db.query<{ n: number }>("SELECT n FROM t WHERE n IN (100,200) ORDER BY n");
    expect(rows.map((r) => r.n)).toEqual([100]);
  });

  it("does not leak search_path onto the shared pool after a plugin query", async () => {
    // A dedicated single-connection pool guarantees the raw follow-up query
    // below reuses the exact same physical connection the plugin query used.
    const solo = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const db = createPluginDb(solo, schema);
      await db.query("SELECT 1"); // pins plugin schema for the duration of its own transaction only

      // current_schemas(false) excludes implicit pg_catalog, showing only the
      // effective search_path. It must be back to the connection default
      // (public), not still carrying the plugin schema from the prior query.
      const { rows } = await solo.query<{ s: string[] }>("SELECT current_schemas(false) AS s");
      expect(rows[0].s).not.toContain(schema);
      expect(rows[0].s).toContain("public");
    } finally {
      await solo.end();
    }
  });
});
