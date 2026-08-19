import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { readFileSync } from "fs";
import { runPluginMigrations } from "../server/plugins/migrate";
import { parseManifest } from "../server/plugins/manifest";
import { createPluginDb } from "../server/plugins/db";
import * as repo from "../plugins/credits/server/repo";
import type { PluginDb } from "@vox/plugin-sdk";
import { TEST_PLUGIN_DATABASE_URL, ensurePluginTestDatabase } from "./helpers/plugin-test-db";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("credits repo", () => {
  let pool: Pool;
  let db: PluginDb;

  beforeAll(async () => {
    await ensurePluginTestDatabase();
    pool = new Pool({ connectionString: TEST_PLUGIN_DATABASE_URL });
    await pool.query(`DROP SCHEMA IF EXISTS plugin_credits CASCADE`);
    await pool.query(`DELETE FROM _plugin_schema_versions WHERE plugin_id = 'credits'`).catch(() => {});
    const manifest = parseManifest(JSON.parse(readFileSync("plugins/credits/vox.plugin.json", "utf-8")));
    await runPluginMigrations(pool, [manifest], "plugins");
    db = createPluginDb(pool, "plugin_credits");
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS plugin_credits CASCADE`);
    await pool.query(`DELETE FROM _plugin_schema_versions WHERE plugin_id = 'credits'`).catch(() => {});
    await pool.end();
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
