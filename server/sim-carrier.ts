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
 *   "…1234", and `sim_number_hash`, a keyed hash — server/number-lookup.ts
 *   `numberHash`) and never logged; `number_lookups` is keyed by that hash too.
 * - Never blocks a heartbeat: routes call `noteSimReport`, fire-and-forget.
 * - Of two overlapping reports the NEWER one wins, whichever lookup finishes
 *   last: each recompute or clear takes the next `sim_report_gen` when it
 *   starts, and a recompute writes only if its generation is still the row's
 *   latest (checked under the row lock) — so it holds across Core processes.
 * - Recomputed only when the report changes, the 30-day lookup cache expires,
 *   or a non-definitive answer (lookup off / failed / rate-limited) is due a retry.
 * - A phone agent that stops sending a valid report (SIM removed, phone
 *   unplugged, DialF without a SIM) has its sim fields cleared — `sim_carrier`
 *   NULL, reason `v1: no-sim-report` — rather than keeping the last carrier
 *   forever. Agents without the phone capability are left alone (`sim` is
 *   only frozen onto phone jobs).
 * - Only phone agents' reports count, and the paid lookup is capped per UTC
 *   day, durably in Postgres (server/paid-lookup-budget.ts): one uncached
 *   number per agent, SIM_USER_LOOKUPS_PER_DAY across all agents of one
 *   token creator, and the SIM path's own daily share (SIM_LOOKUPS_PER_DAY,
 *   reserved: flow `line` lookups can't spend it).
 *
 * Limit (from the design): both inputs arrive through the agent; a modified
 * agent could report another real number plus its matching code. The lookup
 * can't invent a carrier, but it can't prove which SIM is in the phone.
 */
import { createHash } from "node:crypto";
import { normalizeTag, simFromCarrier } from "@shared/tags";
import { pool } from "./storage";
import { lookupNumber, redactNumber, numberHash, CACHE_MAX_AGE_MS, MCC_RE, MNC_RE, type NumberLookupProvider } from "./number-lookup";
import { simLookupGate, type PaidLookupGate } from "./paid-lookup-budget";

export const SIM_MATCHER_VERSION = "v1";
/** A non-definitive answer (lookup off / failed / rate-limited) is retried after this long. */
export const SIM_RETRY_MS = 10 * 60 * 1000;
/**
 * Spending caps on the paid lookup live in server/paid-lookup-budget.ts. Both
 * inputs come from the agent, so any token holder could report a fresh valid
 * number every heartbeat and make each one a paid Twilio call. A real SIM's
 * number doesn't change: one uncached lookup per agent per UTC day
 * (SIM_AGENT_LOOKUPS_PER_DAY), at most SIM_USER_LOOKUPS_PER_DAY across all of
 * one user's agent tokens (so minting more agents doesn't multiply it), drawn
 * from the SIM path's reserved SIM_LOOKUPS_PER_DAY share. Past any cap the answer is a
 * non-definitive `rate-limited` (handled like `lookup-failed`). Cache hits
 * (`number_lookups`) are never counted.
 */

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
  opts: { provider?: NumberLookupProvider | null; gate?: PaidLookupGate },
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
interface MemoEntry { fingerprint: string; dueAt: number }
const memo = new Map<number, MemoEntry>();

/**
 * Tests only: forget every agent's last computation (what a Core restart
 * does). The spending caps are durable and NOT reset here —
 * resetPaidLookupBudget does that.
 */
export function resetSimMemo(): void {
  memo.clear();
}

function fingerprintOf(report: SimReport): string {
  return createHash("sha256").update(`${report.number}|${report.mcc ?? ""}|${report.mnc ?? ""}`).digest("hex");
}

const NON_DEFINITIVE = new Set([reason("lookup-off"), reason("lookup-failed"), reason("rate-limited")]);
/** Non-definitive answers that keep a stored answer for the same report. */
const KEEPS_STORED = new Set([reason("lookup-failed"), reason("rate-limited")]);

/**
 * Whether the agent's stored sim fields were computed for this same report:
 * the keyed hash of the FULL number matches (never the last four digits —
 * another number can share them; a row without a hash, from before it
 * existed, is never "the same") and the stored reason names the same phone
 * code (`sim-match <code>` / `mismatch <code> vs …`). The stored row is the
 * source of truth here, so this also holds after a Core restart.
 */
function storedIsForReport(
  stored: { simNumberHash: string | null; simReason: string | null } | undefined,
  report: SimReport,
): boolean {
  if (!stored || !report.mcc || !report.mnc) return false;
  const hash = numberHash(report.number);
  if (!hash || !stored.simNumberHash || stored.simNumberHash !== hash) return false;
  const code = `${report.mcc}-${report.mnc}`;
  return stored.simReason === reason(`sim-match ${code}`) || (stored.simReason ?? "").startsWith(reason(`mismatch ${code} vs `));
}

/**
 * Recompute and store an agent's sim fields when due. Returns whether it
 * recomputed and stored (false: not due, no such agent, or superseded by a
 * newer report / clear that started while this one was looking up). `now` and `shareLimit` exist for tests (expiry / retry
 * without waiting; the SIM share without 200 lookups).
 *
 * An unchanged report inside its due time returns before ANY database read
 * (the in-memory memo below) — a phone agent's heartbeat costs no query.
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
  opts: { provider?: NumberLookupProvider | null; now?: number; shareLimit?: number } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const fingerprint = fingerprintOf(report);
  const prev = memo.get(agentId);
  if (prev && prev.fingerprint === fingerprint && now < prev.dueAt) return false;
  // Claimed before the await, so a burst of heartbeats computes once. The
  // claim object doubles as this process's generation: a newer report (or a
  // clear) replaces it, and this refresh then leaves the memo alone.
  const claim: MemoEntry = { fingerprint, dueAt: now + SIM_RETRY_MS };
  memo.set(agentId, claim);
  try {
    const gen = await beginSimReport(agentId);
    if (gen === undefined) return false; // no such agent
    // Refunded inside lookupNumber only when the provider call was not billed.
    const gate = simLookupGate(agentId, { now, shareLimit: opts.shareLimit });
    const { match, lookedUpAt } = await computeSimMatchDetailed(report, { provider: opts.provider, gate });
    const definitive = !NON_DEFINITIVE.has(match.simReason);
    const dueAt = !definitive
      ? now + SIM_RETRY_MS
      : (lookedUpAt ? lookedUpAt.getTime() : now) + CACHE_MAX_AGE_MS;
    if (!(await settleSimReport(agentId, gen, report, match))) {
      // Superseded by a newer report or a clear (here or in another process):
      // its result stands; this one is dropped.
      if (memo.get(agentId) === claim) memo.delete(agentId);
      return false;
    }
    if (memo.get(agentId) === claim) memo.set(agentId, { fingerprint, dueAt });
    return true;
  } catch (err) {
    if (memo.get(agentId) === claim) memo.delete(agentId);
    throw err;
  }
}

/**
 * Start a recompute: take the agent's next SIM report generation and mark it
 * in flight (stored negated). Returns the generation, or undefined when the
 * agent row doesn't exist. One statement, only on a recompute — never on an
 * unchanged heartbeat.
 */
async function beginSimReport(agentId: number): Promise<number | undefined> {
  const r = await pool.query<{ gen: number }>(
    `UPDATE eval_agents SET sim_report_gen = -(abs(sim_report_gen) + 1) WHERE id = $1 RETURNING -sim_report_gen AS gen`,
    [agentId],
  );
  return r.rows[0]?.gen;
}

/**
 * Finish a recompute, the same way the flow path writes `line_lookup`
 * (writeLineLookupIfCurrent): re-read the row `FOR UPDATE` and write only if
 * this recompute's generation is still the latest (`sim_report_gen = -gen`).
 * A newer report or a clear has moved it on — then nothing is written and
 * this returns false. Otherwise the generation is settled (`+gen`) and the
 * fields written — except that a transient failure (KEEPS_STORED) keeps a
 * stored answer computed for this same report.
 */
async function settleSimReport(agentId: number, gen: number, report: SimReport, match: SimMatch): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ sim_report_gen: number; sim_number_hash: string | null; sim_reason: string | null }>(
      `SELECT sim_report_gen, sim_number_hash, sim_reason FROM eval_agents WHERE id = $1 FOR UPDATE`,
      [agentId],
    );
    const row = rows[0];
    if (!row || row.sim_report_gen !== -gen) {
      await client.query("ROLLBACK");
      return false;
    }
    const keep = KEEPS_STORED.has(match.simReason)
      && storedIsForReport({ simNumberHash: row.sim_number_hash, simReason: row.sim_reason }, report);
    if (keep) {
      // Keep the stored answer; the retry is scheduled by the caller's memo.
      await client.query(`UPDATE eval_agents SET sim_report_gen = $2 WHERE id = $1`, [agentId, gen]);
    } else {
      await client.query(
        `UPDATE eval_agents SET sim_carrier = $2, sim_reason = $3, sim_number_redacted = $4, sim_number_hash = $5,
           sim_report_gen = $6, updated_at = now() WHERE id = $1`,
        [agentId, match.simCarrier, match.simReason, match.simNumberRedacted, numberHash(report.number), gen],
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Memo fingerprint for "this agent's fields were cleared for no report". */
const NO_REPORT = "no-sim-report";
export const NO_SIM_REPORT_REASON = reason(NO_REPORT);

/**
 * A phone agent sent no valid `sim`: clear its sim fields (carrier NULL,
 * reason `v1: no-sim-report`, number fields NULL). Returns whether it
 * attempted a write. The memo makes the unchanged case free — after the first
 * clear, every following no-report beat returns before any query — and the
 * UPDATE itself is conditional (`IS DISTINCT FROM`), so after a Core restart
 * an agent already cleared costs one no-op statement, never a row rewrite.
 */
export async function clearAgentSim(agentId: number): Promise<boolean> {
  if (memo.get(agentId)?.fingerprint === NO_REPORT) return false;
  const claim: MemoEntry = { fingerprint: NO_REPORT, dueAt: Number.POSITIVE_INFINITY };
  memo.set(agentId, claim);
  try {
    // Takes the next generation, so a recompute still in flight (negative
    // gen, here or in another process) can't write over the clear. Already
    // cleared and nothing in flight: matches no row, rewrites nothing.
    await pool.query(
      `UPDATE eval_agents SET sim_carrier = NULL, sim_reason = $2, sim_number_redacted = NULL, sim_number_hash = NULL,
         sim_report_gen = abs(sim_report_gen) + 1
       WHERE id = $1 AND (sim_reason IS DISTINCT FROM $2 OR sim_report_gen < 0)`,
      [agentId, NO_SIM_REPORT_REASON],
    );
    return true;
  } catch (err) {
    if (memo.get(agentId) === claim) memo.delete(agentId);
    throw err;
  }
}

/**
 * Route entry point (register/heartbeat): parse the body's `sim` and, when it
 * is a report from an agent whose current capabilities include `phone` (only
 * a phone agent has a SIM — anyone else's report is ignored, never looked
 * up), refresh in the background. A phone agent with NO valid report has its
 * stored sim cleared (clearAgentSim). Never blocks, never throws, never logs
 * the number. The returned promise (always resolved) exists for tests; routes
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
  const work = report ? refreshAgentSim(agentId, report, opts) : clearAgentSim(agentId);
  return work.then(() => undefined, (err) =>
    console.error(`[sim] agent ${agentId}: sim check failed (${err instanceof Error ? err.name : "error"})`),
  );
}
