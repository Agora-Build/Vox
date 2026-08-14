import { randomUUID } from "node:crypto";
import type { PluginDb } from "@vox/plugin-sdk";

export type SystemKey = "external" | "escrow" | "platform";

export interface Leg {
  accountId: number;
  amount: number; // signed
  reason: string;
  groupId: string;
  refType?: string | null;
  refId?: string | null;
}

export function newGroupId(): string {
  return randomUUID();
}

export async function systemAccountId(db: PluginDb, key: SystemKey): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM accounts WHERE system_key = $1", [key]);
  if (rows.length === 0) throw new Error(`system account missing: ${key}`);
  return Number(rows[0].id);
}

export async function getOrCreateUserAccount(db: PluginDb, userId: number): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO accounts (kind, user_ref) VALUES ('user', $1)
     ON CONFLICT (user_ref) WHERE user_ref IS NOT NULL DO UPDATE SET user_ref = EXCLUDED.user_ref
     RETURNING id`, [userId]);
  return Number(rows[0].id);
}

export async function getUserBalance(db: PluginDb, userId: number): Promise<number> {
  const { rows } = await db.query<{ balance_credits: string }>(
    "SELECT balance_credits FROM accounts WHERE user_ref = $1", [userId]);
  return rows.length === 0 ? 0 : Number(rows[0].balance_credits);
}

export async function lockUserBalance(tx: PluginDb, accountId: number): Promise<number> {
  const { rows } = await tx.query<{ balance_credits: string }>(
    "SELECT balance_credits FROM accounts WHERE id = $1 FOR UPDATE", [accountId]);
  if (rows.length === 0) throw new Error(`account not found: ${accountId}`);
  return Number(rows[0].balance_credits);
}

export async function applyLeg(tx: PluginDb, leg: Leg): Promise<void> {
  await tx.query(
    `INSERT INTO ledger_entries (account_id, amount, reason, group_id, ref_type, ref_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [leg.accountId, leg.amount, leg.reason, leg.groupId, leg.refType ?? null, leg.refId ?? null]);
  await tx.query(
    "UPDATE accounts SET balance_credits = balance_credits + $1 WHERE id = $2",
    [leg.amount, leg.accountId]);
}

export async function claimIdempotency(
  tx: PluginDb, key: string, operation: string,
): Promise<{ fresh: boolean; result: unknown | null }> {
  // Upsert-lock trick: DO UPDATE takes a row lock whether we insert or conflict,
  // serializing concurrent same-key transactions. xmax = 0 => we inserted a fresh row.
  const { rows } = await tx.query<{ inserted: boolean }>(
    `INSERT INTO idempotency_keys (key, operation) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
     RETURNING (xmax = 0) AS inserted`, [key, operation]);
  if (rows[0].inserted) return { fresh: true, result: null };
  const existing = await tx.query<{ operation: string; result: unknown }>(
    "SELECT operation, result FROM idempotency_keys WHERE key = $1", [key]);
  if (existing.rows[0].operation !== operation) {
    throw new Error(`idempotency key reused across operations: ${key}`);
  }
  return { fresh: false, result: existing.rows[0].result };
}

export async function finalizeIdempotency(
  tx: PluginDb, key: string, groupId: string, result: unknown,
): Promise<void> {
  await tx.query(
    "UPDATE idempotency_keys SET group_id = $2, result = $3 WHERE key = $1",
    [key, groupId, JSON.stringify(result)]);
}

export async function insertHold(
  tx: PluginDb,
  a: { payerAccountId: number; amount: number; holdGroupId: string; refType?: string | null; refId?: string | null },
): Promise<number> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO credit_holds (payer_account_id, amount_credits, hold_group_id, ref_type, ref_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [a.payerAccountId, a.amount, a.holdGroupId, a.refType ?? null, a.refId ?? null]);
  return Number(rows[0].id);
}

export interface HoldRow {
  id: number;
  payerAccountId: number;
  amount: number;
  status: "held" | "captured" | "released";
  refType: string | null;
  refId: string | null;
}

export async function getHoldForUpdate(tx: PluginDb, holdId: number): Promise<HoldRow | null> {
  const { rows } = await tx.query<{
    id: string; payer_account_id: string; amount_credits: string;
    status: "held" | "captured" | "released"; ref_type: string | null; ref_id: string | null;
  }>(
    `SELECT id, payer_account_id, amount_credits, status, ref_type, ref_id
     FROM credit_holds WHERE id = $1 FOR UPDATE`, [holdId]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: Number(r.id), payerAccountId: Number(r.payer_account_id), amount: Number(r.amount_credits),
    status: r.status, refType: r.ref_type, refId: r.ref_id,
  };
}

export async function markHoldSettled(
  tx: PluginDb, holdId: number, status: "captured" | "released", settleGroupId: string,
): Promise<void> {
  await tx.query(
    `UPDATE credit_holds SET status = $2, settle_group_id = $3, settled_at = now() WHERE id = $1`,
    [holdId, status, settleGroupId]);
}
