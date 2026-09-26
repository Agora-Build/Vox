import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { pool } from "../server/storage";

/**
 * Migration 0042 (evalflow → eval_flow): asserts the state it produced on
 * this database, plus the shape of the file itself.
 *
 * Deliberately NOT a replay like 0040/0041's tests were. Those migrations
 * were row-level (UPDATE/DELETE), so replaying them in a rolled-back
 * transaction only took row locks. 0042 is DDL — replaying `ALTER TABLE
 * eval_flows RENAME` holds an ACCESS EXCLUSIVE lock on a table every other
 * suite is querying, which deadlocked the full gate even though the
 * transaction rolled back. A migration that rewrites the schema can't be
 * rehearsed against the shared dev DB; asserting its end state is the honest
 * thing a test can do here.
 *
 * (0040's and 0041's replay tests are gone with this rename: they name
 * `evalflows`, which no longer exists. Both are applied and version-gated in
 * prod, so they cannot re-run or regress.)
 */
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("migration 0042_eval_flow_rename (applied state)", () => {
  it("renamed the table and both FK columns", async () => {
    const { rows } = await pool.query(
      `SELECT to_regclass('eval_flows')::text AS new, to_regclass('evalflows')::text AS old`);
    expect(rows[0].new).toBe("eval_flows");
    expect(rows[0].old).toBeNull();
    for (const table of ["eval_jobs", "eval_schedules"]) {
      const { rows: cols } = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = $1 AND column_name IN ('eval_flow_id','evalflow_id')`, [table]);
      expect(cols.map((c: { column_name: string }) => c.column_name)).toEqual(["eval_flow_id"]);
    }
  });

  it("left no job on the old snapshot key", async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM eval_jobs WHERE snapshot ? 'evalflow'`);
    expect(rows[0].n).toBe(0);
  });

  it("kept the tier indexes, rebuilt on the new key — the metric queries stay indexed", async () => {
    const { rows } = await pool.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE indexname LIKE 'eval_jobs_snap_wf%'`);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.indexdef).toContain("'evalFlow'");
  });

  it("re-keys content byte-for-byte, and the tier SQL reads the key it writes", async () => {
    // Any surviving snapshot must carry the sibling-shaped key with its
    // provenance fields intact — a rewrite that dropped fields would show here.
    const { rows } = await pool.query(
      `SELECT snapshot->'evalFlow' AS wf FROM eval_jobs
       WHERE snapshot ? 'evalFlow' AND snapshot->'evalFlow' <> 'null'::jsonb LIMIT 1`);
    if (rows.length > 0) {
      expect(Object.keys(rows[0].wf)).toEqual(
        expect.arrayContaining(["name", "config", "visibility", "isMainline", "ownerId"]));
    }
    // The readers agree with the writer: no tier query still names the old key.
    const storage = readFileSync("server/storage.ts", "utf-8");
    expect(storage).not.toContain("->'evalflow'");
    expect(storage).toContain("->'evalFlow'");
  });

  it("is written plain, and doesn't chase constraint names (the 0037 lesson)", async () => {
    const sql = readFileSync("migrations/0042_eval_flow_rename.sql", "utf-8");
    expect(sql).not.toMatch(/IF NOT EXISTS|DO \$\$/);
    expect(sql).not.toMatch(/DROP CONSTRAINT|RENAME CONSTRAINT/);
  });
});
