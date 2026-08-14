import type { PluginDb } from "@vox/plugin-sdk";
import { assertPositiveCredits, validateSplit } from "./split";
import * as repo from "./repo";
import { encodeCursor, decodeCursor } from "./cursor";

export type Ref = { type: string; id: string };

export interface LedgerEntry {
  id: number;
  amount: number;
  reason: string;
  groupId: string;
  refType: string | null;
  refId: string | null;
  createdAt: string;
}

export interface CreditsService {
  getBalance(userId: number): Promise<number>;
  deposit(a: { userId: number; credits: number; reason: string; ref?: Ref; idempotencyKey: string }): Promise<{ groupId: string }>;
  hold(a: { payerUserId: number; credits: number; idempotencyKey: string; ref?: Ref }): Promise<{ holdId: number }>;
  capture(holdId: number, split: { earnerUserId: number; platformFeeCredits: number }): Promise<void>;
  release(holdId: number): Promise<void>;
  getStatement(userId: number, opts?: { limit?: number; cursor?: string }): Promise<{ entries: LedgerEntry[]; nextCursor: string | null }>;
}

export function createCreditsService(db: PluginDb): CreditsService {
  return {
    async getBalance(userId) {
      return repo.getUserBalance(db, userId);
    },

    async deposit({ userId, credits, reason, ref, idempotencyKey }) {
      assertPositiveCredits(credits);
      return db.withTransaction(async (tx) => {
        const claim = await repo.claimIdempotency(tx, idempotencyKey, "deposit");
        if (!claim.fresh) return claim.result as { groupId: string };

        const groupId = repo.newGroupId();
        const userAcct = await repo.getOrCreateUserAccount(tx, userId);
        const externalAcct = await repo.systemAccountId(tx, "external");
        const refType = ref?.type ?? null;
        const refId = ref?.id ?? null;
        await repo.applyLeg(tx, { accountId: userAcct, amount: credits, reason, groupId, refType, refId });
        await repo.applyLeg(tx, { accountId: externalAcct, amount: -credits, reason, groupId, refType, refId });

        const result = { groupId };
        await repo.finalizeIdempotency(tx, idempotencyKey, groupId, result);
        return result;
      });
    },

    async hold({ payerUserId, credits, idempotencyKey, ref }) {
      assertPositiveCredits(credits);
      return db.withTransaction(async (tx) => {
        const claim = await repo.claimIdempotency(tx, idempotencyKey, "hold");
        if (!claim.fresh) return claim.result as { holdId: number };

        const payerAcct = await repo.getOrCreateUserAccount(tx, payerUserId);
        const balance = await repo.lockUserBalance(tx, payerAcct); // FOR UPDATE
        if (balance < credits) throw new Error("insufficient credits");

        const escrowAcct = await repo.systemAccountId(tx, "escrow");
        const groupId = repo.newGroupId();
        const refType = ref?.type ?? null;
        const refId = ref?.id ?? null;
        await repo.applyLeg(tx, { accountId: payerAcct, amount: -credits, reason: "hold", groupId, refType, refId });
        await repo.applyLeg(tx, { accountId: escrowAcct, amount: credits, reason: "hold", groupId, refType, refId });
        const holdId = await repo.insertHold(tx, { payerAccountId: payerAcct, amount: credits, holdGroupId: groupId, refType, refId });

        const result = { holdId };
        await repo.finalizeIdempotency(tx, idempotencyKey, groupId, result);
        return result;
      });
    },

    async capture(holdId, split) {
      await db.withTransaction(async (tx) => {
        const hold = await repo.getHoldForUpdate(tx, holdId);
        if (!hold) throw new Error(`hold not found: ${holdId}`);
        if (hold.status === "captured") return; // idempotent
        if (hold.status === "released") throw new Error(`hold already released: ${holdId}`);

        validateSplit(hold.amount, { earnerShare: hold.amount - split.platformFeeCredits, platformFeeCredits: split.platformFeeCredits });
        const earnerShare = hold.amount - split.platformFeeCredits;

        const escrowAcct = await repo.systemAccountId(tx, "escrow");
        const platformAcct = await repo.systemAccountId(tx, "platform");
        const earnerAcct = await repo.getOrCreateUserAccount(tx, split.earnerUserId);
        const groupId = repo.newGroupId();
        const refType = hold.refType;
        const refId = hold.refId;
        await repo.applyLeg(tx, { accountId: escrowAcct, amount: -hold.amount, reason: "capture", groupId, refType, refId });
        await repo.applyLeg(tx, { accountId: earnerAcct, amount: earnerShare, reason: "capture", groupId, refType, refId });
        if (split.platformFeeCredits > 0) {
          await repo.applyLeg(tx, { accountId: platformAcct, amount: split.platformFeeCredits, reason: "fee", groupId, refType, refId });
        }
        await repo.markHoldSettled(tx, holdId, "captured", groupId);
      });
    },

    async release(holdId) {
      await db.withTransaction(async (tx) => {
        const hold = await repo.getHoldForUpdate(tx, holdId);
        if (!hold) throw new Error(`hold not found: ${holdId}`);
        if (hold.status === "released") return; // idempotent
        if (hold.status === "captured") throw new Error(`hold already captured: ${holdId}`);

        const escrowAcct = await repo.systemAccountId(tx, "escrow");
        const groupId = repo.newGroupId();
        await repo.applyLeg(tx, { accountId: escrowAcct, amount: -hold.amount, reason: "release", groupId, refType: hold.refType, refId: hold.refId });
        await repo.applyLeg(tx, { accountId: hold.payerAccountId, amount: hold.amount, reason: "release", groupId, refType: hold.refType, refId: hold.refId });
        await repo.markHoldSettled(tx, holdId, "released", groupId);
      });
    },

    async getStatement(userId, opts) {
      const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
      const beforeId = decodeCursor(opts?.cursor);
      const rows = await repo.listEntries(db, userId, limit, beforeId);
      const entries: LedgerEntry[] = rows.map((r) => ({
        id: Number(r.id), amount: Number(r.amount), reason: r.reason, groupId: r.group_id,
        refType: r.ref_type, refId: r.ref_id, createdAt: r.created_at,
      }));
      const nextCursor = entries.length === limit ? encodeCursor(entries[entries.length - 1].id) : null;
      return { entries, nextCursor };
    },
  };
}
