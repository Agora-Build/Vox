import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { evalAgentTokens } from "../shared/schema";
import { pool } from "../server/storage";

// #215: agent tokens end by revocation (checked on every agent path); they
// don't expire. The half-built expires_at — never set, read only by
// registration — is out of the code: nothing selects or checks it. (The
// column itself is dropped in a later release, so during a deploy the old
// container never queries a missing column.)
describe("#215 agent tokens have no expiry", () => {
  it("the code no longer has the column", () => {
    expect(Object.keys(getTableColumns(evalAgentTokens))).not.toContain("expiresAt");
  });
});

const d = process.env.DATABASE_URL ? describe : describe.skip;

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
