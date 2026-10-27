/**
 * Spending caps on paid number lookups (Twilio Lookup, server/number-lookup.ts).
 *
 * Two paths can make a paid lookup, and both are driven by outside input:
 *   - a phone eval flow's dialled number, on save or "Look up again"
 *     (any signed-in flow editor can type a fresh number per request);
 *   - our own SIM's number, reported by a phone agent on register/heartbeat
 *     (any token holder can report a fresh number per beat).
 * So each path has a per-caller rule, and both draw from ONE global daily
 * budget (PAID_LOOKUPS_PER_DAY): flow edits can't starve SIM checks of more
 * than that, nor the other way round, and the bill has a ceiling.
 *
 * Only an UNCACHED lookup is counted — `lookupNumber` asks the gate right
 * before the provider call, never for a `number_lookups` cache hit — and a
 * provider call that failed is refunded (it answered nothing; the retry must
 * not wait a day). Past a cap the answer is the non-definitive
 * `rate-limited`: callers keep whatever they had stored.
 *
 * In memory: a Core restart resets the counters (at most one more day's
 * budget — acceptable; the cache keeps repeat lookups free regardless).
 */

export const PAID_LOOKUP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** All paid lookups, flow + SIM together, per day. */
export const PAID_LOOKUPS_PER_DAY = 500;
/**
 * Uncached lookups one user's flow edits may cause per 24 h. A real flow's
 * agent number rarely changes; 10 covers setting up several flows in a day.
 */
export const FLOW_USER_LOOKUPS_PER_DAY = 10;
/** Uncached lookups one agent's SIM reports may cause per 24 h: a real SIM's number doesn't change. */
export const SIM_AGENT_LOOKUPS_PER_DAY = 1;

/** Asked right before a paid provider call; `refund` hands a failed call back. */
export interface PaidLookupGate {
  /** Reserve one paid call (so concurrent callers can't both pass). False = over a cap. */
  allow(): boolean;
  /** Return the reservation — the provider call failed. Idempotent; a no-op if nothing was reserved. */
  refund(): void;
}

/** Per caller (`flow-user:<id>`, `sim-agent:<id>`): when each counted lookup was made (sliding window). */
const perKey = new Map<string, number[]>();
/** The shared global day (fixed window, starting at its first lookup). */
let globalDay = { windowStart: 0, used: 0 };

/** Tests only: forget every counter. */
export function resetPaidLookupBudget(): void {
  perKey.clear();
  globalDay = { windowStart: 0, used: 0 };
}

function paidLookupGate(key: string, perKeyLimit: number, now: number, globalLimit: number): PaidLookupGate {
  let reserved = false;
  return {
    allow: (): boolean => {
      const recent = (perKey.get(key) ?? []).filter((t) => now - t < PAID_LOOKUP_WINDOW_MS);
      if (recent.length >= perKeyLimit) {
        perKey.set(key, recent);
        return false;
      }
      if (now - globalDay.windowStart >= PAID_LOOKUP_WINDOW_MS) globalDay = { windowStart: now, used: 0 };
      if (globalDay.used >= globalLimit) {
        if (recent.length) perKey.set(key, recent); else perKey.delete(key);
        return false;
      }
      globalDay.used++;
      recent.push(now);
      perKey.set(key, recent);
      reserved = true;
      return true;
    },
    refund: (): void => {
      if (!reserved) return;
      reserved = false;
      if (globalDay.used > 0) globalDay.used--;
      const list = perKey.get(key);
      const i = list ? list.lastIndexOf(now) : -1;
      if (list && i >= 0) {
        list.splice(i, 1);
        if (list.length === 0) perKey.delete(key);
      }
    },
  };
}

/** The gate for a flow editor's lookup (save / "Look up again"). `now`/`globalLimit` exist for tests. */
export function flowLookupGate(userId: number, opts: { now?: number; globalLimit?: number } = {}): PaidLookupGate {
  return paidLookupGate(`flow-user:${userId}`, FLOW_USER_LOOKUPS_PER_DAY, opts.now ?? Date.now(), opts.globalLimit ?? PAID_LOOKUPS_PER_DAY);
}

/** The gate for an agent's SIM report. `now`/`globalLimit` exist for tests. */
export function simLookupGate(agentId: number, opts: { now?: number; globalLimit?: number } = {}): PaidLookupGate {
  return paidLookupGate(`sim-agent:${agentId}`, SIM_AGENT_LOOKUPS_PER_DAY, opts.now ?? Date.now(), opts.globalLimit ?? PAID_LOOKUPS_PER_DAY);
}
