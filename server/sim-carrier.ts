/**
 * `sim` — our own phone's SIM carrier, detected on both sides and matched
 * (designs/2026-10-22-network-tags-design.md "`sim` is system-only — detected
 * on both sides, must match").
 *
 * A phone agent reports, on register/heartbeat, `sim: { number, mcc, mnc,
 * operatorName? }` — our SIM's own number and the operator network code the
 * phone reads from the SIM (via DialF `sims.list`). Core looks the number up
 * (server/number-lookup.ts `lookupNumber`: same provider, cache and
 * credentials as the flow `line` lookup) and compares NETWORK CODES, never
 * names:
 *   - match    → `sim_carrier` = the lookup's carrier name mapped to its radio
 *                network (`simFromCarrier`: an MVNO SIM such as Mint and its
 *                number both carry the host network's code → `t-mobile`);
 *   - anything else (mismatch, no operator from the phone, lookup off or
 *     failed, no codes in the answer) → `sim_carrier` NULL. Never a guess.
 * The reason (`sim_reason`) says which, with the matcher version.
 *
 * Rules that must hold:
 * - The full number is never stored on the agent (only `sim_number_redacted`,
 *   "…1234") and never logged; it lives only as the `number_lookups` key.
 * - Never blocks a heartbeat: routes call `noteSimReport`, fire-and-forget.
 * - Recomputed only when the report changes, the 30-day lookup cache expires,
 *   or a non-definitive answer (lookup off / failed / rate-limited) is due a retry.
 * - Only phone agents' reports count, and the paid lookup is capped (one
 *   uncached number per agent per day, SIM_LOOKUPS_PER_DAY overall).
 *
 * Limit (from the design): both inputs arrive through the agent; a modified
 * agent could report another real number plus its matching code. The lookup
 * can't invent a carrier, but it can't prove which SIM is in the phone.
 */
import { createHash } from "node:crypto";
import { normalizeTag, simFromCarrier } from "@shared/tags";
import { storage } from "./storage";
import { lookupNumber, redactNumber, CACHE_MAX_AGE_MS, MCC_RE, MNC_RE, type NumberLookupProvider } from "./number-lookup";

export const SIM_MATCHER_VERSION = "v1";
/** A non-definitive answer (lookup off / failed / rate-limited) is retried after this long. */
export const SIM_RETRY_MS = 10 * 60 * 1000;
/**
 * Spending caps on the paid lookup. Both inputs come from the agent, so any
 * token holder could report a fresh valid number every heartbeat and make
 * each one a paid Twilio call. A real SIM's number doesn't change: one
 * uncached lookup per agent per day is plenty, and the whole SIM path may
 * spend at most SIM_LOOKUPS_PER_DAY a day. Past either cap the answer is a
 * non-definitive `rate-limited` (handled like `lookup-failed`). Cache hits
 * (`number_lookups`) are never counted. In memory: a Core restart resets them.
 */
export const SIM_AGENT_LOOKUP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SIM_LOOKUPS_PER_DAY = 500;

const E164_RE = /^\+[1-9][0-9]{6,14}$/;
const MAX_OPERATOR_NAME = 64;

export interface SimReport {
  number: string;
  mcc?: string;
  mnc?: string;
  operatorName?: string;
}

/**
 * Strict parse of a register/heartbeat body's `sim`. No (or a malformed)
 * E.164 number → `undefined` (nothing reported). Codes are kept only as a
 * valid pair — an MCC without an MNC can't be compared. Never throws.
 */
export function parseSimReport(raw: unknown): SimReport | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.number !== "string" || !E164_RE.test(o.number)) return undefined;
  const report: SimReport = { number: o.number };
  if (typeof o.mcc === "string" && MCC_RE.test(o.mcc) && typeof o.mnc === "string" && MNC_RE.test(o.mnc)) {
    report.mcc = o.mcc;
    report.mnc = o.mnc;
  }
  if (typeof o.operatorName === "string" && o.operatorName.trim()) {
    report.operatorName = o.operatorName.trim().slice(0, MAX_OPERATOR_NAME);
  }
  return report;
}

export interface SimMatch {
  simCarrier: string | null;
  simReason: string;
  simNumberRedacted: string;
}

const reason = (s: string) => `${SIM_MATCHER_VERSION}: ${s}`;

/** Compare the phone's SIM operator code with a lookup of the SIM's number. Never throws. */
export async function computeSimMatch(
  report: SimReport,
  opts: { provider?: NumberLookupProvider | null } = {},
): Promise<SimMatch> {
  return (await computeSimMatchDetailed(report, opts)).match;
}

/** computeSimMatch plus when the lookup it used was made (undefined: no lookup answer). */
async function computeSimMatchDetailed(
  report: SimReport,
  opts: { provider?: NumberLookupProvider | null; allowProviderCall?: () => boolean },
): Promise<{ match: SimMatch; lookedUpAt?: Date }> {
  const simNumberRedacted = redactNumber(report.number);
  const none = (why: string, lookedUpAt?: Date) => ({ match: { simCarrier: null, simReason: reason(why), simNumberRedacted }, lookedUpAt });

  // Nothing to compare against — don't spend a paid lookup.
  if (!report.mcc || !report.mnc) return none("no-sim-operator");

  const answer = await lookupNumber(report.number, opts);
  if ("skipped" in answer) {
    if (answer.skipped === "not-configured") return none("lookup-off");
    if (answer.skipped === "invalid-number") return none("invalid-number");
    if (answer.skipped === "rate-limited") return none("rate-limited");
    return none("lookup-failed");
  }
  const at = answer.lookedUpAt;
  if (!answer.mcc || !answer.mnc) return none("no-lookup-codes", at);

  const phoneCode = `${report.mcc}-${report.mnc}`;
  const lookupCode = `${answer.mcc}-${answer.mnc}`;
  if (phoneCode !== lookupCode) return none(`mismatch ${phoneCode} vs ${lookupCode}`, at);

  const slug = simFromCarrier(answer.carrierName);
  const tag = slug ? normalizeTag({ key: "sim", value: slug }) : undefined;
  if (!tag || "error" in tag) return none(`no-lookup-carrier ${phoneCode}`, at);
  return { match: { simCarrier: tag.value, simReason: reason(`sim-match ${phoneCode}`), simNumberRedacted }, lookedUpAt: at };
}

// ---- per-agent recompute memo ------------------------------------------------

/**
 * What each agent's sim fields were last computed from: a hash of the report
 * (never the number itself) and when it is next due. A definitive answer is
 * due when the lookup it used expires — CACHE_MAX_AGE_MS after that lookup's
 * `lookedUpAt`, not after the compute, so a cached answer can't be held for
 * up to twice the cache age; a non-definitive one (lookup off / failed) is
 * retried after SIM_RETRY_MS.
 * In memory: after a Core restart every agent recomputes once — cheap, since
 * the lookup itself is cached in `number_lookups`.
 */
const memo = new Map<number, { fingerprint: string; dueAt: number }>();

/** Tests only: forget every agent's last computation and the spending caps. */
export function resetSimMemo(): void {
  memo.clear();
  agentPaidLookupAt.clear();
  budget = { windowStart: 0, used: 0 };
}

function fingerprintOf(report: SimReport): string {
  return createHash("sha256").update(`${report.number}|${report.mcc ?? ""}|${report.mnc ?? ""}`).digest("hex");
}

const NON_DEFINITIVE = new Set([reason("lookup-off"), reason("lookup-failed"), reason("rate-limited")]);
/** Non-definitive answers that keep a stored answer for the same report. */
const KEEPS_STORED = new Set([reason("lookup-failed"), reason("rate-limited")]);

/** When each agent last caused a paid lookup, and the global day's count. */
const agentPaidLookupAt = new Map<number, number>();
let budget = { windowStart: 0, used: 0 };

/**
 * The spending gate for one agent at `now`. `allow` reserves the call (so
 * concurrent reports can't both pass); `refund` hands it back when the
 * provider call failed — a failed lookup answers nothing, and the retry after
 * SIM_RETRY_MS must not wait a day.
 */
function paidLookupGate(agentId: number, now: number, lookupsPerDay: number) {
  let reserved: { prev: number | undefined } | null = null;
  return {
    allow: (): boolean => {
      const last = agentPaidLookupAt.get(agentId);
      if (last !== undefined && now - last < SIM_AGENT_LOOKUP_WINDOW_MS) return false;
      if (now - budget.windowStart >= 24 * 60 * 60 * 1000) budget = { windowStart: now, used: 0 };
      if (budget.used >= lookupsPerDay) return false;
      budget.used++;
      reserved = { prev: last };
      agentPaidLookupAt.set(agentId, now);
      return true;
    },
    refund: (): void => {
      if (!reserved) return;
      if (budget.used > 0) budget.used--;
      if (reserved.prev === undefined) agentPaidLookupAt.delete(agentId);
      else agentPaidLookupAt.set(agentId, reserved.prev);
      reserved = null;
    },
  };
}

/**
 * Whether the agent's stored sim fields were computed for this same report:
 * the redacted number matches and the stored reason names the same phone
 * code (`sim-match <code>` / `mismatch <code> vs …`). The stored row is the
 * source of truth here, so this also holds after a Core restart.
 */
function storedIsForReport(
  stored: { simNumberRedacted: string | null; simReason: string | null } | undefined,
  report: SimReport,
): boolean {
  if (!stored || !report.mcc || !report.mnc) return false;
  if (stored.simNumberRedacted !== redactNumber(report.number)) return false;
  const code = `${report.mcc}-${report.mnc}`;
  return stored.simReason === reason(`sim-match ${code}`) || (stored.simReason ?? "").startsWith(reason(`mismatch ${code} vs `));
}

/**
 * Recompute and store an agent's sim fields when due. Returns whether it
 * recomputed. `now` and `lookupsPerDay` exist for tests (expiry / retry
 * without waiting; the daily budget without 500 lookups).
 *
 * A transient lookup failure never wipes a definitive answer for the same
 * number and code: phone jobs claimed before the retry would otherwise
 * freeze with no `sim`, permanently. The stored fields are kept and the
 * retry stays scheduled; definitive answers (match, mismatch, lookup off,
 * no operator…) always overwrite.
 */
export async function refreshAgentSim(
  agentId: number,
  report: SimReport,
  opts: { provider?: NumberLookupProvider | null; now?: number; lookupsPerDay?: number } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const fingerprint = fingerprintOf(report);
  const prev = memo.get(agentId);
  if (prev && prev.fingerprint === fingerprint && now < prev.dueAt) return false;
  // Claimed before the await, so a burst of heartbeats computes once.
  memo.set(agentId, { fingerprint, dueAt: now + SIM_RETRY_MS });
  try {
    const gate = paidLookupGate(agentId, now, opts.lookupsPerDay ?? SIM_LOOKUPS_PER_DAY);
    const { match, lookedUpAt } = await computeSimMatchDetailed(report, { provider: opts.provider, allowProviderCall: gate.allow });
    if (match.simReason === reason("lookup-failed")) gate.refund();
    const definitive = !NON_DEFINITIVE.has(match.simReason);
    const dueAt = !definitive
      ? now + SIM_RETRY_MS
      : (lookedUpAt ? lookedUpAt.getTime() : now) + CACHE_MAX_AGE_MS;
    memo.set(agentId, { fingerprint, dueAt });
    if (KEEPS_STORED.has(match.simReason) && storedIsForReport(await storage.getEvalAgent(agentId), report)) {
      return true; // keep the stored answer; the retry is scheduled above
    }
    await storage.updateEvalAgent(agentId, {
      simCarrier: match.simCarrier,
      simReason: match.simReason,
      simNumberRedacted: match.simNumberRedacted,
    });
    return true;
  } catch (err) {
    memo.delete(agentId);
    throw err;
  }
}

/**
 * Route entry point (register/heartbeat): parse the body's `sim` and, when it
 * is a report from an agent whose current capabilities include `phone` (only
 * a phone agent has a SIM — anyone else's report is ignored, never looked
 * up), refresh in the background. Never blocks, never throws, never logs the
 * number. The returned promise (always resolved) exists for tests; routes
 * don't wait on it.
 */
export function noteSimReport(
  agentId: number,
  raw: unknown,
  capabilities: unknown,
  opts: { provider?: NumberLookupProvider | null; now?: number } = {},
): Promise<void> {
  if (!Array.isArray(capabilities) || !capabilities.includes("phone")) return Promise.resolve();
  const report = parseSimReport(raw);
  if (!report) return Promise.resolve();
  return refreshAgentSim(agentId, report, opts).then(() => undefined, (err) =>
    console.error(`[sim] agent ${agentId}: sim check failed (${err instanceof Error ? err.name : "error"})`),
  );
}
