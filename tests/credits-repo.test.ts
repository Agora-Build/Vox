import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as repo from "../plugins/credits/server/repo";
import type { PluginDb } from "@vox/plugin-sdk";
import { setupCreditsDb, type CreditsHarness } from "./helpers/credits-db";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("credits repo", () => {
  let h: CreditsHarness;
  let db: PluginDb;

  // Worker-scoped schema via the shared credits harness, like the other
  // credits-*.test.ts files. This suite used to migrate into the fixed
  // `plugin_credits` schema, which credits-e2e.test.ts also drops and rebuilds
  // (it has to: it exercises the real loader). Running in parallel workers,
  // each dropped the other's tables mid-run. The migration runner itself is
  // covered by credits-e2e; this file only needs the tables.
  beforeAll(async () => {
    h = await setupCreditsDb();
    db = h.db;
  });

  afterAll(async () => {
    await h.pool.query(`DROP SCHEMA IF EXISTS "${h.schema}" CASCADE`);
    await h.pool.end();
  });

  it("resolves the three system accounts", async () => {
    for (const key of ["external", "escrow", "platform"] as const) {
      expect(await repo.systemAccountId(db, key)).toBeGreaterThan(0);
    }
  });

  it("creates a user account once (idempotent) and reads zero balance", async () => {
    const a = await repo.getOrCreateUserAccount(db, 7);
    const b = await repo.getOrCreateUserAccount(db, 7);
    expect(a).toBe(b);
    expect(await repo.getUserBalance(db, 7)).toBe(0);
  });

  it("applyLeg writes an entry and moves the cached balance", async () => {
    const acct = await repo.getOrCreateUserAccount(db, 8);
    const gid = repo.newGroupId();
    await db.withTransaction(async (tx) => {
      await repo.applyLeg(tx, { accountId: acct, amount: 250, reason: "grant", groupId: gid });
    });
    expect(await repo.getUserBalance(db, 8)).toBe(250);
    const { rows } = await db.query<{ amount: string }>(
      "SELECT amount FROM ledger_entries WHERE group_id = $1", [gid]);
    expect(rows.map((r) => Number(r.amount))).toEqual([250]);
  });

  it("claimIdempotency returns fresh once, then the stored result on replay", async () => {
    const key = "k-" + repo.newGroupId();
    const gid = repo.newGroupId();
    await db.withTransaction(async (tx) => {
      const first = await repo.claimIdempotency(tx, key, "deposit");
      expect(first.fresh).toBe(true);
      await repo.finalizeIdempotency(tx, key, gid, { groupId: gid });
    });
    await db.withTransaction(async (tx) => {
      const second = await repo.claimIdempotency(tx, key, "deposit");
      expect(second.fresh).toBe(false);
      expect(second.result).toEqual({ groupId: gid });
    });
  });
});
