import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupMarketplaceDb, teardownMarketplaceDb, type MarketplaceHarness } from "./helpers/shared-agents-db";
import { createMarketplaceService } from "../plugins/shared-agents/server/service";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const CTX = { workflowId: 1, evalSetId: 1, region: "na-us-ashburn-01", createdBy: 3 };
// Minimal EvalJob-shaped stub — settle only reads id, status, snapshot.
function jobStub(id: number, status: string, settlementId: number | null) {
  return {
    id, status,
    snapshot: settlementId == null ? {} : { settlementContext: { settlementId } },
  } as any;
}

d("shared-agents settle", () => {
  let h: MarketplaceHarness;
  beforeAll(async () => { h = await setupMarketplaceDb(); });
  afterAll(async () => { await teardownMarketplaceDb(h); });

  async function dispatch(svc: ReturnType<typeof createMarketplaceService>, payer: number, tokenId: number) {
    const res = await svc.authorizeDispatch(payer, tokenId, CTX);
    return (res.settlementContext as { settlementId: number }).settlementId;
  }

  it("captures on completed: payer -charge, owner +earnerShare, platform +fee", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    await h.credits.deposit({ userId: 3, credits: 100, reason: "seed", idempotencyKey: "s5-3" });
    await svc.setListing(401, 10, { ownerId: 7, region: "na-us-ashburn-01" });
    const sid = await dispatch(svc, 3, 401);
    expect(await h.credits.getBalance(3)).toBe(90); // held

    await svc.settle(jobStub(9001, "completed", sid));
    expect(await h.credits.getBalance(3)).toBe(90); // stays debited (capture)
    expect(await h.credits.getBalance(7)).toBe(8);  // earnerShare = 10 - round(2) = 8
  });

  it("releases on failed: full refund to payer, owner unchanged", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    await svc.setListing(402, 10, { ownerId: 7, region: "na-us-ashburn-01" });
    const sid = await dispatch(svc, 3, 402);
    const ownerBefore = await h.credits.getBalance(7);

    await svc.settle(jobStub(9002, "failed", sid));
    expect(await h.credits.getBalance(3)).toBe(90); // was 90 after this hold too; refund restores the 10 held here
    expect(await h.credits.getBalance(7)).toBe(ownerBefore);
  });

  it("is idempotent: second settle is a no-op", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    await svc.setListing(403, 10, { ownerId: 7, region: "na-us-ashburn-01" });
    const sid = await dispatch(svc, 3, 403);
    await svc.settle(jobStub(9003, "completed", sid));
    const ownerAfterFirst = await h.credits.getBalance(7);
    await svc.settle(jobStub(9003, "completed", sid)); // repeat
    expect(await h.credits.getBalance(7)).toBe(ownerAfterFirst);
  });

  it("no settlementContext → no-op", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    await expect(svc.settle(jobStub(9004, "completed", null))).resolves.toBeUndefined();
  });
});
