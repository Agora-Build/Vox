import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupCreditsDb, type CreditsHarness } from "./helpers/credits-db";
import { assertInvariants } from "./helpers/credits-invariants";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("credits deposit", () => {
  let h: CreditsHarness;
  beforeAll(async () => { h = await setupCreditsDb(); });
  afterAll(async () => {
    await h.pool.query(`DROP SCHEMA IF EXISTS "${h.schema}" CASCADE`);
    await h.pool.end();
  });

  it("credits the user and mirrors external, keeping invariants", async () => {
    await h.service.deposit({ userId: 1, credits: 500, reason: "grant", idempotencyKey: "dep-1" });
    expect(await h.service.getBalance(1)).toBe(500);
    await assertInvariants(h.db);
  });

  it("is idempotent on replay (no second mint)", async () => {
    await h.service.deposit({ userId: 1, credits: 500, reason: "grant", idempotencyKey: "dep-1" });
    expect(await h.service.getBalance(1)).toBe(500);
    await assertInvariants(h.db);
  });

  it("rejects non-positive amounts", async () => {
    await expect(
      h.service.deposit({ userId: 1, credits: 0, reason: "grant", idempotencyKey: "dep-z" }),
    ).rejects.toThrow(/invalid amount/);
  });
});
