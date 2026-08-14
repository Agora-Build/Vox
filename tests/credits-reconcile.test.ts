import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupCreditsDb, type CreditsHarness } from "./helpers/credits-db";
import { checkInvariants } from "../plugins/credits/server/reconcile";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("credits reconcile", () => {
  let h: CreditsHarness;
  beforeAll(async () => {
    h = await setupCreditsDb();
    await h.service.deposit({ userId: 1, credits: 100, reason: "grant", idempotencyKey: "rc-1" });
  });
  afterAll(async () => {
    await h.pool.query(`DROP SCHEMA IF EXISTS plugin_credits CASCADE`);
    await h.pool.query(`DELETE FROM _plugin_schema_versions WHERE plugin_id = 'credits'`).catch(() => {});
    await h.pool.end();
  });

  it("passes on a healthy ledger", async () => {
    const r = await checkInvariants(h.db);
    expect(r).toEqual({ ok: true, violation: null });
  });

  it("detects a cached-balance drift (invariant 1)", async () => {
    // Corrupt the cached balance directly, bypassing the ledger.
    await h.pool.query(
      `UPDATE plugin_credits.accounts SET balance_credits = balance_credits + 1 WHERE user_ref = 1`);
    const r = await checkInvariants(h.db);
    expect(r.ok).toBe(false);
    expect(r.violation).toMatch(/balance/i);
    // repair for cleanliness
    await h.pool.query(
      `UPDATE plugin_credits.accounts SET balance_credits = balance_credits - 1 WHERE user_ref = 1`);
  });

  it("detects a global-closure break (invariant 2)", async () => {
    await h.pool.query(
      `UPDATE plugin_credits.accounts SET balance_credits = balance_credits + 5 WHERE system_key = 'platform'`);
    const r = await checkInvariants(h.db);
    expect(r.ok).toBe(false);
    // invariant 1 (platform now drifts) or invariant 2 — either is a real violation
    expect(r.violation).toBeTruthy();
    await h.pool.query(
      `UPDATE plugin_credits.accounts SET balance_credits = balance_credits - 5 WHERE system_key = 'platform'`);
  });
});
