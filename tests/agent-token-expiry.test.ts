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
