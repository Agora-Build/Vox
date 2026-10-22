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
  validateTwilioCredentialsInput,
  saveTwilioCredentials,
  clearTwilioCredentials,
  getTwilioCredentials,
  defaultLookupProvider,
  CACHE_MAX_AGE_MS,
} from "../server/number-lookup";
import type { EvalFlow } from "../shared/schema";

const SID = "AC" + "0123456789abcdef0123456789abcdef";
const TOKEN = "test-auth-token-value";

// ---- Twilio stub -----------------------------------------------------------

interface StubReply { status: number; body: unknown }
const requests: Array<{ path: string; auth: string | undefined }> = [];
let reply: (e164: string) => StubReply = () => ({ status: 500, body: {} });
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
    res.writeHead(r.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(r.body));
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
    const r = await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+1 (555) 010-1234"\n'), { provider: provider() });
    expect(r).toMatchObject({ value: "bandwidth", carrierName: "Bandwidth.com CLEC", lineType: "nonFixedVoip", number: "…1234" });
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe("/v2/PhoneNumbers/%2B15550101234?Fields=line_type_intelligence");
    expect(requests[0].auth).toBe("Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64"));
    const row = await pool.query("SELECT * FROM number_lookups WHERE number = $1", ["+15550101234"]);
    expect(row.rows[0]).toMatchObject({ provider: "twilio", carrier_name: "Bandwidth.com CLEC", line_type: "nonFixedVoip", value: "bandwidth" });
  });

  it("reuses a cached answer younger than 30 days — no second HTTP call, even from another flow", async () => {
    reply = (n) => twilioOk(n, "Twilio - SMS/MMS-SVR", "nonFixedVoip");
    const a = await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550102222"\n'), { provider: provider() });
    const b = await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "${config.n}"\n', { n: "+1 555 010 2222" }), { provider: provider() });
    expect(a).toMatchObject({ value: "twilio" });
    expect(b).toMatchObject({ value: "twilio", number: "…2222" });
    expect(requests).toHaveLength(1);
  });

  it("refreshes an answer older than 30 days and updates the row", async () => {
    reply = (n) => twilioOk(n, "Twilio - SMS/MMS-SVR", "nonFixedVoip");
    await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550103333"\n'), { provider: provider() });
    await pool.query("UPDATE number_lookups SET looked_up_at = $1 WHERE number = $2",
      [new Date(Date.now() - CACHE_MAX_AGE_MS - 60_000), "+15550103333"]);
    reply = (n) => twilioOk(n, "Telnyx", "nonFixedVoip");
    const r = await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550103333"\n'), { provider: provider() });
    expect(r).toMatchObject({ value: "telnyx", carrierName: "Telnyx" });
    expect(requests).toHaveLength(2);
    const row = await pool.query("SELECT value, looked_up_at FROM number_lookups WHERE number = $1", ["+15550103333"]);
    expect(row.rows[0].value).toBe("telnyx");
    expect(Date.now() - new Date(row.rows[0].looked_up_at).getTime()).toBeLessThan(60_000);
  });

  it("stores the number's MCC/MNC from line_type_intelligence", async () => {
    reply = (n) => twilioOk(n, "T-Mobile USA, Inc.", "mobile");
    await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550109999"\n'), { provider: provider() });
    const row = await pool.query("SELECT mcc, mnc FROM number_lookups WHERE number = $1", ["+15550109999"]);
    expect(row.rows[0]).toEqual({ mcc: "310", mnc: "100" });
  });

  it("drops a malformed MCC/MNC rather than storing it", async () => {
    reply = (n) => ({ status: 200, body: { phone_number: n, valid: true, line_type_intelligence: { carrier_name: "X", type: "mobile", mobile_country_code: "31a", mobile_network_code: "1234" } } });
    await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550109998"\n'), { provider: provider() });
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
    const r = await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "${secrets.AGENT_NUMBER}"\n'), { provider: provider() });
    expect(r).toEqual({ skipped: "secret" });
    const r2 = await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "${config.n}"\n', { n: "${secrets.AGENT_NUMBER}" }), { provider: provider() });
    expect(r2).toEqual({ skipped: "secret" });
    expect(requests).toHaveLength(0);
  });

  it("toll-free (null carrier) → no-carrier, cached so the paid lookup isn't repeated", async () => {
    reply = (n) => twilioOk(n, null, "tollFree");
    const flow = phoneFlow('- type: call.dial\n  number: "+18005550100"\n');
    expect(await lookupFlowLine(flow, { provider: provider() })).toEqual({ skipped: "no-carrier" });
    expect(await lookupFlowLine(flow, { provider: provider() })).toEqual({ skipped: "no-carrier" });
    expect(requests).toHaveLength(1);
  });

  it("HTTP 500 → failed, nothing cached", async () => {
    reply = () => ({ status: 500, body: { message: "boom" } });
    const r = await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550104444"\n'), { provider: provider() });
    expect(r).toEqual({ skipped: "failed" });
    const row = await pool.query("SELECT 1 FROM number_lookups WHERE number = $1", ["+15550104444"]);
    expect(row.rowCount).toBe(0);
  });

  it("404 / valid:false → invalid-number", async () => {
    reply = () => ({ status: 404, body: { code: 20404 } });
    expect(await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550105555"\n'), { provider: provider() }))
      .toEqual({ skipped: "invalid-number" });
    reply = (n) => ({ status: 200, body: { phone_number: n, valid: false, line_type_intelligence: null } });
    expect(await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550106666"\n'), { provider: provider() }))
      .toEqual({ skipped: "invalid-number" });
  });

  it("an unreachable service → failed (never throws)", async () => {
    const dead = new TwilioLookupProvider({ accountSid: SID, authToken: TOKEN, baseUrl: "http://127.0.0.1:1" });
    expect(await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550107777"\n'), { provider: dead }))
      .toEqual({ skipped: "failed" });
  });

  it("no credentials configured → not-configured (and no HTTP)", async () => {
    await clearTwilioCredentials();
    expect(await defaultLookupProvider()).toBeNull();
    expect(await lookupFlowLine(phoneFlow('- type: call.dial\n  number: "+15550108888"\n'))).toEqual({ skipped: "not-configured" });
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
    const r = await refreshFlowLineOnSave(flow, { provider: provider() });
    expect(r).toMatchObject({ value: "bandwidth", number: "…1111" });
    expect((await storage.getEvalFlow(flow.id))?.lineLookup).toMatchObject({ value: "bandwidth", number: "…1111" });
  });

  it("does nothing for a web flow, or when the dialled number is unchanged", async () => {
    reply = (n) => twilioOk(n, "Telnyx", "nonFixedVoip");
    const web = await mkFlow("web", "");
    expect(await refreshFlowLineOnSave(web, { provider: provider() })).toBeUndefined();
    const flow = await mkFlow("phone", '- type: call.dial\n  number: "+15550202222"\n');
    await refreshFlowLineOnSave(flow, { provider: provider() });
    const again = (await storage.getEvalFlow(flow.id))!;
    requests.length = 0;
    await pool.query("DELETE FROM number_lookups");
    expect(await refreshFlowLineOnSave(again, { provider: provider() })).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("a changed number that can't be looked up clears the stale answer", async () => {
    reply = (n) => twilioOk(n, "Telnyx", "nonFixedVoip");
    const flow = await mkFlow("phone", '- type: call.dial\n  number: "+15550203333"\n');
    await refreshFlowLineOnSave(flow, { provider: provider() });
    const changed = (await storage.updateEvalFlow(flow.id, {
      config: { stepsPrefix: '- type: call.dial\n  number: "${secrets.N}"\n' },
    }))!;
    expect(await refreshFlowLineOnSave(changed, { provider: provider() })).toBeNull();
    expect((await storage.getEvalFlow(flow.id))?.lineLookup).toBeNull();
  });

  it("a failed lookup never throws out of the save path", async () => {
    reply = () => ({ status: 500, body: {} });
    const flow = await mkFlow("phone", '- type: call.dial\n  number: "+15550204444"\n');
    await expect(refreshFlowLineOnSave(flow, { provider: provider() })).resolves.toBeUndefined();
    expect((await storage.getEvalFlow(flow.id))?.lineLookup).toBeNull();
  });
});
