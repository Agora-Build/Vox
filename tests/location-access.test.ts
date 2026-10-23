// Access (lastmile/datacenter/unknown) computed by the location check and
// persisted on the agent — designs/2026-10-22-network-tags-design.md
// "Where it's computed and stored". DB-backed; DNS is injected, never real.
import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, hashToken } from "../server/storage";
import { evalAgents, evalAgentTokens } from "../shared/schema";
import { runAgentLocationCheck, accessSignalsFrom, type DetectionDeps, type GeoLookup } from "../server/location";
import { createAccessData, parseCidrList, networkClassOf } from "../server/access-data";
import { BASE_NA } from "./helpers/regions";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

const geoFrankfurt: GeoLookup = {
  city: "Frankfurt am Main", countryCode: "DE", countryName: "Germany", continentCode: "EU",
  lat: 50.11, lon: 8.68, accuracyKm: 20,
};
const access = createAccessData({
  datacenter: [parseCidrList("88.198.0.0/16\n")],
  vpn: [parseCidrList("1.2.3.0/24\n")],
  apnic: new Map([[3320, 38.27]]), // Deutsche Telekom: an access network
  mobileAsns: new Set([21928]),
});
const DC_IP = "88.198.1.1";        // in the datacenter range
const DT_IP = "80.150.1.1";        // Deutsche Telekom, not in any range

function makeDeps(over: Partial<DetectionDeps> = {}): DetectionDeps & { rdnsCalls: string[] } {
  const rdnsCalls: string[] = [];
  return {
    geo: () => geoFrankfurt,
    asn: (ip) => ip === DT_IP ? { asn: 3320, org: "Deutsche Telekom" } : { asn: 24940, org: "Hetzner" },
    torExits: new Set(["185.220.101.1"]),
    networkClass: (ip, asn) => networkClassOf(access, ip, asn),
    networkClassLoaded: true,
    accessSignals: accessSignalsFrom(access),
    reverseDns: async (ip) => { rdnsCalls.push(ip); return ip === DT_IP ? "p5096a101.dip0.t-ipconnect.de" : null; },
    rdnsCalls,
    ...over,
  };
}

describeDb("runAgentLocationCheck persists access", () => {
  let privateTokenId: number;
  let publicTokenId: number;
  let agentId: number;
  const fresh = { region: null, siteId: null, pendingRegion: null, pendingRegionCount: 0 };
  const row = async () => (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];

  beforeAll(async () => {
    const [priv] = await db.insert(evalAgentTokens).values({
      name: "zt-access-private", tokenHash: hashToken(`zt-access-p-${Date.now()}`),
      dispatchTier: "private", createdBy: 1, isRevoked: false, siteId: null, region: null,
    }).returning();
    const [pub] = await db.insert(evalAgentTokens).values({
      name: "zt-access-public", tokenHash: hashToken(`zt-access-u-${Date.now()}`),
      dispatchTier: "public", createdBy: 1, isRevoked: false, siteId: "na-us-seattle-01", region: "na-us-seattle",
    }).returning();
    privateTokenId = priv.id;
    publicTokenId = pub.id;
    const [agent] = await db.insert(evalAgents).values({ name: "zt-access-agent", tokenId: privateTokenId, siteId: null, state: "idle" }).returning();
    agentId = agent.id;
  });
  beforeEach(async () => {
    await db.update(evalAgents).set({ ...fresh, accessClass: null, accessReason: null, accessCheckedAt: null })
      .where(eq(evalAgents.id, agentId));
  });
  afterAll(async () => {
    await db.delete(evalAgents).where(eq(evalAgents.id, agentId));
    await db.delete(evalAgentTokens).where(eq(evalAgentTokens.id, privateTokenId));
    await db.delete(evalAgentTokens).where(eq(evalAgentTokens.id, publicTokenId));
  });

  it("a datacenter range makes trust datacenter (region-eligible) and stores access datacenter — with no DNS lookup", async () => {
    const deps = makeDeps();
    const res = await runAgentLocationCheck({
      agent: { id: agentId, ...fresh }, token: { id: privateTokenId, dispatchTier: "private" },
      ip: DC_IP, immediate: true, deps,
    });
    // A datacenter range decides access on its own; the name can't change it.
    expect(deps.rdnsCalls).toEqual([]);
    expect(res.locationTrust).toBe("datacenter");
    expect(res.region).not.toBeNull();
    const r = await row();
    expect(r.locationTrust).toBe("datacenter");
    expect(r.accessClass).toBe("datacenter");
    expect(r.accessReason).toBe("v1: dc-range");
    expect(r.accessCheckedAt).not.toBeNull();
  });

  it("the reverse-DNS answer feeds the classifier: access network + residential name → lastmile", async () => {
    const deps = makeDeps();
    const res = await runAgentLocationCheck({
      agent: { id: agentId, ...fresh }, token: { id: privateTokenId, dispatchTier: "private" },
      ip: DT_IP, immediate: true, deps,
    });
    expect(deps.rdnsCalls).toEqual([DT_IP]);
    expect(res.locationTrust).toBe("trusted");
    const r = await row();
    expect(r.accessClass).toBe("lastmile");
    expect(r.accessReason).toBe("v1: eyeball-asn + residential-rdns");
  });

  it("agent net signals reach the classifier (cloud metadata → datacenter)", async () => {
    await runAgentLocationCheck({
      agent: { id: agentId, ...fresh }, token: { id: privateTokenId, dispatchTier: "private" },
      ip: DT_IP, immediate: true, deps: makeDeps(), netSignals: { cloudMetadata: true },
    });
    const r = await row();
    expect(r.accessClass).toBe("datacenter");
    expect(r.accessReason).toBe("v1: cloud-metadata");
    expect(r.locationTrust).toBe("datacenter");
  });

  it("public tier (record-only path) still stores access", async () => {
    const res = await runAgentLocationCheck({
      agent: { id: agentId, region: "na-us-seattle", siteId: "na-us-seattle-01", pendingRegion: null, pendingRegionCount: 0 },
      token: { id: publicTokenId, dispatchTier: "public" },
      ip: DC_IP, immediate: false, deps: makeDeps(),
    });
    expect(res.siteId).toBe("na-us-seattle-01");
    const r = await row();
    expect(r.accessClass).toBe("datacenter");
    expect(r.accessReason).toBe("v1: dc-range");
    expect(r.accessCheckedAt).not.toBeNull();
  });

  it("capped result (data unloaded) writes no access (never lastmile, never no-data) and makes no DNS lookup", async () => {
    const deps = makeDeps({ networkClassLoaded: false });
    const res = await runAgentLocationCheck({
      agent: { id: agentId, ...fresh, locationTrust: "unknown" }, token: { id: privateTokenId, dispatchTier: "private" },
      ip: DT_IP, immediate: true, deps,
    });
    expect(res.locationTrust).toBe("unknown"); // the stored answer — a capped check changes nothing
    expect(deps.rdnsCalls).toEqual([]);
    const r = await row();
    expect(r.accessClass).toBeNull();
    expect(r.accessReason).toBeNull();
    expect(r.accessCheckedAt).toBeNull();
  });

  it("public tier, data unloaded: the stored trust, access and check time are kept", async () => {
    const checkedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await db.update(evalAgents).set({ locationTrust: "datacenter", locationCheckedAt: checkedAt, accessClass: "datacenter", accessReason: "v1: dc-range", accessCheckedAt: checkedAt })
      .where(eq(evalAgents.id, agentId));
    const res = await runAgentLocationCheck({
      agent: { id: agentId, region: "na-us-seattle", siteId: "na-us-seattle-01", pendingRegion: null, pendingRegionCount: 0, locationTrust: "datacenter" },
      token: { id: publicTokenId, dispatchTier: "public" },
      ip: DC_IP, immediate: false, deps: makeDeps({ networkClassLoaded: false }),
    });
    expect(res).toEqual({ region: "na-us-seattle", siteId: "na-us-seattle-01", locationTrust: "datacenter" });
    const r = await row();
    expect(r.locationTrust).toBe("datacenter");
    expect(r.accessClass).toBe("datacenter");
    expect(r.locationCheckedAt?.getTime()).toBe(checkedAt.getTime());
  });

  it("Tor exit / private IP: stored unknown and no DNS lookup", async () => {
    for (const [ip, reason] of [["185.220.101.1", "v1: tor"], ["10.0.0.5", "v1: private-ip"]] as const) {
      const deps = makeDeps();
      await runAgentLocationCheck({
        agent: { id: agentId, ...fresh }, token: { id: privateTokenId, dispatchTier: "private" },
        ip, immediate: true, deps,
      });
      expect(deps.rdnsCalls).toEqual([]);
      const r = await row();
      expect(r.accessClass).toBe("unknown");
      expect(r.accessReason).toBe(reason);
    }
  });
});

// Through the real routes (dev server): register and heartbeat both run the
// location check and persist access. The dev server sees a loopback caller,
// so the stored answer is unknown / private-ip — what matters here is that it
// is written by the check, and that a request body can't write it.
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

describeDb("register/heartbeat persist access (HTTP)", () => {
  let tokenValue: string;
  let tokenId: number;

  beforeAll(async () => {
    const login = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: process.env.TEST_ADMIN_EMAIL || "admin@vox.local", password: process.env.TEST_ADMIN_PASSWORD || "admin123456" }),
    });
    expect(login.ok).toBe(true);
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const tokenRes = await fetch(`${BASE_URL}/api/admin/eval-agent-tokens`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `Access Token ${Date.now()}`, regionLocationBaseId: BASE_NA }),
    });
    expect(tokenRes.ok).toBe(true);
    const body = await tokenRes.json();
    tokenValue = body.token;
    tokenId = body.id;
  });
  afterAll(async () => {
    // Delete, not revoke: a revoked token's public agent row still holds its site sequence.
    if (tokenId) {
      await db.delete(evalAgents).where(eq(evalAgents.tokenId, tokenId));
      await db.delete(evalAgentTokens).where(eq(evalAgentTokens.id, tokenId));
    }
  });

  it("register stores access; a body can't set it; a stale heartbeat re-check stores it again", async () => {
    const reg = await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenValue}` },
      body: JSON.stringify({ name: "Access Agent", metadata: {}, accessClass: "lastmile", accessReason: "v1: forged" }),
    });
    expect(reg.ok).toBe(true);
    const { id: agentId, leaseId } = await reg.json();
    let r = (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];
    expect(r.accessClass).toBe("unknown");
    expect(r.accessReason).toBe("v1: private-ip");
    expect(r.accessCheckedAt).not.toBeNull();

    // Make the check stale and clear access, then beat: the fire-and-forget
    // re-check writes it back.
    await db.update(evalAgents).set({ locationCheckedAt: null, accessClass: null, accessReason: null, accessCheckedAt: null })
      .where(eq(evalAgents.id, agentId));
    const hb = await fetch(`${BASE_URL}/api/eval-agent/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenValue}` },
      body: JSON.stringify({ agentId, leaseId, state: "idle", metadata: {}, accessClass: "lastmile" }),
    });
    expect(hb.ok).toBe(true);
    for (let i = 0; i < 40; i++) {
      r = (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];
      if (r.accessCheckedAt) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(r.accessClass).toBe("unknown");
    expect(r.accessReason).toBe("v1: private-ip");
    expect(r.accessCheckedAt).not.toBeNull();
  });
});
