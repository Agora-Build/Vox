import { expect } from "vitest";
import type { PluginDb } from "@vox/plugin-sdk";

export async function assertInvariants(db: PluginDb): Promise<void> {
  // Invariant 1: each account's cached balance == Σ of its ledger entries.
  const perAccount = await db.query<{ id: string; drift: string }>(
    `SELECT a.id, a.balance_credits - COALESCE(SUM(e.amount), 0) AS drift
     FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
     GROUP BY a.id, a.balance_credits`);
  for (const row of perAccount.rows) {
    expect(Number(row.drift), `account ${row.id} balance drift`).toBe(0);
  }
  // Invariant 2: global closure — all balances sum to zero.
  const global = await db.query<{ total: string }>(
    "SELECT COALESCE(SUM(balance_credits), 0) AS total FROM accounts");
  expect(Number(global.rows[0].total), "global balance closure").toBe(0);
}
