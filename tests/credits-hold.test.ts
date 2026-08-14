import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupCreditsDb, type CreditsHarness } from "./helpers/credits-db";
import { assertInvariants } from "./helpers/credits-invariants";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("credits hold", () => {
  let h: CreditsHarness;
  beforeAll(async () => {
    h = await setupCreditsDb();
    await h.service.deposit({ userId: 1, credits: 100, reason: "grant", idempotencyKey: "seed-1" });
  });
  afterAll(async () => {
    await h.pool.query(`DROP SCHEMA IF EXISTS plugin_credits CASCADE`);
    await h.pool.query(`DELETE FROM _plugin_schema_versions WHERE plugin_id = 'credits'`).catch(() => {});
    await h.pool.end();
  });

  it("moves credits from payer into escrow and keeps invariants", async () => {
    const { holdId } = await h.service.hold({ payerUserId: 1, credits: 30, idempotencyKey: "hold-1" });
    expect(holdId).toBeGreaterThan(0);
    expect(await h.service.getBalance(1)).toBe(70);
    const escrow = await h.db.query<{ balance_credits: string }>(
      "SELECT balance_credits FROM accounts WHERE system_key = 'escrow'");
    expect(Number(escrow.rows[0].balance_credits)).toBe(30);
    await assertInvariants(h.db);
  });

  it("is idempotent on replay", async () => {
    const first = await h.service.hold({ payerUserId: 1, credits: 30, idempotencyKey: "hold-1" });
    expect(await h.service.getBalance(1)).toBe(70); // unchanged from the first hold
    expect(first.holdId).toBeGreaterThan(0);
    await assertInvariants(h.db);
  });

  it("rejects a hold beyond the payer's balance", async () => {
    await expect(
      h.service.hold({ payerUserId: 1, credits: 999, idempotencyKey: "hold-big" }),
    ).rejects.toThrow(/insufficient/);
    expect(await h.service.getBalance(1)).toBe(70);
    await assertInvariants(h.db);
  });

  it("under a race for a balance sufficient for only one, exactly one hold wins", async () => {
    await h.service.deposit({ userId: 2, credits: 50, reason: "grant", idempotencyKey: "seed-2" });
    const results = await Promise.allSettled([
      h.service.hold({ payerUserId: 2, credits: 50, idempotencyKey: "race-a" }),
      h.service.hold({ payerUserId: 2, credits: 50, idempotencyKey: "race-b" }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;
    expect(ok).toBe(1);
    expect(failed).toBe(1);
    expect(await h.service.getBalance(2)).toBe(0);
    await assertInvariants(h.db);
  });
});
