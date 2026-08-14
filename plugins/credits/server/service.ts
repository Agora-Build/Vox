import type { PluginDb } from "@vox/plugin-sdk";
import { assertPositiveCredits } from "./split";
import * as repo from "./repo";

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

    async capture() { throw new Error("not implemented"); },
    async release() { throw new Error("not implemented"); },
    async getStatement() { throw new Error("not implemented"); },
  };
}
