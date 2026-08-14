import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupCreditsDb, type CreditsHarness } from "./helpers/credits-db";
import { assertInvariants } from "./helpers/credits-invariants";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("credits capture/release", () => {
  let h: CreditsHarness;
  beforeAll(async () => { h = await setupCreditsDb(); });
  afterAll(async () => {
    await h.pool.query(`DROP SCHEMA IF EXISTS "${h.schema}" CASCADE`);
    await h.pool.end();
  });

  it("capture splits escrow into earner + platform, keeping invariants", async () => {
    await h.service.deposit({ userId: 1, credits: 100, reason: "grant", idempotencyKey: "s-seed-1" });
    const { holdId } = await h.service.hold({ payerUserId: 1, credits: 100, idempotencyKey: "s-hold-1" });
    await h.service.capture(holdId, { earnerUserId: 2, platformFeeCredits: 10 });
    expect(await h.service.getBalance(2)).toBe(90);
    const platform = await h.db.query<{ balance_credits: string }>(
      "SELECT balance_credits FROM accounts WHERE system_key = 'platform'");
    expect(Number(platform.rows[0].balance_credits)).toBe(10);
    const escrow = await h.db.query<{ balance_credits: string }>(
      "SELECT balance_credits FROM accounts WHERE system_key = 'escrow'");
    expect(Number(escrow.rows[0].balance_credits)).toBe(0);
    await assertInvariants(h.db);
  });

  it("capture is idempotent and rejects a bad split", async () => {
    await h.service.deposit({ userId: 3, credits: 40, reason: "grant", idempotencyKey: "s-seed-3" });
    const { holdId } = await h.service.hold({ payerUserId: 3, credits: 40, idempotencyKey: "s-hold-3" });
    // fee must be in [0, holdAmount] (40); 41 exceeds it, making earnerShare negative -> invalid split
    await expect(h.service.capture(holdId, { earnerUserId: 4, platformFeeCredits: 41 })).rejects.toThrow(/split/);
    await h.service.capture(holdId, { earnerUserId: 4, platformFeeCredits: 4 });
    await h.service.capture(holdId, { earnerUserId: 4, platformFeeCredits: 4 }); // replay: no-op
    expect(await h.service.getBalance(4)).toBe(36);
    await assertInvariants(h.db);
  });

  it("release refunds the payer in full and is idempotent", async () => {
    await h.service.deposit({ userId: 5, credits: 25, reason: "grant", idempotencyKey: "s-seed-5" });
    const { holdId } = await h.service.hold({ payerUserId: 5, credits: 25, idempotencyKey: "s-hold-5" });
    await h.service.release(holdId);
    await h.service.release(holdId); // replay: no-op
    expect(await h.service.getBalance(5)).toBe(25);
    await assertInvariants(h.db);
  });

  it("rejects release of an already-captured hold", async () => {
    await h.service.deposit({ userId: 6, credits: 10, reason: "grant", idempotencyKey: "s-seed-6" });
    const { holdId } = await h.service.hold({ payerUserId: 6, credits: 10, idempotencyKey: "s-hold-6" });
    await h.service.capture(holdId, { earnerUserId: 7, platformFeeCredits: 0 });
    await expect(h.service.release(holdId)).rejects.toThrow(/captured/);
    await assertInvariants(h.db);
  });
});
