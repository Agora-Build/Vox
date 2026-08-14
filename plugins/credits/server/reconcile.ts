import type { PluginDb } from "@vox/plugin-sdk";

export const STALE_HOLD_MS = 24 * 60 * 60 * 1000;

export async function checkInvariants(
  db: PluginDb,
): Promise<{ ok: boolean; violation: string | null }> {
  // Invariant 1: per-account cached balance == Σ of its ledger entries.
  const drift = await db.query<{ id: string }>(
    `SELECT a.id FROM accounts a
     LEFT JOIN ledger_entries e ON e.account_id = a.id
     GROUP BY a.id, a.balance_credits
     HAVING a.balance_credits <> COALESCE(SUM(e.amount), 0)
     LIMIT 1`);
  if (drift.rows.length > 0) {
    return { ok: false, violation: `account ${drift.rows[0].id} cached balance != sum of ledger entries` };
  }

  // Invariant 2: global closure — all balances sum to zero.
  const global = await db.query<{ total: string }>(
    "SELECT COALESCE(SUM(balance_credits), 0) AS total FROM accounts");
  if (Number(global.rows[0].total) !== 0) {
    return { ok: false, violation: `global balance closure broken (sum = ${global.rows[0].total})` };
  }

  // Invariant 3: no 'held' hold older than STALE_HOLD_MS (a leaked settlement).
  const stale = await db.query<{ id: string }>(
    `SELECT id FROM credit_holds
     WHERE status = 'held' AND created_at < now() - ($1::bigint * interval '1 millisecond')
     LIMIT 1`, [STALE_HOLD_MS]);
  if (stale.rows.length > 0) {
    return { ok: false, violation: `stale held hold ${stale.rows[0].id} exceeds settlement TTL` };
  }

  return { ok: true, violation: null };
}
