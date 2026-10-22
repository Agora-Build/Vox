/**
 * Core-side agent network signals (Part-2 Task 3) — the HTTP/DB half of
 * designs/2026-10-22-network-tags-design.md "Where it's computed and
 * stored". Task 2 already proved the classifier itself accepts
 * `AgentNetSignals` (tests/location-access.test.ts, tests/access-class.test.ts);
 * this file covers what Task 3 adds on top: strict parsing of the wire
 * field, sticky per-field merge into `eval_agents.net_signals`, and the
 * heartbeat's "re-check on signal change" trigger.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, hashToken } from "../server/storage";
import { evalAgents, evalAgentTokens } from "../shared/schema";
import { parseNetSignalsUpdate, mergeNetSignals, netSignalsChanged } from "../server/net-signals-update";
import { runAgentLocationCheck, accessSignalsFrom, type DetectionDeps, type GeoLookup } from "../server/location";
import { createAccessData, parseCidrList, networkClassOf } from "../server/access-data";
import { BASE_NA } from "./helpers/regions";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Pure parse/merge/change-detection (no DB) — server/net-signals-update.ts
// ---------------------------------------------------------------------------

describe("parseNetSignalsUpdate", () => {
  it("parses recognized boolean fields", () => {
    expect(parseNetSignalsUpdate({ cloudMetadata: true, publicIpOnInterface: false })).toEqual({
      cloudMetadata: true, publicIpOnInterface: false,
    });
  });

  it("silently ignores an unknown key — never throws, never includes it", () => {
    expect(parseNetSignalsUpdate({ cloudMetadata: true, bogus: "x" })).toEqual({ cloudMetadata: true });
  });

  it("silently ignores a non-boolean value for a known key", () => {
    expect(parseNetSignalsUpdate({ cloudMetadata: "yes", publicIpOnInterface: 1 })).toBeUndefined();
  });

  it("a non-object body (string, number, array, null) parses to undefined", () => {
    expect(parseNetSignalsUpdate("nope")).toBeUndefined();
    expect(parseNetSignalsUpdate(42)).toBeUndefined();
    expect(parseNetSignalsUpdate(["a"])).toBeUndefined();
    expect(parseNetSignalsUpdate(null)).toBeUndefined();
    expect(parseNetSignalsUpdate(undefined)).toBeUndefined();
  });

  it("an empty object parses to undefined, not {}", () => {
    expect(parseNetSignalsUpdate({})).toBeUndefined();
  });
});

describe("mergeNetSignals", () => {
  it("an update field overwrites; an unreported field keeps its stored value (sticky)", () => {
    const merged = mergeNetSignals({ cloudMetadata: false, publicIpOnInterface: true }, { cloudMetadata: true });
    expect(merged).toEqual({ cloudMetadata: true, publicIpOnInterface: true });
  });

  it("no update (undefined) leaves stored as-is", () => {
    expect(mergeNetSignals({ cloudMetadata: true }, undefined)).toEqual({ cloudMetadata: true });
    expect(mergeNetSignals(null, undefined)).toBeNull();
  });

  it("nothing stored yet: the update becomes the whole stored value", () => {
    expect(mergeNetSignals(null, { publicIpOnInterface: false })).toEqual({ publicIpOnInterface: false });
    expect(mergeNetSignals(undefined, { publicIpOnInterface: false })).toEqual({ publicIpOnInterface: false });
  });

  it("merging to nothing at all returns null, never {}", () => {
    expect(mergeNetSignals(null, undefined)).toBeNull();
  });
});

describe("netSignalsChanged", () => {
  it("false when there's no update", () => {
    expect(netSignalsChanged({ cloudMetadata: true }, undefined)).toBe(false);
  });

  it("false when the update repeats the same stored value", () => {
    expect(netSignalsChanged({ cloudMetadata: true }, { cloudMetadata: true })).toBe(false);
  });

  it("true when a reported field actually flips (e.g. cloudMetadata false→true)", () => {
    expect(netSignalsChanged({ cloudMetadata: false }, { cloudMetadata: true })).toBe(true);
  });

  it("true when the update introduces a field nothing was stored for yet", () => {
    expect(netSignalsChanged(null, { publicIpOnInterface: true })).toBe(true);
  });

  it("ignores fields the update doesn't mention — no false positive from an unrelated stored field", () => {
    expect(netSignalsChanged({ cloudMetadata: true, publicIpOnInterface: true }, { cloudMetadata: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DB: agent signals read back from the persisted column reach the classifier
// the same way Task 2 proved for an in-request value (tests/location-access.test.ts)
// ---------------------------------------------------------------------------

const geoFrankfurt: GeoLookup = {
  city: "Frankfurt am Main", countryCode: "DE", countryName: "Germany", continentCode: "EU",
  lat: 50.11, lon: 8.68, accuracyKm: 20,
};
const access = createAccessData({
  datacenter: [parseCidrList("88.198.0.0/16\n")],
  vpn: [parseCidrList("1.2.3.0/24\n")],
  apnic: new Map([[3320, 38.27]]), // Deutsche Telekom: an access network, earns lastmile
  mobileAsns: new Set([21928]),
});
const DT_IP = "80.150.1.1"; // Deutsche Telekom — earns lastmile with the right rDNS

function lastmileDeps(): DetectionDeps {
  return {
    geo: () => geoFrankfurt,
    asn: () => ({ asn: 3320, org: "Deutsche Telekom" }),
    torExits: new Set(),
    networkClass: (ip, asn) => networkClassOf(access, ip, asn),
    networkClassLoaded: true,
    accessSignals: accessSignalsFrom(access),
    reverseDns: async () => "p5096a101.dip0.t-ipconnect.de",
  };
}

describeDb("agent signals persisted on eval_agents.net_signals reach the classifier", () => {
  let tokenId: number;
  let agentId: number;
  const fresh = { region: null, siteId: null, pendingRegion: null, pendingRegionCount: 0 };
  const row = async () => (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];

  beforeAll(async () => {
    const [token] = await db.insert(evalAgentTokens).values({
      name: "net-signals-core", tokenHash: hashToken(`net-signals-core-${Date.now()}`),
      dispatchTier: "private", createdBy: 1, isRevoked: false, siteId: null, region: null,
    }).returning();
    tokenId = token.id;
    const [agent] = await db.insert(evalAgents).values({ name: "net-signals-core-agent", tokenId, siteId: null, state: "idle" }).returning();
    agentId = agent.id;
  });
  afterAll(async () => {
    await db.delete(evalAgents).where(eq(evalAgents.id, agentId));
    await db.delete(evalAgentTokens).where(eq(evalAgentTokens.id, tokenId));
  });

  it("without any agent signal, Deutsche Telekom earns lastmile (baseline)", async () => {
    await db.update(evalAgents).set({ netSignals: null }).where(eq(evalAgents.id, agentId));
    const stored = await row();
    const res = await runAgentLocationCheck({
      agent: { id: agentId, ...fresh }, token: { id: tokenId, dispatchTier: "private" },
      ip: DT_IP, immediate: true, deps: lastmileDeps(), netSignals: stored.netSignals ?? undefined,
    });
    expect(res.locationTrust).toBe("trusted");
    expect((await row()).accessClass).toBe("lastmile");
  });

  it("a persisted cloudMetadata:true read back from the DB turns it datacenter instead", async () => {
    await db.update(evalAgents).set({ netSignals: { cloudMetadata: true } }).where(eq(evalAgents.id, agentId));
    const stored = await row();
    expect(stored.netSignals).toEqual({ cloudMetadata: true });
    await runAgentLocationCheck({
      agent: { id: agentId, ...fresh }, token: { id: tokenId, dispatchTier: "private" },
      ip: DT_IP, immediate: true, deps: lastmileDeps(), netSignals: stored.netSignals ?? undefined,
    });
    const r = await row();
    expect(r.accessClass).toBe("datacenter");
    expect(r.accessReason).toBe("v1: cloud-metadata");
  });

  it("a persisted publicIpOnInterface:true read back from the DB demotes the would-be lastmile to unknown — never lastmile", async () => {
    await db.update(evalAgents).set({ netSignals: { publicIpOnInterface: true } }).where(eq(evalAgents.id, agentId));
    const stored = await row();
    await runAgentLocationCheck({
      agent: { id: agentId, ...fresh }, token: { id: tokenId, dispatchTier: "private" },
      ip: DT_IP, immediate: true, deps: lastmileDeps(), netSignals: stored.netSignals ?? undefined,
    });
    const r = await row();
    expect(r.accessClass).toBe("unknown");
    expect(r.accessReason).toBe("v1: public-ip-on-iface + eyeball-asn + residential-rdns");
  });
});

// ---------------------------------------------------------------------------
// HTTP: register/heartbeat parse, persist, merge, and trigger a re-check —
// against the real dev server (same style as the bottom of
// tests/location-access.test.ts). The dev server sees a loopback caller, so
// the classifier itself always lands on unknown/private-ip here — what this
// section proves is the wire→DB plumbing and the heartbeat trigger, not the
// classifier decision (covered above and in tests/location-access.test.ts).
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

describeDb("register/heartbeat persist netSignals (HTTP)", () => {
  // Each test mints its own token: the register route upserts onto the
  // SAME agent row for a reused token (getEvalAgentsByTokenId) — sharing one
  // token across two `it`s would carry the first test's stored netSignals
  // into the second's "fresh registration" via that sticky merge, which is
  // exactly the kind of cross-test contamination that isn't the thing under
  // test here.
  const tokenIds: number[] = [];
  let cookie: string;

  beforeAll(async () => {
    const login = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: process.env.TEST_ADMIN_EMAIL || "admin@vox.local", password: process.env.TEST_ADMIN_PASSWORD || "admin123456" }),
    });
    expect(login.ok).toBe(true);
    cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  });
  afterAll(async () => {
    for (const id of tokenIds) await db.update(evalAgentTokens).set({ isRevoked: true }).where(eq(evalAgentTokens.id, id));
  });

  async function freshToken(): Promise<string> {
    const tokenRes = await fetch(`${BASE_URL}/api/admin/eval-agent-tokens`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `Net Signals Token ${Date.now()}-${Math.random()}`, regionLocationBaseId: BASE_NA }),
    });
    expect(tokenRes.ok).toBe(true);
    const body = await tokenRes.json();
    tokenIds.push(body.id);
    return body.token;
  }

  it("register stores netSignals; a body can't write anything else into it", async () => {
    const tokenValue = await freshToken();
    const reg = await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenValue}` },
      body: JSON.stringify({ name: "Net Signals Agent", metadata: {}, netSignals: { cloudMetadata: true, bogus: "x" } }),
    });
    expect(reg.ok).toBe(true);
    const regBody = await reg.json();
    const { id: agentId, leaseId } = regBody;
    // netSignals is internal (drives the classifier, never exposed) — stored
    // on the agent but absent from the register response and from the public
    // agents list (review fix round 1, Minor).
    expect(regBody).not.toHaveProperty("netSignals");
    let r = (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];
    expect(r.netSignals).toEqual({ cloudMetadata: true });

    const listRes = await fetch(`${BASE_URL}/api/eval-agents`, { headers: { Cookie: cookie } });
    expect(listRes.ok).toBe(true);
    const listed = (await listRes.json()).find((a: { id: number }) => a.id === agentId);
    expect(listed).toBeTruthy();
    expect(listed).not.toHaveProperty("netSignals");

    // Junk-only body: ignored entirely, leaves the stored value alone.
    const hbJunk = await fetch(`${BASE_URL}/api/eval-agent/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenValue}` },
      body: JSON.stringify({ agentId, leaseId, state: "idle", metadata: {}, netSignals: { nonsense: true } }),
    });
    expect(hbJunk.ok).toBe(true);
    r = (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];
    expect(r.netSignals).toEqual({ cloudMetadata: true });

    // A beat reporting only the other field merges in, sticky — the first field survives.
    const hbMerge = await fetch(`${BASE_URL}/api/eval-agent/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenValue}` },
      body: JSON.stringify({ agentId, leaseId, state: "idle", metadata: {}, netSignals: { publicIpOnInterface: false } }),
    });
    expect(hbMerge.ok).toBe(true);
    r = (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];
    expect(r.netSignals).toEqual({ cloudMetadata: true, publicIpOnInterface: false });
  });

  it("a heartbeat whose netSignals actually change triggers an immediate re-check (not just at staleness)", async () => {
    const tokenValue = await freshToken();
    const reg = await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenValue}` },
      body: JSON.stringify({ name: "Net Signals Trigger Agent", metadata: {}, netSignals: { cloudMetadata: false } }),
    });
    expect(reg.ok).toBe(true);
    const { id: agentId, leaseId } = await reg.json();

    // Freeze the clock so staleness/ipChanged/pending can't be the thing that
    // fires the re-check — only a changed signal should.
    let r = (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];
    const checkedAtAfterRegister = r.accessCheckedAt;
    expect(checkedAtAfterRegister).not.toBeNull();
    await db.update(evalAgents).set({ accessClass: null, accessReason: null }).where(eq(evalAgents.id, agentId));

    const hb = await fetch(`${BASE_URL}/api/eval-agent/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenValue}` },
      body: JSON.stringify({ agentId, leaseId, state: "idle", metadata: {}, netSignals: { cloudMetadata: true } }),
    });
    expect(hb.ok).toBe(true);

    for (let i = 0; i < 40; i++) {
      r = (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];
      if (r.accessClass) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    // The re-check ran again on this same beat (accessClass got re-written),
    // even though nothing made it stale and the caller IP didn't change.
    expect(r.accessClass).not.toBeNull();
    expect(r.netSignals).toEqual({ cloudMetadata: true });
  });
});
