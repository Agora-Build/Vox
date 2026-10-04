import type { Request } from "express";
import { z } from "zod";
import type { PluginDb, UserDirectoryService, VerificationService, VerificationProof } from "@vox/plugin-sdk";
import type { CreditsService } from "./service";

export const grantSchema = z.object({
  batchId: z.string().uuid(),
  userIds: z.array(z.number().int().positive().max(2147483647)).min(1).max(500),
  credits: z.number().int().positive().max(1_000_000_000),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type GrantPayload = z.infer<typeof grantSchema>;
export class GrantError extends Error {}
export function normalizedGrant(input: unknown): GrantPayload {
  const data = grantSchema.parse(input);
  return { ...data, userIds: Array.from(new Set(data.userIds)).sort((a, b) => a - b) };
}

export function createPersonalCredits(db: PluginDb, base: CreditsService, users: UserDirectoryService, verification: VerificationService) {
  const welcome = (userId: number) => base.deposit({ userId, credits: 100, reason: "welcome", ref: { type: "welcome", id: String(userId) }, idempotencyKey: `welcome:v1:${userId}` });
  const service: CreditsService = {
    ...base,
    async getBalance(userId) { await welcome(userId); return base.getBalance(userId); },
    async getStatement(userId, opts) { await welcome(userId); return base.getStatement(userId, opts); },
    async hold(input) { await welcome(input.payerUserId); return base.hold(input); },
  };
  const runBatch = async (batchId?: string) => {
    const { rows: [batch] } = await db.query<{ id: string; credits: string; reason: string }>(
      `SELECT id,credits,reason FROM grant_batches WHERE status='approved' ${batchId ? "AND id=$1" : ""} ORDER BY created_at LIMIT 1`, batchId ? [batchId] : []);
    if (!batch) return;
    const { rows: recipients } = await db.query<{ user_id: number }>("SELECT user_id FROM grant_recipients WHERE batch_id=$1 AND group_id IS NULL ORDER BY user_id", [batch.id]);
    for (const recipient of recipients) {
      await welcome(recipient.user_id);
      const result = await base.deposit({ userId: recipient.user_id, credits: Number(batch.credits), reason: batch.reason,
        ref: { type: "admin_grant", id: batch.id }, idempotencyKey: `admin-grant:${batch.id}:${recipient.user_id}` });
      // Commit each checkpoint separately; the ledger key also makes concurrent
      // retries safe if a process dies between deposit and checkpoint.
      await db.query("UPDATE grant_recipients SET group_id=$3 WHERE batch_id=$1 AND user_id=$2 AND group_id IS NULL", [batch.id, recipient.user_id, result.groupId]);
    }
    await db.query("UPDATE grant_batches SET status='completed',completed_at=now() WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM grant_recipients WHERE batch_id=$1 AND group_id IS NULL)", [batch.id]);
  };
  return {
    service, runBatch,
    async inspect(userId: number) {
      // Admin inspection is read-only, including for deleted/unknown Core IDs.
      return { balance: await base.getBalance(userId), recent: (await base.getStatement(userId, { limit: 100 })).entries };
    },
    async backfill() {
      const { rows: [cursor] } = await db.query<{ last_user_id: number }>("SELECT last_user_id FROM welcome_backfill WHERE id=1");
      const ids = await users.listIds(cursor.last_user_id, 100);
      for (const id of ids) await welcome(id);
      if (ids.length) await db.query("UPDATE welcome_backfill SET last_user_id=GREATEST(last_user_id,$1) WHERE id=1", [ids[ids.length - 1]]);
    },
    async grant(req: Request, input: unknown, proof: VerificationProof) {
      const payload = normalizedGrant(input);
      const adminId = req.session.userId!;
      const { rows: [existing] } = await db.query<{ admin_user_id: number; user_ids: number[]; credits: string; reason: string }>("SELECT * FROM grant_batches WHERE id=$1", [payload.batchId]);
      if (existing) {
        if (existing.admin_user_id !== adminId || Number(existing.credits) !== payload.credits || existing.reason !== payload.reason || JSON.stringify(existing.user_ids) !== JSON.stringify(payload.userIds)) throw new GrantError("Batch ID already belongs to a different grant");
      } else {
        const recipients = await users.getUsers(payload.userIds);
        if (recipients.length !== payload.userIds.length) throw new GrantError("One or more recipients do not exist");
        const receipt = await verification.consume(req, "credits.grant", payload, proof);
        await db.withTransaction(async (tx) => {
          await tx.query("INSERT INTO grant_batches(id,admin_user_id,user_ids,credits,reason,verification_receipt) VALUES($1,$2,$3,$4,$5,$6)",
            [payload.batchId, adminId, payload.userIds, payload.credits, payload.reason, receipt]);
          for (const id of payload.userIds) await tx.query("INSERT INTO grant_recipients(batch_id,user_id) VALUES($1,$2)", [payload.batchId, id]);
        });
      }
      await runBatch(payload.batchId);
      return { batchId: payload.batchId, recipients: payload.userIds.length, totalCredits: payload.credits * payload.userIds.length };
    },
    async usage(userId: number) {
      const available = await service.getBalance(userId);
      const { rows: [totals] } = await db.query<{ reserved: string; spent: string; spent_month: string }>(
        `SELECT COALESCE(sum(h.amount_credits) FILTER(WHERE h.status='held'),0) AS reserved,
         COALESCE(sum(h.amount_credits) FILTER(WHERE h.status='captured'),0) AS spent,
         COALESCE(sum(h.amount_credits) FILTER(WHERE h.status='captured' AND h.settled_at>=date_trunc('month',now())),0) AS spent_month
         FROM credit_holds h JOIN accounts a ON a.id=h.payer_account_id WHERE a.user_ref=$1`, [userId]);
      return { available, reserved: Number(totals.reserved), spent: Number(totals.spent), spentThisMonth: Number(totals.spent_month), welcomeCredits: 100, expires: false };
    },
  };
}
export type PersonalCredits = ReturnType<typeof createPersonalCredits>;
