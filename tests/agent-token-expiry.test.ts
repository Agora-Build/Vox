import { describe, it, expect } from "vitest";
import { pool } from "../server/storage";

// #215: agent tokens end by revocation (checked on every agent path); they
// don't expire. The half-built expires_at column — never set, read only by
// registration — is gone, so no check can behave differently from the others.
const d = process.env.DATABASE_URL ? describe : describe.skip;

d("#215 agent tokens have no expiry", () => {
  it("eval_agent_tokens has no expires_at column", async () => {
    const r = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'eval_agent_tokens' AND column_name = 'expires_at'",
    );
    expect(r.rowCount).toBe(0);
  });
});

d("#219 the analyze lookups have their index", () => {
  it("a user's analyses are read through eval_jobs_analyze_creator_idx", async () => {
    const def = await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'eval_jobs_analyze_creator_idx'");
    expect(def.rows[0]?.indexdef).toMatch(/\(created_by, created_at DESC\) WHERE \(\(kind\)::text = 'analyze'::text\)/);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off"); // the dev table is small; ask for the plan the index allows
      const plan = await client.query(
        "EXPLAIN SELECT count(*) FROM eval_jobs WHERE kind = 'analyze' AND created_by = 2 AND created_at >= now() - interval '1 day'",
      );
      expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain("eval_jobs_analyze_creator_idx");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
