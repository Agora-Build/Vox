import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// `sim` is system-only — detected on both sides, must match
// (designs/2026-10-22-network-tags-design.md). The phone reports its SIM
// operator's MCC-MNC through DialF; Core looks our own number up (Twilio,
// stubbed here by a local HTTP server) and compares network codes. A private,
// freshly migrated database holds the agents and the lookup cache.

await vi.hoisted(async () => {
  // The SIM number's keyed hash (numberHash) needs a server key.
  if (!/^[0-9a-f]{64}$/i.test(process.env.CREDENTIAL_ENCRYPTION_KEY ?? "")) {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "ab".repeat(32);
  }
  if (process.env.DATABASE_URL) {
    const { prepareIsolatedCoreDb } = await import("./helpers/isolated-core-db");
    process.env.DATABASE_URL = await prepareIsolatedCoreDb(process.env.DATABASE_URL, "vox_test_sim_carrier");
  }
});
import { storage, pool } from "../server/storage";
import { TwilioLookupProvider, CACHE_MAX_AGE_MS, numberHash, lookupFlowLine, lookupNumber } from "../server/number-lookup";
import { parseSimReport, computeSimMatch, refreshAgentSim, resetSimMemo, noteSimReport, SIM_RETRY_MS, NO_SIM_REPORT_REASON } from "../server/sim-carrier";
import { PAID_LOOKUPS_PER_DAY, SIM_LOOKUPS_PER_DAY, FLOW_LOOKUPS_PER_DAY, SIM_USER_LOOKUPS_PER_DAY, resetPaidLookupBudget, flowLookupGate } from "../server/paid-lookup-budget";

/** One day later is always the next UTC day (the caps' unit). */
const SIM_AGENT_LOOKUP_WINDOW_MS = 24 * 3600_000;
/** Noon UTC today: offsets of a few hours stay inside one UTC day. */
function noonUtc(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
}

const SID = "AC" + "0123456789abcdef0123456789abcdef";

// ---- Twilio stub ------------------------------------------------------------

let codes: (e164: string) => { carrier: string | null; mcc: string | null; mnc: string | null; status?: number; delayMs?: number } = () => ({ carrier: null, mcc: null, mnc: null });
const requests: string[] = [];
let server: http.Server;
let baseUrl = "";
const provider = () => new TwilioLookupProvider({ accountSid: SID, authToken: "tok", baseUrl });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    const m = /^\/v2\/PhoneNumbers\/([^?]+)/.exec(req.url ?? "");
    const c = codes(decodeURIComponent(m?.[1] ?? ""));
    setTimeout(() => {
      res.writeHead(c.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        valid: true,
        line_type_intelligence: { carrier_name: c.carrier, type: "mobile", mobile_country_code: c.mcc, mobile_network_code: c.mnc },
      }));
    }, c.delayMs ?? 0);
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
  if (process.env.DATABASE_URL) {
    await resetPaidLookupBudget();
    await pool.query("DELETE FROM number_lookups");
  }
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

  it("a phone agent that stops sending a valid sim report has its stored carrier cleared (v1: no-sim-report)", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const a = await mkAgent();
    await noteSimReport(a.id, { number: "+15550111001", mcc: "310", mnc: "260" }, ["phone"], { provider: provider() });
    expect((await row(a.id)).sim_carrier).toBe("t-mobile");
    for (const raw of [undefined, null, { number: "not-e164" }]) {
      await noteSimReport(a.id, raw, ["phone"], { provider: provider() });
      expect(await row(a.id)).toMatchObject({ sim_carrier: null, sim_reason: NO_SIM_REPORT_REASON, sim_number_redacted: null, sim_number_hash: null });
    }
    expect(NO_SIM_REPORT_REASON).toBe("v1: no-sim-report");
    // A report coming back recomputes (not stuck on the cleared memo).
    await noteSimReport(a.id, { number: "+15550111001", mcc: "310", mnc: "260" }, ["phone"], { provider: provider() });
    expect((await row(a.id)).sim_carrier).toBe("t-mobile");
  });

  it("no-report beats after the first clear cost no query at all (memo), and a restart costs one no-op statement", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const a = await mkAgent();
    await noteSimReport(a.id, { number: "+15550111002", mcc: "310", mnc: "260" }, ["phone"], { provider: provider() });
    await noteSimReport(a.id, undefined, ["phone"]);
    const q = vi.spyOn(pool, "query");
    try {
      for (let i = 0; i < 5; i++) await noteSimReport(a.id, undefined, ["phone"]);
      expect(q).not.toHaveBeenCalled();
      // After a restart (memo gone): one conditional UPDATE that matches no row.
      resetSimMemo();
      const before = (await pool.query(`SELECT xmin FROM eval_agents WHERE id = $1`, [a.id])).rows[0].xmin;
      q.mockClear();
      await noteSimReport(a.id, undefined, ["phone"]);
      await noteSimReport(a.id, undefined, ["phone"]);
      expect(q).toHaveBeenCalledTimes(1);
      const after = (await pool.query(`SELECT xmin FROM eval_agents WHERE id = $1`, [a.id])).rows[0].xmin;
      expect(after).toBe(before); // the row was not rewritten
    } finally {
      q.mockRestore();
    }
  });

  it("an agent WITHOUT the phone capability keeps its stored sim when it sends no report", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const a = await mkAgent();
    await noteSimReport(a.id, { number: "+15550111003", mcc: "310", mnc: "260" }, ["phone"], { provider: provider() });
    for (const caps of [[], ["analyze"], undefined]) await noteSimReport(a.id, undefined, caps);
    expect((await row(a.id)).sim_carrier).toBe("t-mobile");
  });

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
    await pool.query("UPDATE number_lookups SET looked_up_at = $1 WHERE number_hash = $2", [new Date(Date.now() - CACHE_MAX_AGE_MS - 60_000), numberHash(rep.number)]);
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
    // A day later: within the day a second new number would be rate-limited before any call.
    expect(await refreshAgentSim(a.id, { number: "+15550108882", mcc: "310", mnc: "260" }, { provider: provider(), now: Date.now() + SIM_AGENT_LOOKUP_WINDOW_MS + 1000 })).toBe(true);
    expect(await row(a.id)).toMatchObject({ sim_carrier: null, sim_reason: "v1: lookup-failed", sim_number_redacted: "…8882" });
  });

  it("same number, different codes, then a failure: the answer computed for the OTHER code is not kept", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const a = await mkAgent();
    const n = "+15550108111";
    expect(await refreshAgentSim(a.id, { number: n, mcc: "310", mnc: "260" }, { provider: provider() })).toBe(true);
    expect((await row(a.id)).sim_carrier).toBe("t-mobile");
    // Same number, the phone now reports another code (cache hit, no paid call).
    expect(await refreshAgentSim(a.id, { number: n, mcc: "310", mnc: "240" }, { provider: provider() })).toBe(true);
    expect((await row(a.id)).sim_reason).toBe("v1: mismatch 310-240 vs 310-260");
    // Back to the first code with the cache expired and Twilio failing: the
    // stored answer was for 310-240, so it is not kept as if it were 310-260's.
    await pool.query("UPDATE number_lookups SET looked_up_at = $1 WHERE number_hash = $2", [new Date(Date.now() - CACHE_MAX_AGE_MS - 60_000), numberHash(n)]);
    codes = () => ({ carrier: null, mcc: null, mnc: null, status: 500 });
    expect(await refreshAgentSim(a.id, { number: n, mcc: "310", mnc: "260" }, { provider: provider(), now: Date.now() + SIM_AGENT_LOOKUP_WINDOW_MS + 1000 })).toBe(true);
    expect(await row(a.id)).toMatchObject({ sim_carrier: null, sim_reason: "v1: lookup-failed", sim_number_redacted: "…8111" });
  });

  it("an agent gets one uncached lookup a day: a second new number is rate-limited, with no paid call", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const a = await mkAgent();
    const t0 = noonUtc();
    expect(await refreshAgentSim(a.id, { number: "+15550102001", mcc: "310", mnc: "260" }, { provider: provider(), now: t0 })).toBe(true);
    expect(requests).toHaveLength(1);
    expect(await refreshAgentSim(a.id, { number: "+15550102002", mcc: "310", mnc: "260" }, { provider: provider(), now: t0 + 1000 })).toBe(true);
    expect(requests).toHaveLength(1); // no second paid call
    expect(await row(a.id)).toMatchObject({ sim_carrier: null, sim_reason: "v1: rate-limited", sim_number_redacted: "…2002" });
    // A number already in the cache still answers (cache hits are free and uncounted).
    expect(await refreshAgentSim(a.id, { number: "+15550102001", mcc: "310", mnc: "260" }, { provider: provider(), now: t0 + 2000 })).toBe(true);
    expect((await row(a.id)).sim_carrier).toBe("t-mobile");
    expect(requests).toHaveLength(1);
    // A day later the new number may be looked up.
    expect(await refreshAgentSim(a.id, { number: "+15550102002", mcc: "310", mnc: "260" }, { provider: provider(), now: t0 + SIM_AGENT_LOOKUP_WINDOW_MS + 1000 })).toBe(true);
    expect(requests).toHaveLength(2);
    expect((await row(a.id)).sim_carrier).toBe("t-mobile");
  });

  it("rate-limited keeps a stored answer for the same number and code (like lookup-failed) and is retried", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const a = await mkAgent();
    const t0 = noonUtc();
    const rep = { number: "+15550103001", mcc: "310", mnc: "260" };
    await refreshAgentSim(a.id, { number: "+15550103999", mcc: "310", mnc: "260" }, { provider: provider(), now: t0 }); // today's paid lookup
    expect(requests).toHaveLength(1);
    // rep's number is already cached (free), close to expiry.
    await pool.query(`INSERT INTO number_lookups (number_hash, provider, carrier_name, line_type, value, mcc, mnc, looked_up_at)
      VALUES ($1, 'twilio', 'T-Mobile USA, Inc.', 'mobile', 't-mobile', '310', '260', $2)`, [numberHash(rep.number), new Date(Date.now() - CACHE_MAX_AGE_MS + 3600_000)]);
    expect(await refreshAgentSim(a.id, rep, { provider: provider(), now: t0 + 1000 })).toBe(true);
    expect((await row(a.id)).sim_carrier).toBe("t-mobile");
    // The cache expires within the same day: the refresh would be a second paid call → rate-limited.
    await pool.query("UPDATE number_lookups SET looked_up_at = $1 WHERE number_hash = $2", [new Date(Date.now() - CACHE_MAX_AGE_MS - 60_000), numberHash(rep.number)]);
    const later = t0 + 2 * 3600_000;
    expect(await refreshAgentSim(a.id, rep, { provider: provider(), now: later })).toBe(true);
    expect(requests).toHaveLength(1);
    expect(await row(a.id)).toMatchObject({ sim_carrier: "t-mobile", sim_reason: "v1: sim-match 310-260" });
    // Retried after SIM_RETRY_MS, not a month later.
    expect(await refreshAgentSim(a.id, rep, { provider: provider(), now: later + 1000 })).toBe(false);
    expect(await refreshAgentSim(a.id, rep, { provider: provider(), now: later + SIM_RETRY_MS + 1 })).toBe(true);
  });

  it(`the SIM path draws from its own daily share (SIM_LOOKUPS_PER_DAY = ${SIM_LOOKUPS_PER_DAY}) across agents`, async () => {
    expect(SIM_LOOKUPS_PER_DAY).toBe(200);
    expect(FLOW_LOOKUPS_PER_DAY).toBe(300);
    expect(PAID_LOOKUPS_PER_DAY).toBe(500);
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const [a, b, c] = [await mkAgent(), await mkAgent(), await mkAgent()];
    const t0 = noonUtc();
    const opts = { provider: provider(), now: t0, shareLimit: 2 };
    await refreshAgentSim(a.id, { number: "+15550104001", mcc: "310", mnc: "260" }, opts);
    await refreshAgentSim(b.id, { number: "+15550104002", mcc: "310", mnc: "260" }, opts);
    await refreshAgentSim(c.id, { number: "+15550104003", mcc: "310", mnc: "260" }, opts);
    expect(requests).toHaveLength(2);
    expect((await row(c.id)).sim_reason).toBe("v1: rate-limited");
    // The next day's budget is fresh.
    await refreshAgentSim(c.id, { number: "+15550104003", mcc: "310", mnc: "260" }, { ...opts, now: t0 + 24 * 3600_000 + 1 });
    expect(requests).toHaveLength(3);
    expect((await row(c.id)).sim_carrier).toBe("t-mobile");
  });

  it("a failed provider call is not counted: the retry after SIM_RETRY_MS may call again the same day", async () => {
    codes = () => ({ carrier: null, mcc: null, mnc: null, status: 500 });
    const a = await mkAgent();
    const t0 = noonUtc();
    const rep = { number: "+15550106001", mcc: "310", mnc: "260" };
    expect(await refreshAgentSim(a.id, rep, { provider: provider(), now: t0 })).toBe(true);
    expect((await row(a.id)).sim_reason).toBe("v1: lookup-failed");
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    expect(await refreshAgentSim(a.id, rep, { provider: provider(), now: t0 + SIM_RETRY_MS + 1 })).toBe(true);
    expect(requests).toHaveLength(2);
    expect((await row(a.id)).sim_carrier).toBe("t-mobile");
  });

  it("noteSimReport acts only for agents whose current capabilities include phone", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const a = await mkAgent();
    const sim = { number: "+15550105001", mcc: "310", mnc: "260" };
    for (const caps of [[], ["analyze"], undefined, null, "phone"]) {
      await noteSimReport(a.id, sim, caps, { provider: provider() });
    }
    expect(requests).toHaveLength(0);
    expect((await row(a.id)).sim_reason).toBeNull();
    await noteSimReport(a.id, sim, ["analyze", "phone"], { provider: provider() });
    expect(requests).toHaveLength(1);
    expect((await row(a.id)).sim_carrier).toBe("t-mobile");
  });

  it("expiry runs from the cached lookup's lookedUpAt, not from when it was computed", async () => {
    const a = await mkAgent();
    const rep = { number: "+15550109191", mcc: "310", mnc: "260" };
    // A lookup already 29 days old in the shared cache (e.g. made for a flow's line).
    await pool.query(`INSERT INTO number_lookups (number_hash, provider, carrier_name, line_type, value, mcc, mnc, looked_up_at)
      VALUES ($1, 'twilio', 'T-Mobile USA, Inc.', 'mobile', 't-mobile', '310', '260', $2)`, [numberHash(rep.number), new Date(Date.now() - 29 * 24 * 3600 * 1000)]);
    expect(await refreshAgentSim(a.id, rep, { provider: provider() })).toBe(true);
    expect(requests).toHaveLength(0); // served from the cache
    expect(await refreshAgentSim(a.id, rep, { provider: provider(), now: Date.now() + 12 * 3600 * 1000 })).toBe(false);
    expect(await refreshAgentSim(a.id, rep, { provider: provider(), now: Date.now() + 2 * 24 * 3600 * 1000 })).toBe(true);
  });

  it("the shares are reserved: flow lookups exhausting the flow share never block a SIM check", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const a = await mkAgent();
    const t0 = noonUtc();
    const dial = (n: string) => ({ config: { stepsPrefix: `- type: call.dial\n  number: "${n}"\n` } });
    await lookupFlowLine(dial("+15550107001"), 424242, { provider: provider(), now: t0, shareLimit: 2 });
    await lookupFlowLine(dial("+15550107002"), 424243, { provider: provider(), now: t0, shareLimit: 2 });
    expect(requests).toHaveLength(2);
    // The flow share is spent for every flow caller…
    expect(await flowLookupGate(424244, { now: t0, shareLimit: 2 }).allow()).toBe(false);
    // …yet the SIM check (default SIM share) still gets its paid lookup.
    expect(await refreshAgentSim(a.id, { number: "+15550107003", mcc: "310", mnc: "260" }, { provider: provider(), now: t0 })).toBe(true);
    expect(requests).toHaveLength(3);
    expect((await row(a.id)).sim_carrier).toBe("t-mobile");
    // Each path counts in its own row.
    const usage = (await pool.query(`SELECT scope, count FROM paid_lookup_usage WHERE subject = 'all' ORDER BY scope`)).rows;
    expect(usage).toEqual([{ scope: "global-flow", count: 2 }, { scope: "global-sim", count: 1 }]);
  });

  it("…and the other way round: a spent SIM share never blocks a flow lookup", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const [a, b] = [await mkAgent(), await mkAgent()];
    const t0 = noonUtc();
    await refreshAgentSim(a.id, { number: "+15550108001", mcc: "310", mnc: "260" }, { provider: provider(), now: t0, shareLimit: 1 });
    await refreshAgentSim(b.id, { number: "+15550108002", mcc: "310", mnc: "260" }, { provider: provider(), now: t0, shareLimit: 1 });
    expect((await row(b.id)).sim_reason).toBe("v1: rate-limited");
    const dial = (n: string) => ({ config: { stepsPrefix: `- type: call.dial\n  number: "${n}"\n` } });
    expect(await lookupFlowLine(dial("+15550108003"), 424245, { provider: provider(), now: t0 })).toMatchObject({ value: expect.any(String) });
  });

  it(`one user's agents share SIM_USER_LOOKUPS_PER_DAY (${SIM_USER_LOOKUPS_PER_DAY}) uncached lookups a day, across all their tokens`, async () => {
    expect(SIM_USER_LOOKUPS_PER_DAY).toBe(5);
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const t0 = noonUtc();
    // A second token of the same creator: minting more tokens doesn't multiply the cap.
    const tok2 = await storage.createEvalAgentToken({ name: "sim-tok-2", tokenHash: `sim2-${Date.now()}`, siteId: "na-us-ashburn-01", dispatchTier: "public", createdBy: 1 } as any);
    const agents = [];
    for (let i = 0; i < SIM_USER_LOOKUPS_PER_DAY + 1; i++) {
      agents.push(i % 2 ? await storage.createEvalAgent({ tokenId: tok2.id, name: `sim-u-${Date.now()}-${i}`, siteId: "na-us-ashburn-01", state: "idle", metadata: {} } as any) : await mkAgent());
    }
    for (let i = 0; i < agents.length; i++) {
      await refreshAgentSim(agents[i].id, { number: `+1555011${String(i).padStart(4, "0")}`, mcc: "310", mnc: "260" }, { provider: provider(), now: t0 + i });
    }
    expect(requests).toHaveLength(SIM_USER_LOOKUPS_PER_DAY);
    expect((await row(agents[SIM_USER_LOOKUPS_PER_DAY].id)).sim_reason).toBe("v1: rate-limited");
    // Another user's agent is not held to this user's cap.
    await pool.query(`INSERT INTO users(username,email,plan) VALUES('SimOther','sim-other@test.local','premium')`);
    const otherId = (await pool.query(`SELECT id FROM users WHERE username = 'SimOther'`)).rows[0].id;
    const tok3 = await storage.createEvalAgentToken({ name: "sim-tok-3", tokenHash: `sim3-${Date.now()}`, siteId: "na-us-ashburn-01", dispatchTier: "public", createdBy: otherId } as any);
    const other = await storage.createEvalAgent({ tokenId: tok3.id, name: `sim-o-${Date.now()}`, siteId: "na-us-ashburn-01", state: "idle", metadata: {} } as any);
    await refreshAgentSim(other.id, { number: "+15550119999", mcc: "310", mnc: "260" }, { provider: provider(), now: t0 + 100 });
    expect(requests).toHaveLength(SIM_USER_LOOKUPS_PER_DAY + 1);
    expect((await row(other.id)).sim_carrier).toBe("t-mobile");
  });

  it("stores a keyed hash of the full number (sim_number_hash), never the number", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const a = await mkAgent();
    await refreshAgentSim(a.id, { number: "+15550108765", mcc: "310", mnc: "260" }, { provider: provider() });
    const r = await row(a.id);
    expect(r.sim_number_hash).toBe(numberHash("+15550108765"));
    expect(r.sim_number_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r)).not.toContain("5550108765");
  });

  it("keep-on-failure needs the same FULL number: another number with the same last four digits is not kept", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const a = await mkAgent();
    expect(await refreshAgentSim(a.id, { number: "+15550304444", mcc: "310", mnc: "260" }, { provider: provider() })).toBe(true);
    expect((await row(a.id)).sim_carrier).toBe("t-mobile");
    codes = () => ({ carrier: null, mcc: null, mnc: null, status: 500 });
    // Same last four, same code, a day later (so the agent cap allows the call), Twilio failing.
    expect(await refreshAgentSim(a.id, { number: "+15550404444", mcc: "310", mnc: "260" }, { provider: provider(), now: Date.now() + SIM_AGENT_LOOKUP_WINDOW_MS + 1000 })).toBe(true);
    expect(await row(a.id)).toMatchObject({ sim_carrier: null, sim_reason: "v1: lookup-failed", sim_number_redacted: "…4444", sim_number_hash: numberHash("+15550404444") });
  });

  it("an older row without sim_number_hash is never treated as the same number on failure", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const a = await mkAgent();
    const rep = { number: "+15550305555", mcc: "310", mnc: "260" };
    await refreshAgentSim(a.id, rep, { provider: provider() });
    await pool.query("UPDATE eval_agents SET sim_number_hash = NULL WHERE id = $1", [a.id]);
    await pool.query("UPDATE number_lookups SET looked_up_at = $1 WHERE number_hash = $2", [new Date(Date.now() - CACHE_MAX_AGE_MS - 60_000), numberHash(rep.number)]);
    codes = () => ({ carrier: null, mcc: null, mnc: null, status: 500 });
    resetSimMemo(); // a Core restart: the memo goes, the durable per-agent cap doesn't — so the next day
    expect(await refreshAgentSim(a.id, rep, { provider: provider(), now: Date.now() + SIM_AGENT_LOOKUP_WINDOW_MS + 1000 })).toBe(true);
    expect(await row(a.id)).toMatchObject({ sim_carrier: null, sim_reason: "v1: lookup-failed" });
  });

  // PR #258 round 4: overlapping reports — the latest one wins, whichever finishes last.
  const A_NUM = "+15550401111";
  const B_NUM = "+15550402222";
  const overlapCodes = () => {
    codes = (n) => n === A_NUM
      ? { carrier: "AT&T Wireless", mcc: "310", mnc: "410", delayMs: 300 }
      : { carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" };
  };

  it("report A (slow) then report B (fast), different numbers: the final state is B's — memo and row", async () => {
    overlapCodes();
    const a = await mkAgent();
    const t0 = noonUtc();
    const slow = refreshAgentSim(a.id, { number: A_NUM, mcc: "310", mnc: "410" }, { provider: provider(), now: t0 });
    await new Promise((r) => setTimeout(r, 50));
    // Another agent's day is separate; B is this agent's 2nd uncached number, so lift its per-agent cap.
    await pool.query("DELETE FROM paid_lookup_usage WHERE scope = 'sim-agent'");
    await refreshAgentSim(a.id, { number: B_NUM, mcc: "310", mnc: "260" }, { provider: provider(), now: t0 + 1 });
    expect((await row(a.id)).sim_carrier).toBe("t-mobile");
    await slow;
    expect(await row(a.id)).toMatchObject({ sim_carrier: "t-mobile", sim_reason: "v1: sim-match 310-260", sim_number_hash: numberHash(B_NUM) });
    // The memo is B's too: B's unchanged report is not recomputed, A's is.
    requests.length = 0;
    expect(await refreshAgentSim(a.id, { number: B_NUM, mcc: "310", mnc: "260" }, { provider: provider(), now: t0 + 2 })).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("a report in flight when the phone stops reporting its SIM doesn't resurrect the old carrier", async () => {
    overlapCodes();
    const a = await mkAgent();
    const slow = noteSimReport(a.id, { number: A_NUM, mcc: "310", mnc: "410" }, ["phone"], { provider: provider() });
    await new Promise((r) => setTimeout(r, 50));
    await noteSimReport(a.id, undefined, ["phone"]);
    await slow;
    expect(await row(a.id)).toMatchObject({ sim_carrier: null, sim_reason: NO_SIM_REPORT_REASON, sim_number_hash: null });
  });

  it("…also when the agent was already cleared before that report (the clear still supersedes it)", async () => {
    overlapCodes();
    const a = await mkAgent();
    await noteSimReport(a.id, undefined, ["phone"]);
    expect((await row(a.id)).sim_reason).toBe(NO_SIM_REPORT_REASON);
    const slow = noteSimReport(a.id, { number: A_NUM, mcc: "310", mnc: "410" }, ["phone"], { provider: provider() });
    await new Promise((r) => setTimeout(r, 50));
    await noteSimReport(a.id, undefined, ["phone"]);
    await slow;
    expect(await row(a.id)).toMatchObject({ sim_carrier: null, sim_reason: NO_SIM_REPORT_REASON, sim_number_hash: null });
  });

  it("a newer report starting right after an older one commits keeps the memo: the older never overwrites it", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const a = await mkAgent();
    const t0 = noonUtc();
    // B's number is cached (free, no per-agent cap) so B needs no budget write first.
    await lookupNumber(B_NUM, { provider: provider() });
    const realConnect = pool.connect.bind(pool);
    let bRun: Promise<boolean> | undefined;
    // Start B the moment A's settle transaction releases its client — before A
    // gets to update the memo.
    const spy = vi.spyOn(pool, "connect").mockImplementation(((...args: unknown[]) => {
      // pool.query goes through connect(callback): pass those through untouched.
      if (args.length) return (realConnect as any)(...args);
      return (async () => {
      const client = await realConnect();
      // Only the SIM settle transaction (not the budget's): it reads sim_report_gen.
      let isSettle = false;
      const query = client.query.bind(client) as (...q: unknown[]) => unknown;
      client.query = ((...q: unknown[]) => {
        if (typeof q[0] === "string" && q[0].includes("sim_report_gen")) isSettle = true;
        return query(...q);
      }) as typeof client.query;
      const release = client.release.bind(client);
      client.release = ((e?: Error | boolean) => {
        client.query = query as typeof client.query;
        client.release = release;
        release(e);
        if (isSettle && !bRun) {
          // Synchronously from here up to its first await: B claims the memo now.
          bRun = refreshAgentSim(a.id, { number: B_NUM, mcc: "310", mnc: "260" }, { provider: provider(), now: t0 + 1 });
        }
      }) as typeof client.release;
      return client;
      })();
    }) as any);
    try {
      expect(await refreshAgentSim(a.id, { number: A_NUM, mcc: "310", mnc: "260" }, { provider: provider(), now: t0 })).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // B claimed the memo synchronously at its start, before A resumed: A
    // must not have replaced it, so B's report is deduped while B is in flight.
    expect(bRun).toBeDefined();
    expect(await refreshAgentSim(a.id, { number: B_NUM, mcc: "310", mnc: "260" }, { provider: provider(), now: t0 + 1 })).toBe(false);
    expect(await bRun).toBe(true);
    expect((await row(a.id)).sim_number_hash).toBe(numberHash(B_NUM));
    requests.length = 0;
    expect(await refreshAgentSim(a.id, { number: B_NUM, mcc: "310", mnc: "260" }, { provider: provider(), now: t0 + 2 })).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("holds across processes: a second Core instance's newer report wins over this one's slower, older report", async () => {
    overlapCodes();
    const a = await mkAgent();
    const t0 = noonUtc();
    const slow = refreshAgentSim(a.id, { number: A_NUM, mcc: "310", mnc: "410" }, { provider: provider(), now: t0 });
    await new Promise((r) => setTimeout(r, 50));
    await pool.query("DELETE FROM paid_lookup_usage WHERE scope = 'sim-agent'");
    // A fresh module instance: its own memo, its own pool — another process.
    vi.resetModules();
    const other = await import("../server/sim-carrier");
    const otherNl = await import("../server/number-lookup");
    const otherProvider = new otherNl.TwilioLookupProvider({ accountSid: SID, authToken: "tok", baseUrl });
    await other.refreshAgentSim(a.id, { number: B_NUM, mcc: "310", mnc: "260" }, { provider: otherProvider, now: t0 + 1 });
    await (await import("../server/storage")).pool.end();
    await slow;
    expect(await row(a.id)).toMatchObject({ sim_carrier: "t-mobile", sim_number_hash: numberHash(B_NUM) });
  });

  it("an unchanged report on a heartbeat costs no database query and no lookup", async () => {
    codes = () => ({ carrier: "T-Mobile USA, Inc.", mcc: "310", mnc: "260" });
    const a = await mkAgent();
    const sim = { number: "+15550306666", mcc: "310", mnc: "260" };
    await noteSimReport(a.id, sim, ["phone"], { provider: provider() });
    expect(requests).toHaveLength(1);
    const q = vi.spyOn(pool, "query");
    const c = vi.spyOn(pool, "connect");
    const g = vi.spyOn(storage, "getEvalAgent");
    const u = vi.spyOn(storage, "updateEvalAgent");
    try {
      for (let i = 0; i < 3; i++) await noteSimReport(a.id, sim, ["phone"], { provider: provider() });
      expect(q).not.toHaveBeenCalled();
      expect(c).not.toHaveBeenCalled();
      expect(g).not.toHaveBeenCalled();
      expect(u).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
    } finally {
      q.mockRestore(); c.mockRestore(); g.mockRestore(); u.mockRestore();
    }
  });
});
