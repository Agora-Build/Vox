import type { PluginDb } from "@vox/plugin-sdk";
import type { EvalJob } from "@shared/schema";
import type { AgentSummary, DispatchAuthorization, EvalMarketplace, JobContext } from "../../../server/marketplace";
import { computeCharge, computeFee, assertValidSplit } from "./pricing";
import * as repo from "./repo";

/** The slice of `vox.credits` this plugin depends on (duck-typed — no import from the credits package). */
export interface CreditsPort {
  hold(a: { payerUserId: number; credits: number; idempotencyKey: string; ref?: { type: string; id: string } }): Promise<{ holdId: number }>;
  capture(holdId: number, split: { earnerUserId: number; platformFeeCredits: number }): Promise<void>;
  release(holdId: number): Promise<void>;
}

export interface MarketplaceService extends EvalMarketplace {
  /** Backstop: release holds for settlements stuck `pending` past `ttlMs`. Returns count released. */
  reapLeaks(ttlMs: number, limit: number): Promise<number>;
  /** Health signal: settlements still `pending` past `ttlMs`. */
  countStuckPending(ttlMs: number): Promise<number>;
}

const PRICE_UNITS = 1; // Phase B: flat pricing.

export function createMarketplaceService(db: PluginDb, credits: CreditsPort): MarketplaceService {
  return {
    async setListing(tokenId, pricePerUnit, meta) {
      if (pricePerUnit == null) {
        await repo.deactivateListing(db, tokenId);
        return;
      }
      if (!meta) throw new Error("setListing: meta { ownerId, region } is required when activating a listing");
      await repo.upsertListing(db, {
        tokenId, pricePerUnit, ownerId: meta.ownerId, region: meta.region, createdBy: meta.ownerId,
      });
    },

    async listDispatchable(_userId): Promise<AgentSummary[]> {
      const rows = await repo.listActiveListings(db);
      return rows.map((l) => ({ tokenId: l.tokenId, region: l.region, pricePerUnit: l.pricePerUnit, ownerId: l.ownerId }));
    },

    async authorizeDispatch(userId, tokenId, _jobContext) {
      const listing = await repo.getListing(db, tokenId);
      if (!listing || !listing.active) return { ok: false, reason: "not-for-sale" };

      const charge = computeCharge(listing.pricePerUnit, PRICE_UNITS);
      const fee = computeFee(charge);
      assertValidSplit(charge, charge - fee, fee);

      // Mint our own settlement id first; it is the credits idempotencyKey (no jobId yet).
      const settlementId = await repo.insertPendingSettlement(db, {
        payerUserId: userId, earnerUserId: listing.ownerId,
        priceUnits: PRICE_UNITS, pricePerUnit: listing.pricePerUnit, chargeCredits: charge, feeCredits: fee,
      });

      try {
        const { holdId } = await credits.hold({
          payerUserId: userId, credits: charge, idempotencyKey: String(settlementId),
          ref: { type: "shared-agent-dispatch", id: String(settlementId) },
        });
        await repo.setSettlementHold(db, settlementId, holdId);
      } catch (err) {
        // Credits threw (insufficient balance). Void the pending settlement so it
        // can't leak or be picked up by the leak-reaper. No hold was placed.
        await db.withTransaction(async (tx) => {
          const s = await repo.getSettlementForUpdate(tx, settlementId);
          if (s && s.status === "pending") {
            await repo.markSettlementTerminal(tx, settlementId, "refunded", null, false, "insufficient-credits");
          }
        });
        return { ok: false, reason: "insufficient-credits" };
      }

      return { ok: true, settlementContext: { settlementId } };
    },

    async settle(_job: EvalJob): Promise<void> {
      throw new Error("not implemented"); // Task 5
    },

    async reapLeaks(_ttlMs: number, _limit: number): Promise<number> {
      throw new Error("not implemented"); // Task 6
    },

    async countStuckPending(ttlMs: number): Promise<number> {
      return repo.countStuckPending(db, ttlMs);
    },
  };
}

// Re-exported for Tasks 4–5 so their steps can reference the pricing invariant helpers without re-importing.
export { computeCharge, computeFee, assertValidSplit, PRICE_UNITS };
