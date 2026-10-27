import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Network tags — the `line` number lookup (designs/2026-10-22-network-tags-design.md
// "Number lookup (line)"). A real local HTTP server stands in for Twilio
// Lookup v2 (injected via the provider's baseUrl option — tests never reach
// the real Twilio), over a private, freshly migrated database so the
// `number_lookups` cache and systemConfig rows can't leak into the dev DB.

await vi.hoisted(async () => {
  // Credentials are stored encrypted (like the MaxMind key); the test needs a key.
  if (!/^[0-9a-f]{64}$/i.test(process.env.CREDENTIAL_ENCRYPTION_KEY ?? "")) {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "ab".repeat(32);
  }
  if (process.env.DATABASE_URL) {
    const { prepareIsolatedCoreDb } = await import("./helpers/isolated-core-db");
    process.env.DATABASE_URL = await prepareIsolatedCoreDb(process.env.DATABASE_URL, "vox_test_number_lookup");
  }
});
import { storage, pool } from "../server/storage";
import {
  TwilioLookupProvider,
  lookupFlowLine,
  lookupNumber,
  refreshFlowLineOnSave,
  dialledNumber,
  toE164,
  redactNumber,
  maskAccountSid,
  numberHash,
  validateTwilioCredentialsInput,
  saveTwilioCredentials,
  clearTwilioCredentials,
  getTwilioCredentials,
  defaultLookupProvider,
  CACHE_MAX_AGE_MS,
} from "../server/number-lookup";
import { resetPaidLookupBudget, simLookupGate, flowLookupGate, FLOW_USER_LOOKUPS_PER_DAY, PAID_LOOKUPS_PER_DAY, PAID_LOOKUP_WINDOW_MS } from "../server/paid-lookup-budget";
import type { EvalFlow } from "../shared/schema";

const SID = "AC" + "0123456789abcdef0123456789abcdef";
/** The flow editor a lookup is charged to (the per-user cap); no DB row needed. */
const USER = 900_001;
const TOKEN = "test-auth-token-value";

// ---- Twilio stub -----------------------------------------------------------

interface StubReply { status: number; body: unknown }
const requests: Array<{ path: string; auth: string | undefined }> = [];
let reply: (e164: string) => StubReply = () => ({ status: 500, body: {} });
/** How long the stub waits before answering (lets concurrent callers overlap). */
let delayMs = 0;
let server: http.Server;
let baseUrl = "";

function twilioOk(e164: string, carrier: string | null, type: string | null): StubReply {
  return {
    status: 200,
    body: {
      phone_number: e164, valid: true,
      line_type_intelligence: { carrier_name: carrier, type, mobile_country_code: "310", mobile_network_code: "100", error_code: null },
    },
  };
}

function provider(): TwilioLookupProvider {
  return new TwilioLookupProvider({ accountSid: SID, authToken: TOKEN, baseUrl });
}

const phoneFlow = (stepsPrefix: string, extra: Record<string, unknown> = {}) => ({
  transport: "phone",
  config: { stepsPrefix, stepsSuffix: "- type: call.hangup\n", ...extra },
});

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ path: req.url ?? "", auth: req.headers.authorization });
    const m = /^\/v2\/PhoneNumbers\/([^?]+)/.exec(req.url ?? "");
    const r = reply(decodeURIComponent(m?.[1] ?? ""));
    setTimeout(() => {
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.body));
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (hasDb) await pool.end();
});

beforeEach(async () => {
  requests.length = 0;
  delayMs = 0;
  resetPaidLookupBudget();
  reply = () => ({ status: 500, body: {} });
  if (hasDb) await pool.query("DELETE FROM number_lookups");
});

// ---- pure helpers ----------------------------------------------------------

describe("number helpers (pure)", () => {
  it("normalizes to E.164 and refuses anything without a leading +", () => {
    expect(toE164("+1 (555) 010-1234")).toBe("+15550101234");
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(toE164("5550101234")).toBeNull();
    expect(toE164("+0123456")).toBeNull();
    expect(toE164("+1 abc")).toBeNull();
  });

  it("redacts to the last four digits", () => {
    expect(redactNumber("+15550101234")).toBe("…1234");
  });

  it("masks an Account SID and validates credentials input", () => {
    expect(maskAccountSid(SID)).toBe("AC…cdef");
    expect(validateTwilioCredentialsInput({ accountSid: SID, authToken: TOKEN })).toEqual({ ok: true, accountSid: SID, authToken: TOKEN });
    expect(validateTwilioCredentialsInput({ accountSid: "AC123", authToken: TOKEN }).ok).toBe(false);
    expect(validateTwilioCredentialsInput({ accountSid: "XX" + SID.slice(2), authToken: TOKEN }).ok).toBe(false);
    expect(validateTwilioCredentialsInput({ accountSid: SID, authToken: "  " }).ok).toBe(false);
    expect(validateTwilioCredentialsInput({}).ok).toBe(false);
  });

  it("extracts the call.dial number, filling ${config.*} from the flow's own config", () => {
    expect(dialledNumber(phoneFlow('- type: call.dial\n  number: "+1 (555) 010-1234"\n').config))
      .toEqual({ number: "+15550101234" });
    expect(dialledNumber(phoneFlow('- type: call.dial\n  number: "${config.agentNumber}"\n', { agentNumber: "+15550109999" }).config))
      .toEqual({ number: "+15550109999" });
    // A config key the flow doesn't define stays unresolved → no number.
    expect(dialledNumber(phoneFlow('- type: call.dial\n  number: "${config.missing}"\n').config))
      .toEqual({ skipped: "no-number" });
    expect(dialledNumber(phoneFlow("- type: call.wait_answered\n").config)).toEqual({ skipped: "no-number" });
    expect(dialledNumber({})).toEqual({ skipped: "no-number" });
  });

  it("a number held in a secret — directly or through a config value — is skipped as `secret`", () => {
    expect(dialledNumber(phoneFlow('- type: call.dial\n  number: "${secrets.AGENT_NUMBER}"\n').config))
      .toEqual({ skipped: "secret" });
    expect(dialledNumber(phoneFlow('- type: call.dial\n  number: "${config.n}"\n', { n: "${secrets.AGENT_NUMBER}" }).config))
      .toEqual({ skipped: "secret" });
  });
});

// ---- provider + lookupFlowLine over a real DB ---------------------------------

d("lookupFlowLine (stub Twilio, isolated DB)", () => {
  it("maps the carrier, sends Basic auth + Fields=line_type_intelligence, and caches the row", async () => {
    reply = (n) => twilioOk(n, "Bandwidth.com CLEC", "nonFixedVoip");
    const r = await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+1 (555) 010-1234"\n'), USER, { provider: provider() });
    expect(r).toMatchObject({ value: "bandwidth", carrierName: "Bandwidth.com CLEC", lineType: "nonFixedVoip", number: "…1234" });
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe("/v2/PhoneNumbers/%2B15550101234?Fields=line_type_intelligence");
    expect(requests[0].auth).toBe("Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64"));
    const row = await pool.query("SELECT * FROM number_lookups WHERE number = $1", ["+15550101234"]);
    expect(row.rows[0]).toMatchObject({ provider: "twilio", carrier_name: "Bandwidth.com CLEC", line_type: "nonFixedVoip", value: "bandwidth" });
  });

  it("reuses a cached answer younger than 30 days — no second HTTP call, even from another flow", async () => {
    reply = (n) => twilioOk(n, "Twilio - SMS/MMS-SVR", "nonFixedVoip");
    const a = await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550102222"\n'), USER, { provider: provider() });
    const b = await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "${config.n}"\n', { n: "+1 555 010 2222" }), USER, { provider: provider() });
    expect(a).toMatchObject({ value: "twilio" });
    expect(b).toMatchObject({ value: "twilio", number: "…2222" });
    expect(requests).toHaveLength(1);
  });

  it("refreshes an answer older than 30 days and updates the row", async () => {
    reply = (n) => twilioOk(n, "Twilio - SMS/MMS-SVR", "nonFixedVoip");
    await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550103333"\n'), USER, { provider: provider() });
    await pool.query("UPDATE number_lookups SET looked_up_at = $1 WHERE number = $2",
      [new Date(Date.now() - CACHE_MAX_AGE_MS - 60_000), "+15550103333"]);
    reply = (n) => twilioOk(n, "Telnyx", "nonFixedVoip");
    const r = await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550103333"\n'), USER, { provider: provider() });
    expect(r).toMatchObject({ value: "telnyx", carrierName: "Telnyx" });
    expect(requests).toHaveLength(2);
    const row = await pool.query("SELECT value, looked_up_at FROM number_lookups WHERE number = $1", ["+15550103333"]);
    expect(row.rows[0].value).toBe("telnyx");
    expect(Date.now() - new Date(row.rows[0].looked_up_at).getTime()).toBeLessThan(60_000);
  });

  it("stores the number's MCC/MNC from line_type_intelligence", async () => {
    reply = (n) => twilioOk(n, "T-Mobile USA, Inc.", "mobile");
    await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550109999"\n'), USER, { provider: provider() });
    const row = await pool.query("SELECT mcc, mnc FROM number_lookups WHERE number = $1", ["+15550109999"]);
    expect(row.rows[0]).toEqual({ mcc: "310", mnc: "100" });
  });

  it("drops a malformed MCC/MNC rather than storing it", async () => {
    reply = (n) => ({ status: 200, body: { phone_number: n, valid: true, line_type_intelligence: { carrier_name: "X", type: "mobile", mobile_country_code: "31a", mobile_network_code: "1234" } } });
    await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550109998"\n'), USER, { provider: provider() });
    const row = await pool.query("SELECT mcc, mnc FROM number_lookups WHERE number = $1", ["+15550109998"]);
    expect(row.rows[0]).toEqual({ mcc: null, mnc: null });
  });

  it("lookupNumber: cache-first, shared with the line path, returns the codes", async () => {
    reply = (n) => twilioOk(n, "T-Mobile USA, Inc.", "mobile");
    const a = await lookupNumber("+15550201111", { provider: provider() });
    expect(a).toMatchObject({ carrierName: "T-Mobile USA, Inc.", lineType: "mobile", mcc: "310", mnc: "100" });
    const b = await lookupNumber("+15550201111", { provider: provider() });
    expect(b).toMatchObject({ mcc: "310", mnc: "100" });
    expect(requests).toHaveLength(1);
    expect(await lookupNumber("+15550201112", { provider: null })).toEqual({ skipped: "not-configured" });
    reply = () => ({ status: 404, body: {} });
    expect(await lookupNumber("+15550201113", { provider: provider() })).toEqual({ skipped: "invalid-number" });
    reply = () => ({ status: 500, body: {} });
    expect(await lookupNumber("+15550201114", { provider: provider() })).toEqual({ skipped: "failed" });
  });

  it("never sends a number held in a secret", async () => {
    reply = (n) => twilioOk(n, "Twilio - SMS/MMS-SVR", "nonFixedVoip");
    const r = await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "${secrets.AGENT_NUMBER}"\n'), USER, { provider: provider() });
    expect(r).toEqual({ skipped: "secret" });
    const r2 = await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "${config.n}"\n', { n: "${secrets.AGENT_NUMBER}" }), USER, { provider: provider() });
    expect(r2).toEqual({ skipped: "secret" });
    expect(requests).toHaveLength(0);
  });

  it("toll-free (null carrier) → no-carrier, cached so the paid lookup isn't repeated", async () => {
    reply = (n) => twilioOk(n, null, "tollFree");
    const flow = phoneFlow('- type: call.dial\n  number: "+18005550100"\n');
    expect(await lookupFlowLine(flow, USER, { provider: provider() })).toEqual({ skipped: "no-carrier" });
    expect(await lookupFlowLine(flow, USER, { provider: provider() })).toEqual({ skipped: "no-carrier" });
    expect(requests).toHaveLength(1);
  });

  it("HTTP 500 → failed, nothing cached", async () => {
    reply = () => ({ status: 500, body: { message: "boom" } });
    const r = await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550104444"\n'), USER, { provider: provider() });
    expect(r).toEqual({ skipped: "failed" });
    const row = await pool.query("SELECT 1 FROM number_lookups WHERE number = $1", ["+15550104444"]);
    expect(row.rowCount).toBe(0);
  });

  it("404 / valid:false → invalid-number", async () => {
    reply = () => ({ status: 404, body: { code: 20404 } });
    expect(await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550105555"\n'), USER, { provider: provider() }))
      .toEqual({ skipped: "invalid-number" });
    reply = (n) => ({ status: 200, body: { phone_number: n, valid: false, line_type_intelligence: null } });
    expect(await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550106666"\n'), USER, { provider: provider() }))
      .toEqual({ skipped: "invalid-number" });
  });

  it("an unreachable service → failed (never throws)", async () => {
    const dead = new TwilioLookupProvider({ accountSid: SID, authToken: TOKEN, baseUrl: "http://127.0.0.1:1" });
    expect(await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550107777"\n'), USER, { provider: dead }))
      .toEqual({ skipped: "failed" });
  });

  it("no credentials configured → not-configured (and no HTTP)", async () => {
    await clearTwilioCredentials();
    expect(await defaultLookupProvider()).toBeNull();
    expect(await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550108888"\n'), USER)).toEqual({ skipped: "not-configured" });
    expect(requests).toHaveLength(0);
  });

  it("credentials round-trip encrypted through systemConfig", async () => {
    await saveTwilioCredentials({ accountSid: SID, authToken: TOKEN });
    const raw = await storage.getConfig("twilio_lookup_credentials");
    expect(raw?.value).toBeTruthy();
    expect(raw!.value).not.toContain(TOKEN);
    expect(raw!.value).not.toContain(SID);
    expect(await getTwilioCredentials()).toEqual({ accountSid: SID, authToken: TOKEN });
    expect((await defaultLookupProvider())?.name).toBe("twilio");
    await clearTwilioCredentials();
    expect(await getTwilioCredentials()).toBeNull();
  });
});

// ---- the save-time trigger ---------------------------------------------------

d("refreshFlowLineOnSave (stub Twilio, isolated DB)", () => {
  let ownerId = 0;
  let providerId = "";

  beforeAll(async () => {
    const stamp = `${Date.now()}`;
    const u = await pool.query(
      "INSERT INTO users (username, email, plan) VALUES ($1, $2, 'premium') RETURNING id",
      [`nl${stamp}`, `nl${stamp}@example.com`],
    );
    ownerId = u.rows[0].id;
    const providers = await storage.getAllProviders();
    providerId = providers[0].id;
  });

  async function mkFlow(transport: string, stepsPrefix: string): Promise<EvalFlow> {
    return storage.createEvalFlow({
      name: `nl-${Date.now()}`, ownerId, providerId, visibility: "public", isMainline: false,
      transport, config: { stepsPrefix, stepsSuffix: "- type: call.hangup\n" },
    });
  }

  it("stores a successful lookup on the flow", async () => {
    reply = (n) => twilioOk(n, "Bandwidth/13", "nonFixedVoip");
    const flow = await mkFlow("phone", '- type: call.dial\n  number: "+15550201111"\n');
    const r = await refreshFlowLineOnSave(flow, ownerId, { provider: provider() });
    expect(r).toMatchObject({ value: "bandwidth", number: "…1111" });
    expect((await storage.getEvalFlow(flow.id))?.lineLookup).toMatchObject({ value: "bandwidth", number: "…1111" });
  });

  it("does nothing for a web flow, or when the dialled number is unchanged", async () => {
    reply = (n) => twilioOk(n, "Telnyx", "nonFixedVoip");
    const web = await mkFlow("web", "");
    expect(await refreshFlowLineOnSave(web, ownerId, { provider: provider() })).toBeUndefined();
    const flow = await mkFlow("phone", '- type: call.dial\n  number: "+15550202222"\n');
    await refreshFlowLineOnSave(flow, ownerId, { provider: provider() });
    const again = (await storage.getEvalFlow(flow.id))!;
    requests.length = 0;
    await pool.query("DELETE FROM number_lookups");
    expect(await refreshFlowLineOnSave(again, ownerId, { provider: provider() })).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("a changed number that can't be looked up clears the stale answer", async () => {
    reply = (n) => twilioOk(n, "Telnyx", "nonFixedVoip");
    const flow = await mkFlow("phone", '- type: call.dial\n  number: "+15550203333"\n');
    await refreshFlowLineOnSave(flow, ownerId, { provider: provider() });
    const changed = (await storage.updateEvalFlow(flow.id, {
      config: { stepsPrefix: '- type: call.dial\n  number: "${secrets.N}"\n' },
    }))!;
    expect(await refreshFlowLineOnSave(changed, ownerId, { provider: provider() })).toBeNull();
    expect((await storage.getEvalFlow(flow.id))?.lineLookup).toBeNull();
  });

  it("a failed lookup never throws out of the save path", async () => {
    reply = () => ({ status: 500, body: {} });
    const flow = await mkFlow("phone", '- type: call.dial\n  number: "+15550204444"\n');
    await expect(refreshFlowLineOnSave(flow, ownerId, { provider: provider() })).resolves.toBeUndefined();
    expect((await storage.getEvalFlow(flow.id))?.lineLookup).toBeNull();
  });
});

// ---- the full number's keyed hash (PR #258 finding 2) -------------------------

describe("numberHash (pure)", () => {
  it("is a 64-hex keyed hash of the FULL number: same last four digits, different hash; never the number itself", () => {
    const a = numberHash("+15550301234")!;
    const b = numberHash("+15550401234")!;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(numberHash("+15550301234")).toBe(a);
    expect(a).not.toContain("5550301234");
  });

  it("is keyed: a different server key gives a different hash", () => {
    const before = numberHash("+15550301234");
    const saved = process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY = "cd".repeat(32);
    try {
      expect(numberHash("+15550301234")).not.toBe(before);
    } finally {
      process.env.CREDENTIAL_ENCRYPTION_KEY = saved;
    }
  });
});

d("refreshFlowLineOnSave compares the full number, not its last four digits", () => {
  let ownerId = 0;
  let providerId = "";
  beforeAll(async () => {
    const stamp = `${Date.now()}h`;
    const u = await pool.query(
      "INSERT INTO users (username, email, plan) VALUES ($1, $2, 'premium') RETURNING id",
      [`nlh${stamp}`, `nlh${stamp}@example.com`],
    );
    ownerId = u.rows[0].id;
    providerId = (await storage.getAllProviders())[0].id;
  });
  const dial = (n: string) => `- type: call.dial\n  number: "${n}"\n`;
  const mkFlow = (stepsPrefix: string) => storage.createEvalFlow({
    name: `nlh-${Date.now()}`, ownerId, providerId, visibility: "public", isMainline: false,
    transport: "phone", config: { stepsPrefix, stepsSuffix: "- type: call.hangup\n" },
  });

  it("stores numberHash with the redacted number — the full number appears nowhere on the flow", async () => {
    reply = (n) => twilioOk(n, "Telnyx", "nonFixedVoip");
    const flow = await mkFlow(dial("+15550305678"));
    await refreshFlowLineOnSave(flow, ownerId, { provider: provider() });
    const row = (await pool.query("SELECT line_lookup FROM eval_flows WHERE id = $1", [flow.id])).rows[0];
    expect(row.line_lookup).toMatchObject({ number: "…5678", numberHash: numberHash("+15550305678") });
    expect(JSON.stringify(row)).not.toContain("5550305678");
  });

  it("a different number with the same last four digits is re-looked up — the old carrier isn't kept", async () => {
    reply = (n) => twilioOk(n, n === "+15550301234" ? "Telnyx" : "Bandwidth/13", "nonFixedVoip");
    const flow = await mkFlow(dial("+15550301234"));
    expect(await refreshFlowLineOnSave(flow, ownerId, { provider: provider() })).toMatchObject({ value: "telnyx", number: "…1234" });
    const changed = (await storage.updateEvalFlow(flow.id, { config: { stepsPrefix: dial("+15550401234") } }))!;
    expect(await refreshFlowLineOnSave(changed, ownerId, { provider: provider() })).toMatchObject({ value: "bandwidth", number: "…1234" });
    expect(requests).toHaveLength(2);
    expect((await storage.getEvalFlow(flow.id))?.lineLookup).toMatchObject({ value: "bandwidth", numberHash: numberHash("+15550401234") });
  });

  it("the same number is not re-looked up", async () => {
    reply = (n) => twilioOk(n, "Telnyx", "nonFixedVoip");
    const flow = await mkFlow(dial("+15550302222"));
    await refreshFlowLineOnSave(flow, ownerId, { provider: provider() });
    const again = (await storage.getEvalFlow(flow.id))!;
    requests.length = 0;
    expect(await refreshFlowLineOnSave(again, ownerId, { provider: provider() })).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("an older lookup without numberHash counts as changed: re-looked up (from the cache — free) and stamped", async () => {
    reply = (n) => twilioOk(n, "Telnyx", "nonFixedVoip");
    const flow = await mkFlow(dial("+15550303333"));
    await refreshFlowLineOnSave(flow, ownerId, { provider: provider() });
    const { numberHash: _drop, ...legacy } = (await storage.getEvalFlow(flow.id))!.lineLookup!;
    const old = (await storage.updateEvalFlow(flow.id, { lineLookup: legacy }))!;
    requests.length = 0;
    const r = await refreshFlowLineOnSave(old, ownerId, { provider: provider() });
    expect(r).toMatchObject({ value: "telnyx", numberHash: numberHash("+15550303333") });
    expect(requests).toHaveLength(0); // the cached answer, no paid call
  });

  it("an older lookup without numberHash: a failed re-lookup keeps it when the last four match, clears it when they don't", async () => {
    reply = (n) => twilioOk(n, "Telnyx", "nonFixedVoip");
    const flow = await mkFlow(dial("+15550307777"));
    await refreshFlowLineOnSave(flow, ownerId, { provider: provider() });
    const { numberHash: _drop, ...legacy } = (await storage.getEvalFlow(flow.id))!.lineLookup!;
    const old = (await storage.updateEvalFlow(flow.id, { lineLookup: legacy }))!;
    await pool.query("DELETE FROM number_lookups");
    reply = () => ({ status: 500, body: {} });
    expect(await refreshFlowLineOnSave(old, ownerId, { provider: provider() })).toBeUndefined();
    expect((await storage.getEvalFlow(flow.id))!.lineLookup).toEqual(legacy);
    // Different number (different last four), lookup failing: cleared as before.
    const moved = (await storage.updateEvalFlow(flow.id, { config: { stepsPrefix: dial("+15550308888") } }))!;
    expect(await refreshFlowLineOnSave(moved, ownerId, { provider: provider() })).toBeNull();
  });
});

// ---- paid-lookup caps + single-flight (PR #258 finding 1) ----------------------

d("flow-path paid-lookup caps and single-flight (stub Twilio)", () => {
  let ownerId = 0;
  let providerId = "";
  beforeAll(async () => {
    const stamp = `${Date.now()}c`;
    const u = await pool.query(
      "INSERT INTO users (username, email, plan) VALUES ($1, $2, 'premium') RETURNING id",
      [`nlc${stamp}`, `nlc${stamp}@example.com`],
    );
    ownerId = u.rows[0].id;
    providerId = (await storage.getAllProviders())[0].id;
  });
  const dial = (n: string) => `- type: call.dial\n  number: "${n}"\n`;
  const num = (i: number) => `+1555060${String(i).padStart(4, "0")}`;

  it(`a user's ${FLOW_USER_LOOKUPS_PER_DAY + 1}th new number in a day is rate-limited: no provider call, the old lookup kept`, async () => {
    expect(FLOW_USER_LOOKUPS_PER_DAY).toBe(10);
    reply = (n) => twilioOk(n, n === num(0) ? "Telnyx" : "Bandwidth/13", "nonFixedVoip");
    const t0 = Date.now();
    const flow = await storage.createEvalFlow({
      name: `nlc-${Date.now()}`, ownerId, providerId, visibility: "public", isMainline: false,
      transport: "phone", config: { stepsPrefix: dial(num(0)), stepsSuffix: "- type: call.hangup\n" },
    });
    await refreshFlowLineOnSave(flow, ownerId, { provider: provider(), now: t0 });
    for (let i = 1; i < FLOW_USER_LOOKUPS_PER_DAY; i++) {
      expect(await lookupFlowLine({ config: { stepsPrefix: dial(num(i)) } }, ownerId, { provider: provider(), now: t0 + i })).toMatchObject({ value: "bandwidth" });
    }
    expect(requests).toHaveLength(FLOW_USER_LOOKUPS_PER_DAY);
    const before = (await storage.getEvalFlow(flow.id))!.lineLookup;
    expect(before).toMatchObject({ value: "telnyx" });

    // The 11th new number: a save keeps the stored lookup untouched…
    const changed = (await storage.updateEvalFlow(flow.id, { config: { stepsPrefix: dial(num(99)) } }))!;
    expect(await refreshFlowLineOnSave(changed, ownerId, { provider: provider(), now: t0 + 100 })).toBeUndefined();
    expect((await storage.getEvalFlow(flow.id))!.lineLookup).toEqual(before);
    // …and "Look up again" says why, never `failed`.
    expect(await lookupFlowLine(changed, ownerId, { provider: provider(), now: t0 + 101 })).toEqual({ skipped: "rate-limited" });
    expect(requests).toHaveLength(FLOW_USER_LOOKUPS_PER_DAY);

    // Cache hits never count: an already-looked-up number still answers, free.
    expect(await lookupFlowLine({ config: { stepsPrefix: dial(num(3)) } }, ownerId, { provider: provider(), now: t0 + 102 })).toMatchObject({ value: "bandwidth" });
    expect(requests).toHaveLength(FLOW_USER_LOOKUPS_PER_DAY);

    // Another editor isn't held to this user's cap.
    expect(await lookupFlowLine(changed, ownerId + 1_000_000, { provider: provider(), now: t0 + 103 })).toMatchObject({ value: "bandwidth" });
    expect(requests).toHaveLength(FLOW_USER_LOOKUPS_PER_DAY + 1);
    // A day later the user may look up again.
    expect(await lookupFlowLine({ config: { stepsPrefix: dial(num(98)) } }, ownerId, { provider: provider(), now: t0 + PAID_LOOKUP_WINDOW_MS + 1 })).toMatchObject({ value: "bandwidth" });
  });

  it("a failed provider call is refunded: ten failures don't use up the day", async () => {
    reply = () => ({ status: 500, body: {} });
    const t0 = Date.now();
    for (let i = 0; i < FLOW_USER_LOOKUPS_PER_DAY; i++) {
      expect(await lookupFlowLine({ config: { stepsPrefix: dial(num(200 + i)) } }, ownerId, { provider: provider(), now: t0 })).toEqual({ skipped: "failed" });
    }
    reply = (n) => twilioOk(n, "Telnyx", "nonFixedVoip");
    expect(await lookupFlowLine({ config: { stepsPrefix: dial(num(300)) } }, ownerId, { provider: provider(), now: t0 + 1 })).toMatchObject({ value: "telnyx" });
    expect(requests).toHaveLength(FLOW_USER_LOOKUPS_PER_DAY + 1);
  });

  it(`flow and SIM lookups draw from ONE global daily budget (PAID_LOOKUPS_PER_DAY = ${PAID_LOOKUPS_PER_DAY})`, async () => {
    expect(PAID_LOOKUPS_PER_DAY).toBe(500);
    reply = (n) => twilioOk(n, "Telnyx", "nonFixedVoip");
    const t0 = Date.now();
    const globalLimit = 2;
    expect(await lookupFlowLine({ config: { stepsPrefix: dial(num(400)) } }, ownerId, { provider: provider(), now: t0, globalLimit })).toMatchObject({ value: "telnyx" });
    expect(await lookupNumber(num(401), { provider: provider(), gate: simLookupGate(7001, { now: t0, globalLimit }) })).toMatchObject({ value: "telnyx" });
    // The budget is spent — for either path.
    expect(await lookupNumber(num(402), { provider: provider(), gate: simLookupGate(7002, { now: t0, globalLimit }) })).toEqual({ skipped: "rate-limited" });
    expect(await lookupFlowLine({ config: { stepsPrefix: dial(num(403)) } }, ownerId + 5, { provider: provider(), now: t0, globalLimit })).toEqual({ skipped: "rate-limited" });
    expect(requests).toHaveLength(2);
  });

  it("concurrent cache misses for one number share ONE provider call (and one charge)", async () => {
    reply = (n) => twilioOk(n, "Telnyx", "nonFixedVoip");
    delayMs = 50;
    const t0 = Date.now();
    const flow = { config: { stepsPrefix: dial(num(500)) } };
    const results = await Promise.all(Array.from({ length: 5 }, () => lookupFlowLine(flow, ownerId, { provider: provider(), now: t0 })));
    expect(requests).toHaveLength(1);
    for (const r of results) expect(r).toMatchObject({ value: "telnyx", number: "…0500" });
    // Charged once: nine more new numbers fit in the user's day.
    delayMs = 0;
    for (let i = 1; i < FLOW_USER_LOOKUPS_PER_DAY; i++) {
      expect(await lookupFlowLine({ config: { stepsPrefix: dial(num(500 + i)) } }, ownerId, { provider: provider(), now: t0 })).toMatchObject({ value: "telnyx" });
    }
    expect(await lookupFlowLine({ config: { stepsPrefix: dial(num(599)) } }, ownerId, { provider: provider(), now: t0 })).toEqual({ skipped: "rate-limited" });
  });

  it("a caller that joined another's rate-limited lookup tries again under its own cap", async () => {
    reply = (n) => twilioOk(n, "Telnyx", "nonFixedVoip");
    const t0 = Date.now();
    const spent = flowLookupGate(ownerId, { now: t0 });
    for (let i = 0; i < FLOW_USER_LOOKUPS_PER_DAY; i++) expect(spent.allow()).toBe(true);
    const flow = { config: { stepsPrefix: dial(num(600)) } };
    const [limited, other] = await Promise.all([
      lookupFlowLine(flow, ownerId, { provider: provider(), now: t0 }),
      lookupFlowLine(flow, ownerId + 2_000_000, { provider: provider(), now: t0 }),
    ]);
    expect(limited).toEqual({ skipped: "rate-limited" });
    expect(other).toMatchObject({ value: "telnyx" });
    expect(requests).toHaveLength(1);
  });
});
