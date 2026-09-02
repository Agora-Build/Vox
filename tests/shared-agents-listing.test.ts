import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupMarketplaceDb, teardownMarketplaceDb, type MarketplaceHarness } from "./helpers/shared-agents-db";
import * as repo from "../plugins/shared-agents/server/repo";
import { createMarketplaceService } from "../plugins/shared-agents/server/service";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("shared-agents listings repo", () => {
  let h: MarketplaceHarness;
  beforeAll(async () => { h = await setupMarketplaceDb(); });
  afterAll(async () => { await teardownMarketplaceDb(h); });

  it("upsert activates a listing; re-upsert updates price; deactivate flips active", async () => {
    await repo.upsertListing(h.marketplaceDb, { tokenId: 101, pricePerUnit: 10, ownerId: 7, region: "na-us-ashburn-01", createdBy: 7 });
    let row = await repo.getListing(h.marketplaceDb, 101);
    expect(row).not.toBeNull();
    expect(row!.pricePerUnit).toBe(10);
    expect(row!.ownerId).toBe(7);
    expect(row!.active).toBe(true);

    await repo.upsertListing(h.marketplaceDb, { tokenId: 101, pricePerUnit: 25, ownerId: 7, region: "na-us-ashburn-01", createdBy: 7 });
    row = await repo.getListing(h.marketplaceDb, 101);
    expect(row!.pricePerUnit).toBe(25);

    const active = await repo.listActiveListings(h.marketplaceDb);
    expect(active.some((l) => l.tokenId === 101)).toBe(true);

    await repo.deactivateListing(h.marketplaceDb, 101);
    row = await repo.getListing(h.marketplaceDb, 101);
    expect(row!.active).toBe(false);
    const activeAfter = await repo.listActiveListings(h.marketplaceDb);
    expect(activeAfter.some((l) => l.tokenId === 101)).toBe(false);
  });

  it("updateListingRegion updates an existing listing's region; no-ops when no listing exists", async () => {
    await repo.upsertListing(h.marketplaceDb, { tokenId: 111, pricePerUnit: 10, ownerId: 7, region: "na-us-ashburn-01", createdBy: 7 });
    await repo.updateListingRegion(h.marketplaceDb, 111, "eu-de-frankfurt-01");
    let row = await repo.getListing(h.marketplaceDb, 111);
    expect(row!.region).toBe("eu-de-frankfurt-01");
    expect(row!.active).toBe(true);

    // region text NOT NULL: a null region delists (mirrors setListing(id, null)).
    await repo.updateListingRegion(h.marketplaceDb, 111, null);
    row = await repo.getListing(h.marketplaceDb, 111);
    expect(row!.active).toBe(false);
    let activeNow = await repo.listActiveListings(h.marketplaceDb);
    expect(activeNow.some((l) => l.tokenId === 111)).toBe(false);

    // Regaining a trusted region must self-heal the listing back to active —
    // runAgentLocationCheck never calls setListing, so this is the only path back.
    await repo.updateListingRegion(h.marketplaceDb, 111, "apac-in-mumbai-01");
    row = await repo.getListing(h.marketplaceDb, 111);
    expect(row!.active).toBe(true);
    expect(row!.region).toBe("apac-in-mumbai-01");
    activeNow = await repo.listActiveListings(h.marketplaceDb);
    expect(activeNow.some((l) => l.tokenId === 111)).toBe(true);

    // No listing for this token: no-op, does not throw, does not create a row.
    await expect(repo.updateListingRegion(h.marketplaceDb, 999999, "na-us-ashburn-01")).resolves.toBeUndefined();
    expect(await repo.getListing(h.marketplaceDb, 999999)).toBeNull();
  });

  it("pending settlement round-trips and job_id backfills terminal", async () => {
    const sid = await repo.insertPendingSettlement(h.marketplaceDb, {
      payerUserId: 3, earnerUserId: 7, priceUnits: 1, pricePerUnit: 25, chargeCredits: 25, feeCredits: 5,
    });
    expect(sid).toBeGreaterThan(0);
    await repo.setSettlementHold(h.marketplaceDb, sid, 999);

    await h.marketplaceDb.withTransaction(async (tx) => {
      const s = await repo.getSettlementForUpdate(tx, sid);
      expect(s!.status).toBe("pending");
      expect(s!.holdId).toBe(999);
      await repo.markSettlementTerminal(tx, sid, "settled", 4242, true, null);
    });
    await h.marketplaceDb.withTransaction(async (tx) => {
      const s = await repo.getSettlementForUpdate(tx, sid);
      expect(s!.status).toBe("settled");
      expect(s!.jobId).toBe(4242);
    });
  });
});

d("shared-agents service — setListing/listDispatchable", () => {
  let h: MarketplaceHarness;
  beforeAll(async () => { h = await setupMarketplaceDb(); });
  afterAll(async () => { await teardownMarketplaceDb(h); });

  it("setListing activate then listDispatchable returns the AgentSummary", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    await svc.setListing(202, 15, { ownerId: 9, region: "eu-de-frankfurt-01" });
    const list = await svc.listDispatchable(1);
    const row = list.find((a) => a.tokenId === 202);
    expect(row).toBeDefined();
    expect(row!.pricePerUnit).toBe(15);
    expect(row!.ownerId).toBe(9);
    expect(row!.region).toBe("eu-de-frankfurt-01");
  });

  it("setListing deactivate removes it from listDispatchable", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    await svc.setListing(202, null);
    const list = await svc.listDispatchable(1);
    expect(list.some((a) => a.tokenId === 202)).toBe(false);
  });

  it("activate without meta throws (Core always supplies it)", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    await expect(svc.setListing(203, 5)).rejects.toThrow();
  });

  it("updateListingRegion delegates through the service to repo", async () => {
    const svc = createMarketplaceService(h.marketplaceDb, h.credits as any);
    await svc.setListing(204, 12, { ownerId: 9, region: "na-us-ashburn-01" });
    await svc.updateListingRegion(204, "apac-in-mumbai-01");
    const list = await svc.listDispatchable(1);
    const row = list.find((a) => a.tokenId === 204);
    expect(row!.region).toBe("apac-in-mumbai-01");
  });
});
