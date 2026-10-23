import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { storage, db, hashToken } from "../server/storage";
import { evalAgents, evalAgentTokens, regionLocations } from "../shared/schema";
import { resolveCatalogRegion, runAgentLocationCheck, type DetectionDeps, type GeoLookup } from "../server/location";
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

const noAccessSignals = { dcRange: false, peeringdbType: undefined, eyeballShare: undefined, isMobile: false };
// Access data loaded, but no geo for any IP → low_confidence (ineligible).
const loadedNoGeo: DetectionDeps = {
  geo: () => null, asn: () => null, torExits: new Set(),
  networkClass: () => null, networkClassLoaded: true,
  accessSignals: () => noAccessSignals,
};
const geoFrankfurt: GeoLookup = {
  city: "Frankfurt am Main", countryCode: "DE", countryName: "Germany", continentCode: "EU",
  lat: 50.11, lon: 8.68, accuracyKm: 20,
};
// VPN/datacenter data never loaded (first boot / every download failed) —
// with real geo that would otherwise read "trusted".
const unloadedWithGeo: DetectionDeps = {
  geo: () => geoFrankfurt, asn: () => ({ asn: 3320, org: "Deutsche Telekom" }), torExits: new Set(),
  networkClass: () => null, networkClassLoaded: false,
  accessSignals: () => noAccessSignals,
};

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
    // Own region-location row, not the shared eu-de-frankfurt base (review fix
    // round 1): eu-de-frankfurt's next_sequence is bumped by other tests/files
    // running concurrently, so a before/after read of it here raced them too
    // (same root cause as the "no renumber" test below). A dedicated,
    // uniquely-named row no other test touches makes the sequence/bump
    // assertion self-contained.
    const [seqRow] = await db.insert(regionLocations).values({
      baseId: `zz-loc-seq-${Date.now()}`, displayName: "Seq Test", city: "Seq Test",
      countryCode: "ZZ", countryName: "Seq Test", macroRegionCode: "zz", macroRegionName: "Seq Test",
      latitude: 0, longitude: 0,
    }).returning();
    try {
      const first = await storage.allocateSiteId(seqRow.baseId);
      expect(first).toBe(`${seqRow.baseId}-01`);
      const second = await storage.allocateSiteId(seqRow.baseId);
      expect(second).toBe(`${seqRow.baseId}-02`);
    } finally {
      await db.delete(regionLocations).where(eq(regionLocations.id, seqRow.id));
    }
  });

  it("runAgentLocationCheck immediate-assigns for a private agent (stub deps unavailable → uses stored detection path)", async () => {
    // No mmdbs in dev: a public IP classifies low_confidence/unknown → stays Unverified.
    const before = (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];
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
    // The test process has no VPN/datacenter data loaded, so access is
    // "no-data" — no answer: the check time is left for the next beat.
    expect(row.locationCheckedAt?.getTime()).toBe(before.locationCheckedAt?.getTime());
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
        deps: loadedNoGeo,
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

  it("unloaded access data: an existing agent's region, siteId, pending state, trust, access and check time are all kept", async () => {
    const checkedAt = new Date(Date.now() - 3 * 60 * 60 * 1000); // stale: the next beat re-checks
    await db.update(evalAgents).set({
      region: "eu-de-frankfurt", siteId: "eu-de-frankfurt-07", pendingRegion: "eu-fr-paris", pendingRegionCount: 2,
      locationTrust: "trusted", locationCheckedAt: checkedAt,
      accessClass: "lastmile", accessReason: "v1: eyeball-asn + residential-rdns", accessCheckedAt: checkedAt,
    }).where(eq(evalAgents.id, agentId));
    // Spy, not the global eu-de-frankfurt next_sequence counter (review fix
    // round 1): that counter is shared across every test file that allocates
    // a site id there, and the full suite runs files in parallel — reading
    // before/after it here raced location-access.test.ts and
    // net-signals-core.test.ts allocating from the same base concurrently,
    // failing intermittently though nothing here is actually wrong.
    // "No renumber" instead asserts directly on the thing that would move
    // the counter: allocateSiteId must never be called.
    const allocateSpy = vi.spyOn(storage, "allocateSiteId");
    try {
      for (const immediate of [true, false]) {
        const res = await runAgentLocationCheck({
          agent: { id: agentId, region: "eu-de-frankfurt", siteId: "eu-de-frankfurt-07", pendingRegion: "eu-fr-paris", pendingRegionCount: 2, locationTrust: "trusted" },
          token: { id: tokenId, dispatchTier: "private" },
          ip: "80.150.1.1", immediate, deps: unloadedWithGeo,
        });
        expect(res).toEqual({ region: "eu-de-frankfurt", siteId: "eu-de-frankfurt-07", locationTrust: "trusted" });
      }
      expect(allocateSpy).not.toHaveBeenCalled();
    } finally {
      allocateSpy.mockRestore();
    }
    const row = (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];
    expect(row.region).toBe("eu-de-frankfurt");
    expect(row.siteId).toBe("eu-de-frankfurt-07"); // unchanged — proves no renumber too
    expect(row.pendingRegion).toBe("eu-fr-paris");
    expect(row.pendingRegionCount).toBe(2);
    // A capped check is no answer: the badge keeps saying Verified, jobs
    // claimed meanwhile freeze trusted/lastmile (not low_confidence/unknown),
    // and the check time doesn't advance, so the next heartbeat re-checks.
    expect(row.locationTrust).toBe("trusted");
    expect(row.accessClass).toBe("lastmile");
    expect(row.accessReason).toBe("v1: eyeball-asn + residential-rdns");
    expect(row.locationCheckedAt?.getTime()).toBe(checkedAt.getTime());
    expect(row.accessCheckedAt?.getTime()).toBe(checkedAt.getTime());
  });

  it("the first check after the data loads classifies a capped agent and advances the check time", async () => {
    const checkedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await db.update(evalAgents).set({
      region: null, siteId: null, pendingRegion: null, pendingRegionCount: 0,
      locationTrust: "unknown", locationCheckedAt: checkedAt, accessClass: null, accessReason: null, accessCheckedAt: null,
    }).where(eq(evalAgents.id, agentId));
    const agent = { id: agentId, region: null, siteId: null, pendingRegion: null, pendingRegionCount: 0, locationTrust: "unknown" };
    // Data unloaded: nothing written.
    const capped = await runAgentLocationCheck({ agent, token: { id: tokenId, dispatchTier: "private" }, ip: "80.150.1.1", immediate: false, deps: unloadedWithGeo });
    expect(capped.locationTrust).toBe("unknown");
    let row = (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];
    expect(row.locationCheckedAt?.getTime()).toBe(checkedAt.getTime());
    expect(row.accessClass).toBeNull();
    // Data loaded (same agent, next beat): classified at once.
    const loaded = await runAgentLocationCheck({
      agent, token: { id: tokenId, dispatchTier: "private" }, ip: "80.150.1.1", immediate: false,
      deps: { ...unloadedWithGeo, networkClassLoaded: true },
    });
    expect(loaded.locationTrust).toBe("trusted");
    row = (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];
    expect(row.locationTrust).toBe("trusted");
    expect(row.accessClass).toBe("unknown");
    expect(row.accessReason).toBe("v1: insufficient");
    expect(row.locationCheckedAt!.getTime()).toBeGreaterThan(checkedAt.getTime());
  });

  it("unloaded access data, no geo (not capped): trust is written, but access and the check time stay as they were", async () => {
    const checkedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await db.update(evalAgents).set({
      region: null, siteId: null, pendingRegion: null, pendingRegionCount: 0,
      locationTrust: "trusted", locationCheckedAt: checkedAt, accessClass: "datacenter", accessReason: "v1: dc-range", accessCheckedAt: checkedAt,
    }).where(eq(evalAgents.id, agentId));
    const res = await runAgentLocationCheck({
      agent: { id: agentId, region: null, siteId: null, pendingRegion: null, pendingRegionCount: 0, locationTrust: "trusted" },
      token: { id: tokenId, dispatchTier: "private" }, ip: "80.150.1.1", immediate: false,
      deps: { ...unloadedWithGeo, geo: () => null },
    });
    expect(res.locationTrust).toBe("low_confidence");
    const row = (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];
    expect(row.locationTrust).toBe("low_confidence");
    expect(row.accessClass).toBe("datacenter");
    expect(row.accessReason).toBe("v1: dc-range");
    expect(row.locationCheckedAt?.getTime()).toBe(checkedAt.getTime());
  });

  it("unloaded access data: a new agent with no region stays Unverified (fail closed)", async () => {
    await db.update(evalAgents).set({ region: null, siteId: null, pendingRegion: null, pendingRegionCount: 0 })
      .where(eq(evalAgents.id, agentId));
    const res = await runAgentLocationCheck({
      agent: { id: agentId, region: null, siteId: null, pendingRegion: null, pendingRegionCount: 0 },
      token: { id: tokenId, dispatchTier: "private" },
      ip: "80.150.1.1", immediate: true, deps: unloadedWithGeo,
    });
    expect(res.region).toBeNull();
    expect(res.siteId).toBeNull();
    const row = (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];
    expect(row.region).toBeNull();
    expect(row.siteId).toBeNull();
  });

  it("unloaded access data: a Tor exit still fast-distrusts an existing agent (region and siteId cleared)", async () => {
    await db.update(evalAgents).set({ region: "eu-de-frankfurt", siteId: "eu-de-frankfurt-07", pendingRegion: null, pendingRegionCount: 0 })
      .where(eq(evalAgents.id, agentId));
    const res = await runAgentLocationCheck({
      agent: { id: agentId, region: "eu-de-frankfurt", siteId: "eu-de-frankfurt-07", pendingRegion: null, pendingRegionCount: 0 },
      token: { id: tokenId, dispatchTier: "private" },
      ip: "80.150.1.1", immediate: false,
      deps: { ...unloadedWithGeo, torExits: new Set(["80.150.1.1"]) },
    });
    expect(res).toEqual({ region: null, siteId: null, locationTrust: "anonymized" });
    const row = (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];
    expect(row.region).toBeNull();
    expect(row.siteId).toBeNull();
    expect(row.locationTrust).toBe("anonymized");
  });
});
