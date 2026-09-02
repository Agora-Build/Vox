import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { storage, db, hashToken } from "../server/storage";
import { evalAgents, evalAgentTokens, regionLocations } from "../shared/schema";
import { resolveCatalogRegion, runAgentLocationCheck } from "../server/location";
import { setMarketplace, getMarketplace, type EvalMarketplace } from "../server/marketplace";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("catalog resolution", () => {
  afterAll(async () => {
    await db.delete(regionLocations).where(like(regionLocations.baseId, "zz-%"));
  });

  it("findNearestActiveRegion matches within 100km (Sunnyvale → Santa Clara/Seattle rule)", async () => {
    // Seeded Seattle row has coords from migration 0035.
    const near = await storage.findNearestActiveRegion(47.61, -122.20, 100); // ~10km east of Seattle
    expect(near?.baseId).toBe("na-us-seattle");
    const far = await storage.findNearestActiveRegion(64.14, -21.94, 100); // Reykjavik
    expect(far).toBeUndefined();
  });

  it("resolveCatalogRegion reuses a near row; auto-creates source='detected' otherwise", async () => {
    const nearSeattle = await resolveCatalogRegion({
      baseId: "na-us-bellevue", displayName: "Bellevue", city: "Bellevue",
      countryCode: "US", countryName: "United States",
      macroRegionCode: "na", macroRegionName: "North America",
      latitude: 47.61, longitude: -122.20,
    });
    expect(nearSeattle).toBe("na-us-seattle");

    const created = await resolveCatalogRegion({
      baseId: "zz-is-reykjavik", displayName: "Reykjavik", city: "Reykjavik",
      countryCode: "IS", countryName: "Iceland",
      macroRegionCode: "eu", macroRegionName: "Europe",
      latitude: 64.14, longitude: -21.94,
    });
    expect(created).toBe("zz-is-reykjavik");
    const row = await storage.getRegionLocationByBaseId("zz-is-reykjavik");
    expect(row?.source).toBe("detected");
    expect(row?.isMainline).toBe(false);
    // Idempotent on second call (unique base_id, 23505 → re-select).
    expect(await resolveCatalogRegion({
      baseId: "zz-is-reykjavik", displayName: "Reykjavik", city: "Reykjavik",
      countryCode: "IS", countryName: "Iceland",
      macroRegionCode: "eu", macroRegionName: "Europe",
      latitude: 64.14, longitude: -21.94,
    })).toBe("zz-is-reykjavik");
  });
});

describeDb("allocateSiteId + runAgentLocationCheck", () => {
  let tokenId: number;
  let agentId: number;

  beforeAll(async () => {
    const inserted = await db.insert(evalAgentTokens).values({
      name: "zt-loc-test", tokenHash: hashToken(`zt-loc-${Date.now()}`),
      dispatchTier: "private", createdBy: 1, isRevoked: false,
      siteId: null, region: null,
    }).returning();
    tokenId = inserted[0].id;
    const agent = await db.insert(evalAgents).values({
      name: "zt-loc-agent", tokenId, siteId: null, state: "idle",
    }).returning();
    agentId = agent[0].id;
  });
  afterAll(async () => {
    await db.delete(evalAgents).where(eq(evalAgents.id, agentId));
    await db.delete(evalAgentTokens).where(eq(evalAgentTokens.id, tokenId));
  });

  it("allocateSiteId hands out sequential ids and bumps next_sequence", async () => {
    const before = await storage.getRegionLocationByBaseId("eu-de-frankfurt");
    const siteId = await storage.allocateSiteId("eu-de-frankfurt");
    expect(siteId).toBe(`eu-de-frankfurt-${String(before!.nextSequence).padStart(2, "0")}`);
    const after = await storage.getRegionLocationByBaseId("eu-de-frankfurt");
    expect(after!.nextSequence).toBe(before!.nextSequence + 1);
  });

  it("runAgentLocationCheck immediate-assigns for a private agent (stub deps unavailable → uses stored detection path)", async () => {
    // No mmdbs in dev: a public IP classifies low_confidence/unknown → stays Unverified.
    const res = await runAgentLocationCheck({
      agent: { id: agentId, region: null, siteId: null, pendingRegion: null, pendingRegionCount: 0 },
      token: { id: tokenId, dispatchTier: "private" },
      ip: "8.8.8.8", immediate: true,
    });
    expect(res.region).toBeNull();
    expect(res.siteId).toBeNull();
    expect(["low_confidence", "unknown"]).toContain(res.locationTrust);
    const row = (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];
    expect(row.locationTrust).toBe(res.locationTrust);
    expect(row.locationCheckedAt).not.toBeNull();
  });

  it("public tier: observability only — region/siteId untouched", async () => {
    await db.update(evalAgents).set({ siteId: "na-us-seattle-01" }).where(eq(evalAgents.id, agentId));
    const res = await runAgentLocationCheck({
      agent: { id: agentId, region: null, siteId: "na-us-seattle-01", pendingRegion: null, pendingRegionCount: 0 },
      token: { id: tokenId, dispatchTier: "public" },
      ip: "8.8.8.8", immediate: true,
    });
    expect(res.siteId).toBe("na-us-seattle-01"); // identity preserved
    const row = (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];
    expect(row.siteId).toBe("na-us-seattle-01");
  });

  it("shared tier: marketplace lacking updateListingRegion does not throw (warns instead)", async () => {
    // Plugin/Core boundary is duck-typed (server/index.ts casts the registered
    // service unchecked) — a marketplace build without this method must never
    // 500 Core. Force `next.changed = true` via the "distrust fast" hysteresis
    // branch (agent starts with a non-null region; no mmdb in dev → low_confidence
    // / unknown, ineligible → region clears) rather than relying on a real geo hit.
    const laggingMarketplace = {
      async listDispatchable() { return []; },
      async authorizeDispatch() { return { ok: true as const }; },
      async settle() {},
      async setListing() {},
      // updateListingRegion intentionally omitted
    } as unknown as EvalMarketplace;
    setMarketplace(laggingMarketplace);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await runAgentLocationCheck({
        agent: { id: agentId, region: "na-us-seattle", siteId: "na-us-seattle-01", pendingRegion: null, pendingRegionCount: 0 },
        token: { id: tokenId, dispatchTier: "shared" },
        ip: "8.8.8.8", immediate: true,
      });
      expect(res.region).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`marketplace plugin lacks updateListingRegion — listing region not refreshed for token ${tokenId}`),
      );
      expect(getMarketplace()).toBe(laggingMarketplace);
    } finally {
      warnSpy.mockRestore();
      setMarketplace(null);
    }
  });
});
