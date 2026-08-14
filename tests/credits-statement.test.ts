import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupCreditsDb, type CreditsHarness } from "./helpers/credits-db";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("credits statement", () => {
  let h: CreditsHarness;
  beforeAll(async () => {
    h = await setupCreditsDb();
    for (let i = 1; i <= 5; i++) {
      await h.service.deposit({ userId: 1, credits: i * 10, reason: "grant", idempotencyKey: `st-${i}` });
    }
  });
  afterAll(async () => {
    await h.pool.query(`DROP SCHEMA IF EXISTS plugin_credits CASCADE`);
    await h.pool.query(`DELETE FROM _plugin_schema_versions WHERE plugin_id = 'credits'`).catch(() => {});
    await h.pool.end();
  });

  it("returns the caller's entries newest-first", async () => {
    const page = await h.service.getStatement(1);
    expect(page.entries.length).toBe(5);
    expect(page.entries[0].amount).toBe(50); // most recent deposit
    expect(page.entries[4].amount).toBe(10);
    expect(page.nextCursor).toBeNull();
  });

  it("paginates by keyset cursor without gaps or overlaps", async () => {
    const first = await h.service.getStatement(1, { limit: 2 });
    expect(first.entries.map((e) => e.amount)).toEqual([50, 40]);
    expect(first.nextCursor).not.toBeNull();
    const second = await h.service.getStatement(1, { limit: 2, cursor: first.nextCursor! });
    expect(second.entries.map((e) => e.amount)).toEqual([30, 20]);
    const third = await h.service.getStatement(1, { limit: 2, cursor: second.nextCursor! });
    expect(third.entries.map((e) => e.amount)).toEqual([10]);
    expect(third.nextCursor).toBeNull();
  });

  it("returns an empty page for a user with no account", async () => {
    const page = await h.service.getStatement(999);
    expect(page.entries).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
