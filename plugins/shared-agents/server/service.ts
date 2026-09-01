import type { PluginDb } from "@vox/plugin-sdk";
import { computeCharge, computeFee, assertValidSplit } from "./pricing";
import * as repo from "./repo";

/** The slice of `vox.credits` this plugin depends on (duck-typed — no import from the credits package). */
export interface CreditsPort {
  hold(a: { payerUserId: number; credits: number; idempotencyKey: string; ref?: { type: string; id: string } }): Promise<{ holdId: number }>;
  capture(holdId: number, split: { earnerUserId: number; platformFeeCredits: number }): Promise<void>;
  release(holdId: number): Promise<void>;
}

// Duck-typed mirrors of the Core marketplace seam (server/marketplace.ts). Defined
// locally so this plugin imports only @vox/plugin-sdk, never Core internals
// (Plugin/Core boundary — see eslint no-restricted-imports). Core casts the provided
// service to its own EvalMarketplace at the registry; structural shape is the contract.
export interface AgentSummary { tokenId: number; region: string; pricePerUnit: number; ownerId: number; }
export interface JobContext { workflowId: number | null; evalSetId: number | null; region: string; createdBy: number; }
export interface DispatchAuthorization { ok: boolean; reason?: string; settlementContext?: unknown; }
/** Money-relevant projection of a terminal job (mirrors Core's SettlementOutcome). */
export interface SettlementOutcome { jobId: number; status: string; hasResult: boolean; settlementContext: unknown; }

export interface MarketplaceService {
  setListing(tokenId: number, pricePerUnit: number | null, meta?: { ownerId: number; region: string }): Promise<void>;
  listDispatchable(userId: number): Promise<AgentSummary[]>;
  authorizeDispatch(userId: number, tokenId: number, jobContext: JobContext): Promise<DispatchAuthorization>;
  settle(outcome: SettlementOutcome): Promise<void>;
  voidDispatch(settlementContext: unknown): Promise<void>;
  /** Backstop: release holds for settlements stuck `pending` past `ttlMs`. Returns count released. */
  reapLeaks(ttlMs: number, limit: number): Promise<number>;
  /** Health signal: settlements still `pending` past `ttlMs` that hold escrow (hold_id set). */
  countStuckPending(ttlMs: number): Promise<number>;
  /** Mirrors Core's `EvalMarketplace.updateListingRegion` (see server/marketplace.ts). */
  updateListingRegion(tokenId: number, region: string | null): Promise<void>;
}

/**
 * True when a `credits.hold` rejection is the balance-too-low case. credits throws
 * `Error("insufficient credits")` BEFORE inserting any hold row, so this is the only
 * failure where we can be certain no escrow exists and it is safe to void the
 * pending settlement. Any other error may have committed a hold (review M5).
 */
function isInsufficientCredits(err: unknown): boolean {
  return /insufficient/i.test(String((err as { message?: unknown } | null)?.message ?? err));
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
        if (isInsufficientCredits(err)) {
          // Balance too low — credits threw BEFORE inserting any hold row, so no
          // escrow exists. Void the pending settlement so it can't leak or be picked
          // up by the leak-reaper.
          await db.withTransaction(async (tx) => {
            const s = await repo.getSettlementForUpdate(tx, settlementId);
            if (s && s.status === "pending") {
              await repo.markSettlementTerminal(tx, settlementId, "refunded", null, false, "insufficient-credits");
            }
          });
          return { ok: false, reason: "insufficient-credits" };
        }
        // Any OTHER failure (DB/connection error, reused idempotency key): the hold's
        // state is UNKNOWN — a hold row may have committed. Do NOT mark the settlement
        // refunded; a hold_id-null terminal row would orphan a possibly-live hold that
        // the leak-reaper (hold_id NOT NULL) can never reach. Leave it pending +
        // unmarked so credits' reconcile surfaces the orphaned hold. countStuckPending
        // ignores hold_id-null rows, so health won't flap on it (review M5).
        console.error(`[shared-agents] credits.hold failed for settlement ${settlementId}:`, err);
        return { ok: false, reason: "dispatch-failed" };
      }

      // The hold IS placed. A failure recording it must release the hold (holdId is
      // in scope) — otherwise escrow is stranded: the leak-reaper only scans pending
      // settlements WITH a hold_id, so it could never reach a refunded/null-hold row
      // (review I1). If the release ALSO fails, leave the settlement pending and
      // unmarked so credits' reconcile surfaces the orphaned hold rather than hiding
      // it behind a terminal row.
      try {
        await repo.setSettlementHold(db, settlementId, holdId);
      } catch {
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

    async settle(outcome) {
      const ctx = (outcome.settlementContext ?? null) as { settlementId?: number } | null;
      const settlementId = ctx?.settlementId;
      if (!settlementId) return; // free-tier / untargeted job — nothing to settle

      // settle is only meaningful for a terminal job. A non-terminal status here is
      // a caller bug; releasing/capturing on it would settle a job still in flight.
      // Guard explicitly rather than let the `else` branch treat anything ≠ completed
      // as a refund (review M3).
      if (outcome.status !== "completed" && outcome.status !== "failed") {
        console.error(`[shared-agents] settle ignored non-terminal job ${outcome.jobId} (status=${outcome.status})`);
        return;
      }

      // ARTIFACT GATE (review H1): capture the renter's escrow ONLY when the job
      // completed AND produced a real eval-result row. A `completed` job with no
      // result is a bare self-report by the rented agent's daemon (POST /complete
      // with no `results`) — the renter got no measurement, so refund, never pay.
      // A failed job also refunds. artifact_valid is derived from this gate, not
      // hardcoded.
      const captured = outcome.status === "completed" && outcome.hasResult === true;

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
          await repo.markSettlementTerminal(tx, settlementId, "settled", outcome.jobId, true, null);
        } else {
          const reason = outcome.status === "completed" ? "no-artifact" : `job-${outcome.status}`;
          await repo.markSettlementTerminal(tx, settlementId, "refunded", outcome.jobId, false, reason);
        }
      });
    },

    async voidDispatch(settlementContext) {
      const ctx = (settlementContext ?? null) as { settlementId?: number } | null;
      const settlementId = ctx?.settlementId;
      if (!settlementId) return; // nothing was authorized — nothing to void

      // Same lock discipline as settle/reapLeaks (review I2): read + guard under a
      // short lock, RELEASE it before the credits call, then finalize under a fresh
      // lock re-guarding on `pending`. Idempotent — a settlement already terminal
      // (settled/refunded) is a no-op.
      const s = await db.withTransaction(async (tx) => {
        const row = await repo.getSettlementForUpdate(tx, settlementId);
        if (!row || row.status !== "pending" || row.holdId == null) return null;
        return { holdId: row.holdId, jobId: row.jobId };
      });
      if (!s) return;

      await credits.release(s.holdId);

      await db.withTransaction(async (tx) => {
        const row = await repo.getSettlementForUpdate(tx, settlementId);
        if (!row || row.status !== "pending") return;
        await repo.markSettlementTerminal(tx, settlementId, "refunded", s.jobId, false, "dispatch-aborted");
      });
    },

    async reapLeaks(ttlMs, limit) {
      const ids = await repo.getLeakedSettlementIds(db, ttlMs, limit);
      let released = 0;
      for (const id of ids) {
        try {
          // Same lock discipline as settle (review I2/M6): read + guard under a
          // short lock, RELEASE it before the credits call (which grabs a second
          // pooled connection), then finalize under a fresh lock re-guarding on
          // `pending`. Keeps the reaper from holding a conn-A across credits while
          // concurrent settles contend for the same pool.
          const s = await db.withTransaction(async (tx) => {
            const row = await repo.getSettlementForUpdate(tx, id);
            if (!row || row.status !== "pending" || row.holdId == null) return null;
            return { holdId: row.holdId, jobId: row.jobId };
          });
          if (!s) continue; // finalized between select and lock — not released here (review M1)

          await credits.release(s.holdId);

          await db.withTransaction(async (tx) => {
            const row = await repo.getSettlementForUpdate(tx, id);
            if (!row || row.status !== "pending") return;
            await repo.markSettlementTerminal(tx, id, "refunded", row.jobId, false, "leaked-dispatch");
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

    async updateListingRegion(tokenId: number, region: string | null): Promise<void> {
      await repo.updateListingRegion(db, tokenId, region);
    },
  };
}

// Re-exported for Tasks 4–5 so their steps can reference the pricing invariant helpers without re-importing.
export { computeCharge, computeFee, assertValidSplit, PRICE_UNITS };
