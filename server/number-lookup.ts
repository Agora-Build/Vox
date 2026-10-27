/**
 * The `line` number lookup (designs/2026-10-22-network-tags-design.md
 * "Number lookup (line)").
 *
 * For a PHONE eval flow, the number its `call.dial` Setup step dials is the
 * voice agent's own number; the carrier behind it (Twilio, Bandwidth, ...) is
 * the flow's `line` tag. Core asks a lookup service when the flow is saved and
 * its dialled number changed, caches the answer per number for 30 days in
 * `number_lookups` (shared across flows and owners — about one paid lookup per
 * number per month), and stores the mapped answer on `eval_flows.line_lookup`.
 *
 * Rules that must hold:
 * - A number held in a secret (`${secrets.*}`, directly or through a
 *   `${config.*}` value) is NEVER sent: secrets don't leave Vox. Only a literal
 *   number or one filled from the flow's own config is looked up.
 * - A lookup never fails a save: every path returns a result, never throws.
 * - The Twilio Auth Token is never logged or returned; credentials live
 *   encrypted in `systemConfig`, exactly like the MaxMind key.
 * - Only the last four digits of a number leave `number_lookups`, plus a
 *   keyed hash (`numberHash`) used to tell whether a number changed.
 * - Paid lookups are capped (server/paid-lookup-budget.ts): per flow editor,
 *   per SIM agent, and one global daily budget shared by both paths.
 */
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { numberLookups, type EvalFlow } from "@shared/schema";
import { lineFromCarrier, type LineLookup } from "@shared/tags";
import { walkStepList } from "@shared/steps";
import { fillJobPlaceholders, jobConfigVars } from "@shared/placeholders";
import { db, storage, encryptValue, decryptValue, isEncryptionConfigured, parseStepsScript } from "./storage";
import { flowLookupGate, type PaidLookupGate } from "./paid-lookup-budget";

export const LOOKUP_TIMEOUT_MS = 10_000;
export const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const TWILIO_CONFIG_KEY = "twilio_lookup_credentials";
/** Mobile country code: 3 digits. Mobile network code: 2 or 3 digits. */
export const MCC_RE = /^[0-9]{3}$/;
export const MNC_RE = /^[0-9]{2,3}$/;
const TWILIO_BASE_URL = "https://lookups.twilio.com";

export type LineSkipReason =
  | "not-configured" // no lookup credentials — `line` is manual only
  | "secret"         // the number is held in a secret — never sent
  | "no-number"      // no call.dial, or its number doesn't resolve to E.164
  | "invalid-number" // the service says the number doesn't exist (404 / valid:false)
  | "no-carrier"     // no carrier for this number (toll-free and similar)
  | "rate-limited"   // over a paid-lookup cap (server/paid-lookup-budget.ts) — non-definitive, keeps what's stored
  | "failed";        // network, timeout, non-2xx, unreadable answer
export type LineLookupResult = LineLookup | { skipped: LineSkipReason };

/** What a lookup service answered for one E.164 number. */
export type ProviderAnswer =
  | { kind: "ok"; carrierName: string | null; lineType: string | null; mcc?: string | null; mnc?: string | null }
  | { kind: "invalid-number" }
  | { kind: "failed"; reason: string };

/** A lookup service. One implementation today (Twilio); a second is additive. */
export interface NumberLookupProvider {
  name: string;
  lookup(e164: string): Promise<ProviderAnswer>;
}

/**
 * Twilio Lookup v2, `Fields=line_type_intelligence`. `baseUrl` exists ONLY so
 * tests can point at a local stub server — production always uses Twilio's
 * URL (there is deliberately no env var for it).
 */
export class TwilioLookupProvider implements NumberLookupProvider {
  readonly name = "twilio";
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: { accountSid: string; authToken: string; baseUrl?: string; timeoutMs?: number }) {
    this.accountSid = opts.accountSid;
    this.authToken = opts.authToken;
    this.baseUrl = (opts.baseUrl ?? TWILIO_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  }

  async lookup(e164: string): Promise<ProviderAnswer> {
    const url = `${this.baseUrl}/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`;
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: "Basic " + Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64"),
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 404) return { kind: "invalid-number" };
      if (!res.ok) return { kind: "failed", reason: `HTTP ${res.status}` };
      const body = (await res.json()) as {
        valid?: boolean;
        line_type_intelligence?: {
          carrier_name?: string | null; type?: string | null;
          mobile_country_code?: string | null; mobile_network_code?: string | null;
        } | null;
      };
      if (body?.valid === false) return { kind: "invalid-number" };
      const lti = body?.line_type_intelligence ?? null;
      return {
        kind: "ok",
        carrierName: typeof lti?.carrier_name === "string" && lti.carrier_name.trim() ? lti.carrier_name : null,
        lineType: typeof lti?.type === "string" ? lti.type.slice(0, 32) : null,
        // The number's network code — what a SIM operator's MCC-MNC is
        // matched against (server/sim-carrier.ts). Malformed → null.
        mcc: typeof lti?.mobile_country_code === "string" && MCC_RE.test(lti.mobile_country_code) ? lti.mobile_country_code : null,
        mnc: typeof lti?.mobile_network_code === "string" && MNC_RE.test(lti.mobile_network_code) ? lti.mobile_network_code : null,
      };
    } catch (err) {
      // The URL holds the number but never a credential (Basic auth header).
      return { kind: "failed", reason: err instanceof Error ? err.name : "error" };
    }
  }
}

// ---- credentials (mirror of the MaxMind key in server/geoip-refresh.ts) ----

const ACCOUNT_SID_RE = /^AC[0-9a-f]{32}$/i;

export function validateTwilioCredentialsInput(
  body: unknown,
): { ok: true; accountSid: string; authToken: string } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const accountSid = typeof b.accountSid === "string" ? b.accountSid.trim() : "";
  const authToken = typeof b.authToken === "string" ? b.authToken.trim() : "";
  if (!ACCOUNT_SID_RE.test(accountSid)) {
    return { ok: false, error: "accountSid must be a Twilio Account SID (AC followed by 32 hex characters)" };
  }
  if (!authToken) return { ok: false, error: "authToken is required" };
  if (!isEncryptionConfigured()) {
    return { ok: false, error: "Set CREDENTIAL_ENCRYPTION_KEY on the server to store Twilio credentials from the admin console." };
  }
  return { ok: true, accountSid, authToken };
}

export function maskAccountSid(sid: string): string {
  return `${sid.slice(0, 2)}…${sid.slice(-4)}`;
}

export async function saveTwilioCredentials(creds: { accountSid: string; authToken: string }): Promise<void> {
  // One encrypted blob: the SID isn't secret, but keeping the pair together
  // means it can never be half-written.
  await storage.setConfig({
    key: TWILIO_CONFIG_KEY,
    value: encryptValue(JSON.stringify({ accountSid: creds.accountSid, authToken: creds.authToken })),
  });
}

export async function clearTwilioCredentials(): Promise<void> {
  await storage.deleteConfig(TWILIO_CONFIG_KEY);
}

export async function getTwilioCredentials(): Promise<{ accountSid: string; authToken: string } | null> {
  try {
    const row = await storage.getConfig(TWILIO_CONFIG_KEY);
    if (!row?.value) return null;
    const parsed = JSON.parse(decryptValue(row.value)) as { accountSid?: unknown; authToken?: unknown };
    if (typeof parsed.accountSid !== "string" || typeof parsed.authToken !== "string") return null;
    return { accountSid: parsed.accountSid, authToken: parsed.authToken };
  } catch (err) {
    // E.g. CREDENTIAL_ENCRYPTION_KEY rotated — lookup is simply off.
    console.error(`[number-lookup] stored Twilio credentials could not be read (${err instanceof Error ? err.name : "error"})`);
    return null;
  }
}

/** The configured provider, or null when no credentials are set (lookup off). */
export async function defaultLookupProvider(): Promise<NumberLookupProvider | null> {
  const creds = await getTwilioCredentials();
  return creds ? new TwilioLookupProvider(creds) : null;
}

// ---- number extraction -------------------------------------------------------

/** `+` then 7–15 digits, no leading zero; separators (space, (), -, .) dropped. */
export function toE164(raw: string): string | null {
  const s = raw.trim();
  if (!s.startsWith("+")) return null;
  const rest = s.slice(1);
  if (/[^0-9 ().-]/.test(rest)) return null;
  const digits = rest.replace(/[^0-9]/g, "");
  return /^[1-9][0-9]{6,14}$/.test(digits) ? `+${digits}` : null;
}

export function redactNumber(e164: string): string {
  return `…${e164.replace(/[^0-9]/g, "").slice(-4)}`;
}

const NUMBER_HASH_LABEL = "vox/number-hash/v1";

/**
 * A keyed hash of the full E.164 number (hex HMAC-SHA256), stored next to the
 * redacted display value so "is this the same number?" compares the whole
 * number, not its last four digits — without storing the number. Keyed with a
 * server secret (CREDENTIAL_ENCRYPTION_KEY, else SESSION_SECRET) through a
 * fixed label, so the low-entropy number space can't be brute-forced from a
 * leaked row. Null when the server has neither secret: every comparison then
 * counts as "changed", and the cache-first lookup keeps that cheap. Rotating
 * the key does the same, once.
 */
export function numberHash(e164: string): string | null {
  const keyHex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  const base = keyHex && /^[0-9a-f]{64}$/i.test(keyHex) ? Buffer.from(keyHex, "hex") : process.env.SESSION_SECRET || null;
  if (!base) return null;
  const key = createHmac("sha256", base).update(NUMBER_HASH_LABEL).digest();
  return createHmac("sha256", key).update(e164).digest("hex");
}

/**
 * The E.164 number a flow's Setup dials, filled from the flow's OWN config
 * only — or why there isn't one we may send. Uses the same filling function
 * the agent fills a job with (shared/placeholders.ts), so `${config.*}`
 * resolves exactly as it will at run time.
 */
export function dialledNumber(config: unknown): { number: string } | { skipped: "secret" | "no-number" } {
  const cfg = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  const setup = parseStepsScript(cfg.stepsPrefix);
  let dial: Record<string, unknown> | undefined;
  walkStepList(setup, (step) => {
    if (step.type === "call.dial") { dial = step; return "found"; }
    return null;
  });
  if (!dial || typeof dial.number !== "string") return { skipped: "no-number" };

  let number: unknown;
  try {
    const filled = fillJobPlaceholders(
      { scenario: null, stepsPrefix: [{ number: dial.number }], stepsSuffix: null },
      jobConfigVars(cfg),
      {}, // no secrets: a secret-held number is never resolved, only detected
      { evalSetSecrets: false },
    );
    // Any secret reference — written directly, or arriving through a config
    // value — means the real number lives in a secret.
    if (filled.unsupplied.length > 0) return { skipped: "secret" };
    number = (filled.parts.stepsPrefix as Array<{ number: unknown }>)[0]?.number;
  } catch {
    return { skipped: "no-number" };
  }
  if (typeof number !== "string") return { skipped: "no-number" };
  // Backstop for a malformed reference the placeholder regex doesn't parse.
  if (number.includes("${secrets.")) return { skipped: "secret" };
  const e164 = toE164(number);
  return e164 ? { number: e164 } : { skipped: "no-number" };
}

// ---- lookup ------------------------------------------------------------------

/** One number's cached answer (a `number_lookups` row, as returned to callers). */
export interface NumberAnswer {
  carrierName: string | null;
  lineType: string | null;
  /** The mapped `line` value (lineFromCarrier); null = no carrier. */
  value: string | null;
  mcc: string | null;
  mnc: string | null;
  lookedUpAt: Date;
}
export type NumberLookupResult = NumberAnswer | { skipped: "not-configured" | "invalid-number" | "failed" | "rate-limited" };

/**
 * In-flight lookups by number (single-flight): concurrent callers for the
 * same E.164 share ONE cache read + provider call instead of each missing the
 * cache and each paying. Removed when settled.
 */
const inflight = new Map<string, Promise<NumberLookupResult>>();

/**
 * Look one E.164 number up — cache-first (`number_lookups`, CACHE_MAX_AGE_MS),
 * else the provider, writing the answer back. Shared by the flow `line` path
 * and our own SIM's number (server/sim-carrier.ts): same provider, cache and
 * credentials. Never throws; never logs the full number.
 * `provider` undefined = the configured one (null when no credentials).
 *
 * A caller that joins another's in-flight lookup gets its answer and is not
 * charged; if that answer was `rate-limited` (the OTHER caller's cap), it
 * tries again under its own gate.
 */
export async function lookupNumber(
  e164: string,
  opts: {
    provider?: NumberLookupProvider | null;
    /**
     * Asked right before a PAID provider call (never for a cache hit); a
     * refusal → `{ skipped: "rate-limited" }` and no call. Refunded when the
     * provider call fails (server/paid-lookup-budget.ts).
     */
    gate?: PaidLookupGate;
  } = {},
): Promise<NumberLookupResult> {
  try {
    const provider = opts.provider !== undefined ? opts.provider : await defaultLookupProvider();
    if (!provider) return { skipped: "not-configured" };

    for (;;) {
      const pending = inflight.get(e164);
      if (!pending) break;
      const shared = await pending;
      if (!("skipped" in shared && shared.skipped === "rate-limited")) return shared;
    }
    const run = lookupOnce(e164, provider, opts.gate);
    inflight.set(e164, run);
    try {
      return await run;
    } finally {
      if (inflight.get(e164) === run) inflight.delete(e164);
    }
  } catch (err) {
    console.warn(`[number-lookup] lookup failed (${err instanceof Error ? err.name : "error"})`);
    return { skipped: "failed" };
  }
}

/** One cache read + (gated) provider call + idempotent cache upsert. Never throws. */
async function lookupOnce(e164: string, provider: NumberLookupProvider, gate: PaidLookupGate | undefined): Promise<NumberLookupResult> {
  let charged = false;
  try {
    const [cached] = await db.select().from(numberLookups).where(eq(numberLookups.number, e164));
    if (cached && Date.now() - cached.lookedUpAt.getTime() < CACHE_MAX_AGE_MS) {
      return { carrierName: cached.carrierName, lineType: cached.lineType, value: cached.value, mcc: cached.mcc, mnc: cached.mnc, lookedUpAt: cached.lookedUpAt };
    }
    if (gate) {
      if (!gate.allow()) return { skipped: "rate-limited" };
      charged = true;
    }

    const answer = await provider.lookup(e164);
    if (answer.kind === "invalid-number") return { skipped: "invalid-number" };
    if (answer.kind === "failed") {
      if (charged) gate!.refund();
      console.warn(`[number-lookup] ${provider.name} lookup for ${redactNumber(e164)} failed: ${answer.reason}`);
      return { skipped: "failed" };
    }

    const row = {
      number: e164,
      provider: provider.name,
      carrierName: answer.carrierName,
      lineType: answer.lineType,
      // No carrier (toll-free…) is cached too, as value null: the answer
      // won't change within the month, and each lookup is paid.
      value: lineFromCarrier(answer.carrierName) ?? null,
      mcc: answer.mcc ?? null,
      mnc: answer.mnc ?? null,
      lookedUpAt: new Date(),
    };
    // Idempotent: a second writer for the same number just refreshes the row.
    await db.insert(numberLookups).values(row).onConflictDoUpdate({
      target: numberLookups.number,
      set: { provider: row.provider, carrierName: row.carrierName, lineType: row.lineType, value: row.value, mcc: row.mcc, mnc: row.mnc, lookedUpAt: row.lookedUpAt },
    });
    return { carrierName: row.carrierName, lineType: row.lineType, value: row.value, mcc: row.mcc, mnc: row.mnc, lookedUpAt: row.lookedUpAt };
  } catch (err) {
    // A thrown error (a DB failure, an unexpected provider throw): refunded —
    // under-counting one call beats blocking the retry for a day.
    if (charged) gate!.refund();
    console.warn(`[number-lookup] lookup failed (${err instanceof Error ? err.name : "error"})`);
    return { skipped: "failed" };
  }
}

/**
 * Look up the line provider behind a flow's dialled number. Never throws.
 * `requestedBy` is the flow editor making the request: their uncached
 * lookups are capped (FLOW_USER_LOOKUPS_PER_DAY) and drawn from the global
 * paid-lookup budget (server/paid-lookup-budget.ts).
 * `provider` undefined = the configured one (null when no credentials);
 * tests inject a TwilioLookupProvider pointed at a stub. `now`/`globalLimit`
 * are for tests.
 */
export async function lookupFlowLine(
  flow: { config: unknown },
  requestedBy: number,
  opts: { provider?: NumberLookupProvider | null; now?: number; globalLimit?: number } = {},
): Promise<LineLookupResult> {
  let dialled: ReturnType<typeof dialledNumber>;
  try {
    dialled = dialledNumber(flow.config);
  } catch {
    return { skipped: "failed" };
  }
  if ("skipped" in dialled) return dialled;
  const e164 = dialled.number;
  const answer = await lookupNumber(e164, {
    provider: opts.provider,
    gate: flowLookupGate(requestedBy, { now: opts.now, globalLimit: opts.globalLimit }),
  });
  if ("skipped" in answer) return { skipped: answer.skipped };
  if (!answer.value) return { skipped: "no-carrier" };
  const hash = numberHash(e164);
  return {
    value: answer.value,
    carrierName: answer.carrierName,
    lineType: answer.lineType,
    lookedUpAt: answer.lookedUpAt.toISOString(),
    number: redactNumber(e164),
    ...(hash ? { numberHash: hash } : {}),
  };
}

/**
 * Save-time trigger: after a phone flow is created or edited, look its line
 * up when the dialled number differs from the one `line_lookup` describes
 * (compared by `numberHash`, the keyed hash of the full number — a lookup
 * without one, from before it existed, counts as changed; the re-lookup is
 * cache-first, so normally free) or there is no lookup yet. For such an older
 * lookup whose last four digits still match, a non-answer (lookup off /
 * failed) keeps it rather than clearing it.
 *
 * Returns the flow's new `lineLookup` when it changed (an object, or null
 * when a CHANGED number can't be looked up — the old answer described a
 * number the flow no longer dials, so it's cleared rather than frozen onto
 * future jobs), or undefined when nothing was written. `rate-limited` (the
 * editor or the day is over its paid-lookup cap) is not an answer: the
 * stored lookup is left exactly as it was. Never throws, and gives up after
 * LOOKUP_TIMEOUT_MS so a save is never held longer.
 *
 * A flow whose transport moved away from phone keeps its line_lookup, and
 * buildJobSnapshot still copies it onto that flow's web jobs: harmless, as
 * the claim emits a detected `line` only for a job whose stamped
 * `eval_jobs.transport` is phone (server/job-tags.ts).
 */
export async function refreshFlowLineOnSave(
  flow: Pick<EvalFlow, "id" | "transport" | "config" | "lineLookup">,
  requestedBy: number,
  opts: { provider?: NumberLookupProvider | null; now?: number; globalLimit?: number } = {},
): Promise<LineLookup | null | undefined> {
  try {
    if (flow.transport !== "phone") return undefined;
    const dialled = dialledNumber(flow.config);
    const current = flow.lineLookup ?? null;
    const dialledHash = "number" in dialled ? numberHash(dialled.number) : null;
    const sameNumber = !!dialledHash && !!current?.numberHash && current.numberHash === dialledHash;
    if (sameNumber) return undefined;
    // A lookup stored before numberHash existed, whose last four digits still
    // match: re-looked up (cache-first), but only a definitive answer replaces
    // it — "couldn't ask right now" proves nothing about the number.
    const maybeSameLegacy = !!current && !current.numberHash && "number" in dialled && current.number === redactNumber(dialled.number);

    const result = await Promise.race([
      lookupFlowLine(flow, requestedBy, opts),
      new Promise<{ skipped: "failed" }>((resolve) => setTimeout(() => resolve({ skipped: "failed" }), LOOKUP_TIMEOUT_MS).unref()),
    ]);
    if ("skipped" in result) {
      if (result.skipped === "rate-limited") return undefined;
      if (current === null) return undefined;
      if (maybeSameLegacy && (result.skipped === "not-configured" || result.skipped === "failed")) return undefined;
      await storage.updateEvalFlow(flow.id, { lineLookup: null });
      return null;
    }
    await storage.updateEvalFlow(flow.id, { lineLookup: result });
    return result;
  } catch (err) {
    console.warn(`[number-lookup] save-time lookup for flow ${flow.id} failed (${err instanceof Error ? err.name : "error"})`);
    return undefined;
  }
}
