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

      let holdId: number;
      try {
        ({ holdId } = await credits.hold({
          payerUserId: userId, credits: charge, idempotencyKey: String(settlementId),
          ref: { type: "shared-agent-dispatch", id: String(settlementId) },
        }));
      } catch (err) {
        // Credits threw (insufficient balance) — NO hold was placed. Void the
        // pending settlement so it can't leak or be picked up by the leak-reaper.
        await db.withTransaction(async (tx) => {
          const s = await repo.getSettlementForUpdate(tx, settlementId);
          if (s && s.status === "pending") {
            await repo.markSettlementTerminal(tx, settlementId, "refunded", null, false, "insufficient-credits");
          }
        });
        return { ok: false, reason: "insufficient-credits" };
      }

      // The hold IS placed. A failure recording it must release the hold (holdId is
      // in scope) — otherwise escrow is stranded: the leak-reaper only scans pending
      // settlements WITH a hold_id, so it could never reach a refunded/null-hold row
      // (review I1). If the release ALSO fails, leave the settlement pending and
      // unmarked so credits' reconcile surfaces the orphaned hold rather than hiding
      // it behind a terminal row.
      try {
        await repo.setSettlementHold(db, settlementId, holdId);
      } catch (err) {
        try {
          await credits.release(holdId);
        } catch (relErr) {
          console.error(`[shared-agents] failed to release hold ${holdId} after setSettlementHold error:`, relErr);
          return { ok: false, reason: "dispatch-failed" };
        }
        await db.withTransaction(async (tx) => {
          const s = await repo.getSettlementForUpdate(tx, settlementId);
          if (s && s.status === "pending") {
            await repo.markSettlementTerminal(tx, settlementId, "refunded", null, false, "hold-record-failed");
          }
        });
        return { ok: false, reason: "dispatch-failed" };
      }

      return { ok: true, settlementContext: { settlementId } };
    },

    async settle(job) {
      const ctx = (job.snapshot?.settlementContext ?? null) as { settlementId?: number } | null;
      const settlementId = ctx?.settlementId;
      if (!settlementId) return; // free-tier / untargeted job — nothing to settle

      // Read + guard under a short lock, then RELEASE the settlement lock BEFORE
      // touching credits. credits.capture/release open their own transaction on a
      // SECOND pooled connection; holding this FOR UPDATE across that call can
      // exhaust the shared pool under concurrent completions (both plugins share one
      // pool → deadlock, review I2). Both credits ops are idempotent by hold status
      // and Phase 3 re-guards on `pending`, so a concurrent or retried settle
      // converges to a single capture/release.
      const s = await db.withTransaction(async (tx) => {
        const row = await repo.getSettlementForUpdate(tx, settlementId);
        if (!row || row.status !== "pending" || row.holdId == null) return null; // idempotent / unknown / no hold
        return { holdId: row.holdId, earnerUserId: row.earnerUserId, feeCredits: row.feeCredits };
      });
      if (!s) return;

      const captured = job.status === "completed";
      if (captured) {
        await credits.capture(s.holdId, { earnerUserId: s.earnerUserId, platformFeeCredits: s.feeCredits });
      } else {
        await credits.release(s.holdId);
      }

      // Finalize under a fresh short lock, re-guarding for idempotency: a concurrent
      // settle may have already finalized this settlement (its credits op was the
      // same idempotent capture/release), in which case this is a no-op.
      await db.withTransaction(async (tx) => {
        const row = await repo.getSettlementForUpdate(tx, settlementId);
        if (!row || row.status !== "pending") return;
        if (captured) {
          await repo.markSettlementTerminal(tx, settlementId, "settled", job.id, true, null);
        } else {
          await repo.markSettlementTerminal(tx, settlementId, "refunded", job.id, false, `job-${job.status}`);
        }
      });
    },

    async reapLeaks(ttlMs, limit) {
      const ids = await repo.getLeakedSettlementIds(db, ttlMs, limit);
      let released = 0;
      for (const id of ids) {
        try {
          await db.withTransaction(async (tx) => {
            const s = await repo.getSettlementForUpdate(tx, id);
            if (!s || s.status !== "pending" || s.holdId == null) return;
            await credits.release(s.holdId);
            await repo.markSettlementTerminal(tx, id, "refunded", s.jobId, false, "leaked-dispatch");
          });
          released++;
        } catch (err) {
          // A hold already captured (rare unmarked-completed race) throws here;
          // leave it pending + log so health surfaces it. Never abort the sweep.
          console.error(`[shared-agents] leak-reaper failed for settlement ${id}:`, err);
        }
      }
      return released;
    },

    async countStuckPending(ttlMs: number): Promise<number> {
      return repo.countStuckPending(db, ttlMs);
    },
  };
}

// Re-exported for Tasks 4–5 so their steps can reference the pricing invariant helpers without re-importing.
export { computeCharge, computeFee, assertValidSplit, PRICE_UNITS };
