import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { pool } from "../server/storage";

/**
 * Migration 0042 (evalflow → eval_flow) — executes the REAL migration file
 * against fixture rows inside a rolled-back transaction, so the SQL that
 * ships is the SQL that's proven.
 *
 * On the tests this replaces: 0040 and 0041 had round-trip tests of the same
 * shape. They can't survive 0042 — they replay historical SQL naming
 * `evalflows`, and this migration renames that table out from under them.
 * Their value was delivered before those migrations shipped (both are applied
 * in prod and version-gated, so they cannot re-run or regress), so they're
 * removed rather than propped up. Their two non-migration assertions moved to
 * tests/legacy-config-keys.test.ts, where they belong.
 */
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("migration 0042_eval_flow_rename.sql (transactional, rolled back)", () => {
  const stamp = `mig0042-${Date.now()}`;
  let client: import("pg").PoolClient;

  beforeAll(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    // Undo 0042 inside the transaction so the real file can be replayed over
    // the pre-rename shape it was written against.
    await client.query(`ALTER TABLE eval_flows RENAME TO evalflows`);
    await client.query(`ALTER TABLE eval_jobs RENAME COLUMN eval_flow_id TO evalflow_id`);
    await client.query(`ALTER TABLE eval_schedules RENAME COLUMN eval_flow_id TO evalflow_id`);
    await client.query(`DROP INDEX eval_jobs_snap_wf_visibility_idx`);
    await client.query(`DROP INDEX eval_jobs_snap_wf_mainline_idx`);
    await client.query(`CREATE INDEX eval_jobs_snap_wf_visibility_idx ON eval_jobs ((snapshot->'evalflow'->>'visibility'))`);
    await client.query(`CREATE INDEX eval_jobs_snap_wf_mainline_idx ON eval_jobs ((snapshot->'evalflow'->>'isMainline'))`);

    const { rows: [wf] } = await client.query(
      `INSERT INTO evalflows (name, owner_id, provider_id, visibility, transport, config)
       VALUES ($1, 1, (SELECT id FROM providers LIMIT 1), 'private', 'web', '{"framework":"aeval"}'::jsonb)
       RETURNING id`, [`${stamp}-wf`]);
    // A job carrying the OLD snapshot key, plus one whose snapshot is a JSON
    // scalar (the shape that would abort a pre-start migration).
    await client.query(
      `INSERT INTO eval_jobs (evalflow_id, trigger_type, created_by, target_region, target_tier, config, snapshot, status, priority, retry_count, max_retries)
       VALUES ($1, 2, 1, 'na-us-seattle', 'private', '{}'::jsonb, $2::jsonb, 'completed', 0, 0, 3)`,
      [wf.id, JSON.stringify({ evalflow: { name: `${stamp}-snap`, visibility: "public", isMainline: true }, evalSet: null })],
    );
    await client.query(
      `INSERT INTO eval_jobs (evalflow_id, trigger_type, created_by, target_region, target_tier, config, snapshot, status, priority, retry_count, max_retries)
       VALUES ($1, 2, 1, 'na-us-seattle', 'private', '{"scenario":"# scalar-snap"}'::jsonb, 'null'::jsonb, 'completed', 0, 0, 3)`,
      [wf.id],
    );

    const sql = readFileSync("./migrations/0042_eval_flow_rename.sql", "utf-8");
    for (const statement of sql.split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean)) {
      await client.query(statement);
    }
  });

  afterAll(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  it("renames the table and both FK columns", async () => {
    const { rows } = await client.query(
      `SELECT to_regclass('eval_flows')::text AS new, to_regclass('evalflows')::text AS old`);
    expect(rows[0].new).toBe("eval_flows");
    expect(rows[0].old).toBeNull();
    for (const table of ["eval_jobs", "eval_schedules"]) {
      const { rows: cols } = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = $1 AND column_name IN ('eval_flow_id','evalflow_id')`, [table]);
      expect(cols.map((c: { column_name: string }) => c.column_name)).toEqual(["eval_flow_id"]);
    }
  });

  it("re-keys snapshots to evalFlow, content byte-for-byte", async () => {
    const { rows } = await client.query(
      `SELECT snapshot FROM eval_jobs WHERE snapshot #>> '{evalFlow,name}' = $1`, [`${stamp}-snap`]);
    expect(rows).toHaveLength(1);
    expect(rows[0].snapshot.evalflow).toBeUndefined();
    expect(rows[0].snapshot.evalFlow).toEqual({ name: `${stamp}-snap`, visibility: "public", isMainline: true });
    expect(rows[0].snapshot).toHaveProperty("evalSet"); // sibling keys untouched
  });

  it("leaves no rows on the old snapshot key", async () => {
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM eval_jobs WHERE snapshot ? 'evalflow'`);
    expect(rows[0].n).toBe(0);
  });

  it("survives a job whose snapshot is a JSON scalar (would abort a pre-start migration)", async () => {
    const { rows } = await client.query(
      `SELECT snapshot FROM eval_jobs WHERE config->>'scenario' = '# scalar-snap'`);
    expect(rows[0].snapshot).toBeNull(); // JSON null, left alone — and no raise
  });

  it("rebuilds the tier indexes on the new key, so the metric queries stay indexed", async () => {
    const { rows } = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE indexname LIKE 'eval_jobs_snap_wf%'`);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.indexdef).toContain("'evalFlow'");
    }
  });
});
