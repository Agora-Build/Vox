import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupMarketplaceDb, teardownMarketplaceDb, type MarketplaceHarness } from "./helpers/shared-agents-db";
import { createMarketplaceService } from "../plugins/shared-agents/server/service";
import * as repo from "../plugins/shared-agents/server/repo";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const JOB_CTX = { workflowId: 1, evalSetId: 1, region: "na-us-ashburn-01", createdBy: 3 };

d("shared-agents authorizeDispatch", () => {
  let h: MarketplaceHarness;
  beforeAll(async () => { h = await setupMarketplaceDb(); });
  afterAll(async () => { await teardownMarketplaceDb(h); });

  it("not-for-sale when no active listing", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    const res = await svc.authorizeDispatch(3, 555, JOB_CTX);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("not-for-sale");
  });

  it("places a hold on a valid active listing and returns settlementId", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    await h.credits.deposit({ userId: 3, credits: 100, reason: "test-seed", idempotencyKey: "seed-3" });
    await svc.setListing(301, 10, { ownerId: 7, region: "na-us-ashburn-01" });

    const res = await svc.authorizeDispatch(3, 301, JOB_CTX);
    expect(res.ok).toBe(true);
    const settlementId = (res.settlementContext as { settlementId: number }).settlementId;
    expect(settlementId).toBeGreaterThan(0);

    // Renter debited by charge (10); escrow holds it.
    expect(await h.credits.getBalance(3)).toBe(90);
    // Settlement is pending with a hold attached.
    await h.marketplaceDb.withTransaction(async (tx) => {
      const s = await repo.getSettlementForUpdate(tx, settlementId);
      expect(s!.status).toBe("pending");
      expect(s!.holdId).not.toBeNull();
      expect(s!.chargeCredits).toBe(10);
      expect(s!.feeCredits).toBe(2); // round(10*0.2)
      expect(s!.earnerUserId).toBe(7);
    });
  });

  it("insufficient-credits leaves no leaked hold and no pending settlement", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    await svc.setListing(302, 1000, { ownerId: 7, region: "na-us-ashburn-01" });
    const before = await h.credits.getBalance(3);
    const stuckBefore = await svc.countStuckPending(0);

    const res = await svc.authorizeDispatch(3, 302, JOB_CTX);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("insufficient-credits");
    expect(await h.credits.getBalance(3)).toBe(before); // untouched
    expect(await svc.countStuckPending(0)).toBe(stuckBefore); // insufficient path added no pending settlement
  });
});
