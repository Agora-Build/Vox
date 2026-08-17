import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupMarketplaceDb, teardownMarketplaceDb, type MarketplaceHarness } from "./helpers/shared-agents-db";
import { createMarketplaceService } from "../plugins/shared-agents/server/service";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const CTX = { workflowId: 1, evalSetId: 1, region: "na-us-ashburn-01", createdBy: 3 };
// SettlementOutcome stub — settle reads jobId, status, hasResult, settlementContext.
// hasResult defaults true (the normal path: a completed job wrote a result row);
// the H1 test overrides it to prove a resultless completion refunds.
function outcomeStub(jobId: number, status: string, settlementId: number | null, hasResult = true) {
  return {
    jobId, status, hasResult,
    settlementContext: settlementId == null ? undefined : { settlementId },
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

    await svc.settle(outcomeStub(9001, "completed", sid));
    expect(await h.credits.getBalance(3)).toBe(90); // stays debited (capture)
    expect(await h.credits.getBalance(7)).toBe(8);  // earnerShare = 10 - round(2) = 8
  });

  it("releases on failed: full refund to payer, owner unchanged", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    await svc.setListing(402, 10, { ownerId: 7, region: "na-us-ashburn-01" });
    const sid = await dispatch(svc, 3, 402);
    const ownerBefore = await h.credits.getBalance(7);

    await svc.settle(outcomeStub(9002, "failed", sid));
    expect(await h.credits.getBalance(3)).toBe(90); // was 90 after this hold too; refund restores the 10 held here
    expect(await h.credits.getBalance(7)).toBe(ownerBefore);
  });

  it("is idempotent: second settle is a no-op", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    await svc.setListing(403, 10, { ownerId: 7, region: "na-us-ashburn-01" });
    const sid = await dispatch(svc, 3, 403);
    await svc.settle(outcomeStub(9003, "completed", sid));
    const ownerAfterFirst = await h.credits.getBalance(7);
    await svc.settle(outcomeStub(9003, "completed", sid)); // repeat
    expect(await h.credits.getBalance(7)).toBe(ownerAfterFirst);
  });

  it("no settlementContext → no-op", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    await expect(svc.settle(outcomeStub(9004, "completed", null))).resolves.toBeUndefined();
  });

  it("ignores a non-terminal job, but still settles once terminal (M3)", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    await svc.setListing(405, 10, { ownerId: 7, region: "na-us-ashburn-01" });
    const sid = await dispatch(svc, 3, 405);
    const payerHeld = await h.credits.getBalance(3);
    const ownerBefore = await h.credits.getBalance(7);

    // A non-terminal status must be a no-op — no release, settlement stays pending.
    await svc.settle(outcomeStub(9006, "running", sid));
    expect(await h.credits.getBalance(3)).toBe(payerHeld);   // not refunded
    expect(await h.credits.getBalance(7)).toBe(ownerBefore); // not captured

    // The surviving pending settlement still captures correctly once terminal.
    await svc.settle(outcomeStub(9006, "completed", sid));
    expect(await h.credits.getBalance(7)).toBe(ownerBefore + 8);
  });

  it("refunds a completed job with NO result row — never pays on a bare self-report (H1)", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    await svc.setListing(406, 10, { ownerId: 7, region: "na-us-ashburn-01" });
    const sid = await dispatch(svc, 3, 406);
    const payerHeld = await h.credits.getBalance(3);
    const ownerBefore = await h.credits.getBalance(7);

    // completed but hasResult=false → the artifact gate blocks capture; escrow refunds.
    await svc.settle(outcomeStub(9007, "completed", sid, false));
    expect(await h.credits.getBalance(3)).toBe(payerHeld + 10); // 10 held is refunded
    expect(await h.credits.getBalance(7)).toBe(ownerBefore);    // owner NOT paid
  });

  it("voidDispatch releases the hold for an authorized-but-never-created job, idempotently (M4)", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    await svc.setListing(408, 10, { ownerId: 7, region: "na-us-ashburn-01" });
    const res = await svc.authorizeDispatch(3, 408, CTX);
    const afterHold = await h.credits.getBalance(3);

    await svc.voidDispatch(res.settlementContext);
    expect(await h.credits.getBalance(3)).toBe(afterHold + 10); // hold released

    await svc.voidDispatch(res.settlementContext); // second void is a no-op
    expect(await h.credits.getBalance(3)).toBe(afterHold + 10);
  });

  it("concurrent settle(completed) converges to a single capture", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    await svc.setListing(404, 10, { ownerId: 7, region: "na-us-ashburn-01" });
    const sid = await dispatch(svc, 3, 404);
    const ownerBefore = await h.credits.getBalance(7);

    const job = outcomeStub(9005, "completed", sid);
    await Promise.all([svc.settle(job), svc.settle(job)]); // two racers, one settlement

    expect(await h.credits.getBalance(7)).toBe(ownerBefore + 8); // earnerShare credited ONCE (10 - round(2))
  });
});
