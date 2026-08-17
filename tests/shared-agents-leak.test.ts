import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupMarketplaceDb, teardownMarketplaceDb, type MarketplaceHarness } from "./helpers/shared-agents-db";
import { createMarketplaceService } from "../plugins/shared-agents/server/service";
import * as repo from "../plugins/shared-agents/server/repo";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const CTX = { workflowId: 1, evalSetId: 1, region: "na-us-ashburn-01", createdBy: 3 };

d("shared-agents leak-reaper", () => {
  let h: MarketplaceHarness;
  beforeAll(async () => { h = await setupMarketplaceDb(); });
  afterAll(async () => { await teardownMarketplaceDb(h); });

  it("releases a stale pending settlement and leaves a fresh one untouched", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    await h.credits.deposit({ userId: 3, credits: 100, reason: "seed", idempotencyKey: "leak-3" });
    await svc.setListing(601, 10, { ownerId: 7, region: "na-us-ashburn-01" });
    await svc.authorizeDispatch(3, 601, CTX); // one pending settlement, hold placed, balance 90
    expect(await h.credits.getBalance(3)).toBe(90);

    // ttl=0 → the just-created pending settlement is "stale"; reap releases it.
    const released = await svc.reapLeaks(0, 100);
    expect(released).toBe(1);
    expect(await h.credits.getBalance(3)).toBe(100); // refunded

    // Second sweep: nothing left pending → releases 0.
    expect(await svc.reapLeaks(0, 100)).toBe(0);

    // A fresh pending settlement is NOT reaped under a long TTL.
    await svc.authorizeDispatch(3, 601, CTX);
    expect(await svc.reapLeaks(60_000, 100)).toBe(0);
    expect(await h.credits.getBalance(3)).toBe(90);
  });

  it("countStuckPending ignores orphan pending rows with no hold placed (M2)", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    const before = await svc.countStuckPending(0);

    // Simulate a crash between insert and hold: a pending settlement, hold_id NULL.
    // No escrow exists for it, and the leak-reaper (hold_id NOT NULL) never touches
    // it — so the health signal must not count it, or health flaps `degraded` forever.
    await repo.insertPendingSettlement(h.marketplaceDb, {
      payerUserId: 3, earnerUserId: 7, priceUnits: 1, pricePerUnit: 10, chargeCredits: 10, feeCredits: 2,
    });

    expect(await svc.countStuckPending(0)).toBe(before); // orphan not counted
  });
});
