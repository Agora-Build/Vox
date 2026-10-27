/**
 * Spending caps on paid number lookups (Twilio Lookup, server/number-lookup.ts).
 *
 * Two paths can make a paid lookup, and both are driven by outside input:
 *   - a phone eval flow's dialled number, on save or "Look up again"
 *     (any signed-in flow editor can type a fresh number per request);
 *   - our own SIM's number, reported by a phone agent on register/heartbeat
 *     (any token holder can report a fresh number per beat, and can mint
 *     more tokens/agents).
 * So each path has per-caller rules, and both draw from ONE global daily
 * budget (PAID_LOOKUPS_PER_DAY): flow edits can't starve SIM checks of more
 * than that, nor the other way round, and the bill has a ceiling.
 *
 * Only an UNCACHED lookup is counted — `lookupNumber` asks the gate right
 * before the provider call, never for a `number_lookups` cache hit — and a
 * provider call that failed is refunded (it answered nothing; the retry must
 * not wait a day). Past a cap the answer is the non-definitive
 * `rate-limited`: callers keep whatever they had stored.
 *
 * Durable and atomic: the counters live in Postgres (`paid_lookup_usage`,
 * migration 0061), one row per (scope, subject, day). A reservation takes
 * every row it needs in ONE transaction, each with a single
 * `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 WHERE count < limit
 * RETURNING count` — no row back means that cap is full and the whole
 * reservation rolls back. Concurrent requests and several Core processes
 * can't both pass, and a restart doesn't hand out a fresh day. Rows are
 * always taken in the same order (per-caller rows, then global), so two
 * reservations can't deadlock.
 *
 * Days are UTC calendar days (`day` = the UTC date of the reservation): every
 * cap resets at 00:00 UTC. Rows older than RETAIN_DAYS are deleted
 * opportunistically on reservation (reservations only happen on a cache
 * miss, so this is rare and cheap).
 */
import { pool } from "./storage";

/** All paid lookups, flow + SIM together, per UTC day. */
export const PAID_LOOKUPS_PER_DAY = 500;
/**
 * Uncached lookups one user's flow edits may cause per UTC day. A real flow's
 * agent number rarely changes; 10 covers setting up several flows in a day.
 */
export const FLOW_USER_LOOKUPS_PER_DAY = 10;
/** Uncached lookups one agent's SIM reports may cause per UTC day: a real SIM's number doesn't change. */
export const SIM_AGENT_LOOKUPS_PER_DAY = 1;
/**
 * Uncached SIM lookups across ALL of one user's agent tokens per UTC day
 * (keyed by the token's creator) — so minting more tokens/agents doesn't
 * multiply the per-agent cap. 5 covers a small fleet of phone hosts.
 */
export const SIM_USER_LOOKUPS_PER_DAY = 5;
/** How many days of counters are kept (only today's are read). */
export const RETAIN_DAYS = 7;

export type BudgetScope = "global" | "flow-user" | "sim-agent" | "sim-user";

/** Asked right before a paid provider call; `refund` hands a failed call back. */
export interface PaidLookupGate {
  /** Reserve one paid call atomically. False = over a cap (nothing reserved). */
  allow(): Promise<boolean>;
  /** Return the reservation — the provider call failed. Idempotent; a no-op if nothing was reserved. */
  refund(): Promise<void>;
}

interface Slot { scope: BudgetScope; subject: string; limit: number }

/** The UTC calendar day of an instant, as `YYYY-MM-DD`. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Tests only: forget every counter. */
export async function resetPaidLookupBudget(): Promise<void> {
  await pool.query("DELETE FROM paid_lookup_usage");
}

/**
 * A gate over `slots` (resolved lazily, at the paid call — so a cache hit
 * costs no query). `slots` returning null = can't attribute the call →
 * refused.
 */
function paidLookupGate(slots: () => Promise<Slot[] | null>, now: number, globalLimit: number): PaidLookupGate {
  const day = utcDay(now);
  let reserved: Slot[] | null = null;
  return {
    allow: async (): Promise<boolean> => {
      if (reserved) return true;
      const own = await slots();
      if (!own) return false;
      const all: Slot[] = [...own, { scope: "global", subject: "all", limit: globalLimit }];
      if (all.some((s) => s.limit <= 0)) return false;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const s of all) {
          const r = await client.query(
            `INSERT INTO paid_lookup_usage (scope, subject, day, count) VALUES ($1, $2, $3, 1)
             ON CONFLICT (scope, subject, day) DO UPDATE SET count = paid_lookup_usage.count + 1
             WHERE paid_lookup_usage.count < $4
             RETURNING count`,
            [s.scope, s.subject, day, s.limit],
          );
          if (r.rowCount === 0) {
            await client.query("ROLLBACK");
            return false;
          }
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      reserved = all;
      // Opportunistic cleanup, best-effort, by the DATABASE's UTC date (never
      // a caller-supplied `now`, so a test's future day can't purge today).
      pool.query(
        `DELETE FROM paid_lookup_usage WHERE day < (now() AT TIME ZONE 'UTC')::date - $1::int`,
        [RETAIN_DAYS],
      ).catch(() => {});
      return true;
    },
    refund: async (): Promise<void> => {
      if (!reserved) return;
      const slotsHeld = reserved;
      reserved = null;
      // One statement: atomic, floored at 0.
      await pool.query(
        `UPDATE paid_lookup_usage SET count = GREATEST(count - 1, 0)
         WHERE day = $1 AND (scope, subject) IN (SELECT * FROM unnest($2::varchar[], $3::varchar[]))`,
        [day, slotsHeld.map((s) => s.scope), slotsHeld.map((s) => s.subject)],
      );
    },
  };
}

/** The gate for a flow editor's lookup (save / "Look up again"). `now`/`globalLimit` exist for tests. */
export function flowLookupGate(userId: number, opts: { now?: number; globalLimit?: number } = {}): PaidLookupGate {
  return paidLookupGate(
    async () => [{ scope: "flow-user", subject: String(userId), limit: FLOW_USER_LOOKUPS_PER_DAY }],
    opts.now ?? Date.now(),
    opts.globalLimit ?? PAID_LOOKUPS_PER_DAY,
  );
}

/**
 * The gate for an agent's SIM report: per agent, per user (the creator of the
 * agent's token, across all their tokens), and the global day. An agent that
 * can't be found is refused. `now`/`globalLimit` exist for tests.
 */
export function simLookupGate(agentId: number, opts: { now?: number; globalLimit?: number } = {}): PaidLookupGate {
  return paidLookupGate(
    async () => {
      const r = await pool.query<{ created_by: number }>(
        `SELECT t.created_by FROM eval_agents a JOIN eval_agent_tokens t ON t.id = a.token_id WHERE a.id = $1`,
        [agentId],
      );
      const owner = r.rows[0]?.created_by;
      if (owner == null) return null;
      return [
        { scope: "sim-agent", subject: String(agentId), limit: SIM_AGENT_LOOKUPS_PER_DAY },
        { scope: "sim-user", subject: String(owner), limit: SIM_USER_LOOKUPS_PER_DAY },
      ];
    },
    opts.now ?? Date.now(),
    opts.globalLimit ?? PAID_LOOKUPS_PER_DAY,
  );
}
