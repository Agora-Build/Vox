import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// `sim` is system-only — detected on both sides, must match
// (designs/2026-10-22-network-tags-design.md). The phone reports its SIM
// operator's MCC-MNC through DialF; Core looks our own number up (Twilio,
// stubbed here by a local HTTP server) and compares network codes. A private,
// freshly migrated database holds the agents and the lookup cache.

await vi.hoisted(async () => {
  if (process.env.DATABASE_URL) {
    const { prepareIsolatedCoreDb } = await import("./helpers/isolated-core-db");
    process.env.DATABASE_URL = await prepareIsolatedCoreDb(process.env.DATABASE_URL, "vox_test_sim_carrier");
  }
});
import { storage, pool } from "../server/storage";
import { TwilioLookupProvider, CACHE_MAX_AGE_MS } from "../server/number-lookup";
import { parseSimReport, computeSimMatch, refreshAgentSim, resetSimMemo } from "../server/sim-carrier";

const SID = "AC" + "0123456789abcdef0123456789abcdef";

// ---- Twilio stub ------------------------------------------------------------

let codes: (e164: string) => { carrier: string | null; mcc: string | null; mnc: string | null; status?: number } = () => ({ carrier: null, mcc: null, mnc: null });
const requests: string[] = [];
let server: http.Server;
let baseUrl = "";
const provider = () => new TwilioLookupProvider({ accountSid: SID, authToken: "tok", baseUrl });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    const m = /^\/v2\/PhoneNumbers\/([^?]+)/.exec(req.url ?? "");
    const c = codes(decodeURIComponent(m?.[1] ?? ""));
    res.writeHead(c.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      valid: true,
      line_type_intelligence: { carrier_name: c.carrier, type: "mobile", mobile_country_code: c.mcc, mobile_network_code: c.mnc },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (process.env.DATABASE_URL) await pool.end();
});

beforeEach(async () => {
  requests.length = 0;
  resetSimMemo();
  if (process.env.DATABASE_URL) await pool.query("DELETE FROM number_lookups");
});

// ---- strict parse (pure) ----------------------------------------------------

describe("parseSimReport", () => {
  it("accepts number + mcc + mnc + operatorName", () => {
    expect(parseSimReport({ number: "+15550101234", mcc: "310", mnc: "260", operatorName: "Mint" }))
      .toEqual({ number: "+15550101234", mcc: "310", mnc: "260", operatorName: "Mint" });
  });

  it("a number alone (no operator from the phone) is still a report", () => {
    expect(parseSimReport({ number: "+15550101234" })).toEqual({ number: "+15550101234" });
  });

  it("junk is ignored: no/invalid number → no report; bad codes → dropped", () => {
    expect(parseSimReport(undefined)).toBeUndefined();
    expect(parseSimReport("+15550101234")).toBeUndefined();
    expect(parseSimReport(["x"])).toBeUndefined();
    expect(parseSimReport({ number: "5550101234", mcc: "310", mnc: "260" })).toBeUndefined();
    expect(parseSimReport({ number: "+1 555 010 1234" })).toBeUndefined();
    expect(parseSimReport({ number: "+15550101234", mcc: "31", mnc: "2600" })).toEqual({ number: "+15550101234" });
    expect(parseSimReport({ number: "+15550101234", mcc: 310, mnc: 260 })).toEqual({ number: "+15550101234" });
    // A code pair is all or nothing — an MCC with no MNC can't be compared.
    expect(parseSimReport({ number: "+15550101234", mcc: "310" })).toEqual({ number: "+15550101234" });
    expect(parseSimReport({ number: "+15550101234", operatorName: { x: 1 } })).toEqual({ number: "+15550101234" });
    expect(parseSimReport({ number: "+15550101234", operatorName: "x".repeat(200) })).toEqual({ number: "+15550101234", operatorName: "x".repeat(64) });
  });
});

const d = process.env.DATABASE_URL ? describe : describe.skip;

// ---- matching (stub Twilio) -------------------------------------------------

d("computeSimMatch", () => {
  it("match by network code — an MVNO SIM (Mint) on T-Mobile's code → sim:t-mobile from the lookup's carrier", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const r = await computeSimMatch({ number: "+15550101234", mcc: "310", mnc: "260", operatorName: "Mint Mobile" }, { provider: provider() });
    expect(r).toEqual({ simCarrier: "t-mobile", simReason: "v1: sim-match 310-260", simNumberRedacted: "…1234" });
  });

  it("mismatch → no carrier, the reason names both codes", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const r = await computeSimMatch({ number: "+15550101234", mcc: "311", mnc: "480", operatorName: "Verizon" }, { provider: provider() });
    expect(r).toEqual({ simCarrier: null, simReason: "v1: mismatch 311-480 vs 310-260", simNumberRedacted: "…1234" });
  });

  it("same name but a different code is still a mismatch — names are never compared", async () => {
    codes = () => ({ carrier: "AT&T Wireless", mcc: "310", mnc: "410" });
    const r = await computeSimMatch({ number: "+15550101234", mcc: "310", mnc: "150", operatorName: "AT&T" }, { provider: provider() });
    expect(r.simCarrier).toBeNull();
    expect(r.simReason).toBe("v1: mismatch 310-150 vs 310-410");
  });

  it("lookup off (no credentials) → null + lookup-off, no HTTP", async () => {
    const r = await computeSimMatch({ number: "+15550101234", mcc: "310", mnc: "260" }, { provider: null });
    expect(r).toEqual({ simCarrier: null, simReason: "v1: lookup-off", simNumberRedacted: "…1234" });
    expect(requests).toHaveLength(0);
  });

  it("no operator from the phone → null + no-sim-operator, and the number isn't even looked up", async () => {
    const r = await computeSimMatch({ number: "+15550101234" }, { provider: provider() });
    expect(r).toEqual({ simCarrier: null, simReason: "v1: no-sim-operator", simNumberRedacted: "…1234" });
    expect(requests).toHaveLength(0);
  });

  it("the lookup has no codes / fails → no carrier, never a guess", async () => {
    codes = () => ({ carrier: "Some VoIP", mcc: null, mnc: null });
    expect((await computeSimMatch({ number: "+15550101234", mcc: "310", mnc: "260" }, { provider: provider() })).simReason)
      .toBe("v1: no-lookup-codes");
    codes = () => ({ carrier: null, mcc: null, mnc: null, status: 500 });
    const failed = await computeSimMatch({ number: "+15550109876", mcc: "310", mnc: "260" }, { provider: provider() });
    expect(failed).toEqual({ simCarrier: null, simReason: "v1: lookup-failed", simNumberRedacted: "…9876" });
  });
});

// ---- storing on the agent ---------------------------------------------------

d("refreshAgentSim (stores on the agent; recomputes only on change / expiry)", () => {
  let tokenId = 0;
  beforeAll(async () => {
    await pool.query(`INSERT INTO users(id,username,email,plan,is_admin,is_enabled) VALUES(1,'SimAdmin','sim-admin@test.local','principal',true,true)`);
    await pool.query("SELECT setval(pg_get_serial_sequence('users','id'),1)");
    const tok = await storage.createEvalAgentToken({ name: "sim-tok", tokenHash: `sim-${Date.now()}`, siteId: "na-us-ashburn-01", dispatchTier: "public", createdBy: 1 } as any);
    tokenId = tok.id;
  });
  const mkAgent = () => storage.createEvalAgent({ tokenId, name: `sim-a-${Date.now()}-${Math.random()}`, siteId: "na-us-ashburn-01", state: "idle", metadata: {} } as any);
  const row = async (id: number) => (await pool.query(`SELECT * FROM eval_agents WHERE id = $1`, [id])).rows[0];

  it("writes carrier, reason and the redacted number — the full number appears nowhere on the agent row", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const a = await mkAgent();
    expect(await refreshAgentSim(a.id, { number: "+15550104321", mcc: "310", mnc: "260" }, { provider: provider() })).toBe(true);
    const r = await row(a.id);
    expect(r).toMatchObject({ sim_carrier: "t-mobile", sim_reason: "v1: sim-match 310-260", sim_number_redacted: "…4321" });
    expect(JSON.stringify(r)).not.toContain("5550104321");
  });

  it("an unchanged report is not recomputed; a changed code or an expired lookup is", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const a = await mkAgent();
    const rep = { number: "+15550105555", mcc: "310", mnc: "260" };
    expect(await refreshAgentSim(a.id, rep, { provider: provider() })).toBe(true);
    expect(await refreshAgentSim(a.id, rep, { provider: provider() })).toBe(false);
    expect(await refreshAgentSim(a.id, { ...rep, mnc: "240" }, { provider: provider() })).toBe(true);
    expect((await row(a.id)).sim_reason).toBe("v1: mismatch 310-240 vs 310-260");
    expect(await refreshAgentSim(a.id, { ...rep, mnc: "240" }, { provider: provider(), now: Date.now() + CACHE_MAX_AGE_MS + 1000 })).toBe(true);
  });

  it("a lookup-off answer is retried later (credentials may arrive), not frozen for a month", async () => {
    const a = await mkAgent();
    const rep = { number: "+15550106666", mcc: "310", mnc: "260" };
    expect(await refreshAgentSim(a.id, rep, { provider: null })).toBe(true);
    expect((await row(a.id)).sim_reason).toBe("v1: lookup-off");
    expect(await refreshAgentSim(a.id, rep, { provider: null })).toBe(false);
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    expect(await refreshAgentSim(a.id, rep, { provider: provider(), now: Date.now() + 11 * 60 * 1000 })).toBe(true);
    expect((await row(a.id)).sim_carrier).toBe("t-mobile");
  });
  it("a transient lookup failure keeps a prior match for the same number and code — and still retries", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const a = await mkAgent();
    const rep = { number: "+15550107777", mcc: "310", mnc: "260" };
    expect(await refreshAgentSim(a.id, rep, { provider: provider() })).toBe(true);
    // The cached answer expires; the refresh hits a Twilio 500.
    await pool.query("UPDATE number_lookups SET looked_up_at = $1 WHERE number = $2", [new Date(Date.now() - CACHE_MAX_AGE_MS - 60_000), rep.number]);
    codes = () => ({ carrier: null, mcc: null, mnc: null, status: 500 });
    const later = Date.now() + CACHE_MAX_AGE_MS + 1000;
    expect(await refreshAgentSim(a.id, rep, { provider: provider(), now: later })).toBe(true);
    expect(await row(a.id)).toMatchObject({ sim_carrier: "t-mobile", sim_reason: "v1: sim-match 310-260" });
    // Same after a Core restart (memo gone): the stored row itself says what it matched.
    resetSimMemo();
    expect(await refreshAgentSim(a.id, rep, { provider: provider(), now: later })).toBe(true);
    expect((await row(a.id)).sim_carrier).toBe("t-mobile");
    // The retry is still scheduled; a definitive answer then overwrites.
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "240" });
    expect(await refreshAgentSim(a.id, rep, { provider: provider(), now: later + 11 * 60 * 1000 })).toBe(true);
    expect(await row(a.id)).toMatchObject({ sim_carrier: null, sim_reason: "v1: mismatch 310-260 vs 310-240" });
  });

  it("a failure for a DIFFERENT number or code does not keep the old answer", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const a = await mkAgent();
    expect(await refreshAgentSim(a.id, { number: "+15550108881", mcc: "310", mnc: "260" }, { provider: provider() })).toBe(true);
    codes = () => ({ carrier: null, mcc: null, mnc: null, status: 500 });
    expect(await refreshAgentSim(a.id, { number: "+15550108882", mcc: "310", mnc: "260" }, { provider: provider() })).toBe(true);
    expect(await row(a.id)).toMatchObject({ sim_carrier: null, sim_reason: "v1: lookup-failed", sim_number_redacted: "…8882" });
  });

  it("expiry runs from the cached lookup's lookedUpAt, not from when it was computed", async () => {
    const a = await mkAgent();
    const rep = { number: "+15550109191", mcc: "310", mnc: "260" };
    // A lookup already 29 days old in the shared cache (e.g. made for a flow's line).
    await pool.query(`INSERT INTO number_lookups (number, provider, carrier_name, line_type, value, mcc, mnc, looked_up_at)
      VALUES ($1, 'twilio', 'T-Mobile USA, Inc.', 'mobile', 't-mobile', '310', '260', $2)`, [rep.number, new Date(Date.now() - 29 * 24 * 3600 * 1000)]);
    expect(await refreshAgentSim(a.id, rep, { provider: provider() })).toBe(true);
    expect(requests).toHaveLength(0); // served from the cache
    expect(await refreshAgentSim(a.id, rep, { provider: provider(), now: Date.now() + 12 * 3600 * 1000 })).toBe(false);
    expect(await refreshAgentSim(a.id, rep, { provider: provider(), now: Date.now() + 2 * 24 * 3600 * 1000 })).toBe(true);
  });
});
