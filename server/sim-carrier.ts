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
 *   or a non-definitive answer (lookup off / failed) is due a retry.
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
/** A non-definitive answer (lookup off / failed) is retried after this long. */
export const SIM_RETRY_MS = 10 * 60 * 1000;

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
  const simNumberRedacted = redactNumber(report.number);
  const none = (why: string): SimMatch => ({ simCarrier: null, simReason: reason(why), simNumberRedacted });

  // Nothing to compare against — don't spend a paid lookup.
  if (!report.mcc || !report.mnc) return none("no-sim-operator");

  const answer = await lookupNumber(report.number, opts);
  if ("skipped" in answer) {
    if (answer.skipped === "not-configured") return none("lookup-off");
    if (answer.skipped === "invalid-number") return none("invalid-number");
    return none("lookup-failed");
  }
  if (!answer.mcc || !answer.mnc) return none("no-lookup-codes");

  const phoneCode = `${report.mcc}-${report.mnc}`;
  const lookupCode = `${answer.mcc}-${answer.mnc}`;
  if (phoneCode !== lookupCode) return none(`mismatch ${phoneCode} vs ${lookupCode}`);

  const slug = simFromCarrier(answer.carrierName);
  const tag = slug ? normalizeTag({ key: "sim", value: slug }) : undefined;
  if (!tag || "error" in tag) return none(`no-lookup-carrier ${phoneCode}`);
  return { simCarrier: tag.value, simReason: reason(`sim-match ${phoneCode}`), simNumberRedacted };
}

// ---- per-agent recompute memo ------------------------------------------------

/**
 * What each agent's sim fields were last computed from: a hash of the report
 * (never the number itself), when, and whether the answer was definitive.
 * In memory: after a Core restart every agent recomputes once — cheap, since
 * the lookup itself is cached in `number_lookups`.
 */
const memo = new Map<number, { fingerprint: string; at: number; definitive: boolean }>();

/** Tests only: forget every agent's last computation. */
export function resetSimMemo(): void {
  memo.clear();
}

function fingerprintOf(report: SimReport): string {
  return createHash("sha256").update(`${report.number}|${report.mcc ?? ""}|${report.mnc ?? ""}`).digest("hex");
}

const NON_DEFINITIVE = new Set([reason("lookup-off"), reason("lookup-failed")]);

/**
 * Recompute and store an agent's sim fields when due. Returns whether it
 * recomputed. `now` exists for tests (expiry / retry without waiting).
 */
export async function refreshAgentSim(
  agentId: number,
  report: SimReport,
  opts: { provider?: NumberLookupProvider | null; now?: number } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const fingerprint = fingerprintOf(report);
  const prev = memo.get(agentId);
  if (prev && prev.fingerprint === fingerprint) {
    const age = now - prev.at;
    if (age < (prev.definitive ? CACHE_MAX_AGE_MS : SIM_RETRY_MS)) return false;
  }
  // Claimed before the await, so a burst of heartbeats computes once.
  memo.set(agentId, { fingerprint, at: now, definitive: false });
  try {
    const match = await computeSimMatch(report, { provider: opts.provider });
    memo.set(agentId, { fingerprint, at: now, definitive: !NON_DEFINITIVE.has(match.simReason) });
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
 * is a report, refresh in the background. Never blocks, never throws, never
 * logs the number.
 */
export function noteSimReport(agentId: number, raw: unknown): void {
  const report = parseSimReport(raw);
  if (!report) return;
  void refreshAgentSim(agentId, report).catch((err) =>
    console.error(`[sim] agent ${agentId}: sim check failed (${err instanceof Error ? err.name : "error"})`),
  );
}
