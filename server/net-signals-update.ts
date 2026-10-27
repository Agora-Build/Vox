/**
 * Agent-reported network signals on register/heartbeat (`netSignals`) —
 * designs/2026-10-22-network-tags-design.md "Where it's computed and
 * stored" (Part-2 Task 3). Pure parse/merge/change-detection; server/routes.ts
 * is the only caller that touches the DB or the HTTP body.
 *
 * Wire contract (mirrors `parseLinkTypeUpdate` in server/routes.ts):
 * - The body's `netSignals`, when present, is an object with up to two
 *   boolean fields (`cloudMetadata`, `publicIpOnInterface`). Anything else —
 *   a non-object body, an unknown key, a non-boolean value — is silently
 *   ignored, never a 400: an older/newer daemon must interop.
 * - An update with no recognizable field (absent body, wrong shape, every
 *   key filtered out) parses to `undefined` — "nothing reported this beat,"
 *   which must leave the stored value alone, same as `undefined` meaning
 *   "couldn't tell" for `linkType`.
 *
 * Persistence: unlike `linkType` (one flat column), `netSignals` is stored as
 * one jsonb object with each field independently sticky — a heartbeat that
 * reports only `cloudMetadata` must not clobber a previously reported
 * `publicIpOnInterface`. This matters because the full location recheck only
 * runs every LOCATION_RECHECK_HOURS (or on IP change / pending hysteresis):
 * storing the latest reported value on EVERY beat means that when the
 * recheck finally runs, hours later, it sees the freshest signal rather than
 * whatever was true at the last recheck.
 */
import type { AgentNetSignals } from "./access-class";

/**
 * Strict parse of `req.body.netSignals`. Returns `undefined` when nothing
 * recognizable was sent (never an empty `{}` — callers can treat `undefined`
 * as the single "no update this beat" case).
 */
export function parseNetSignalsUpdate(raw: unknown): AgentNetSignals | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const result: AgentNetSignals = {};
  if (typeof obj.cloudMetadata === "boolean") result.cloudMetadata = obj.cloudMetadata;
  if (typeof obj.publicIpOnInterface === "boolean") result.publicIpOnInterface = obj.publicIpOnInterface;
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Merge a parsed update into the agent's stored signals: a field the update
 * carries overwrites; a field this beat didn't report keeps its last known
 * value. `update === undefined` (nothing reported) leaves `stored` as-is.
 * Returns `null` (never `{}`) when there is nothing to store.
 */
export function mergeNetSignals(
  stored: AgentNetSignals | null | undefined,
  update: AgentNetSignals | undefined,
): AgentNetSignals | null {
  if (!update) return stored ?? null;
  const merged: AgentNetSignals = { ...(stored ?? {}), ...update };
  return Object.keys(merged).length > 0 ? merged : null;
}

/**
 * True when this beat's parsed update actually changes a stored value — the
 * heartbeat route adds this to its existing re-check triggers (next to IP
 * change / staleness / pending hysteresis) so a flip like cloudMetadata
 * false→true doesn't wait for the next scheduled recheck (design: "re-run
 * the location/access check on that heartbeat"). Compares only the keys the
 * update itself carries, so unrelated stored fields never cause a false
 * positive.
 */
export function netSignalsChanged(
  stored: AgentNetSignals | null | undefined,
  update: AgentNetSignals | undefined,
): boolean {
  if (!update) return false;
  const prior = stored ?? {};
  return (Object.keys(update) as Array<keyof AgentNetSignals>).some((k) => prior[k] !== update[k]);
}

/**
 * The `netSignals` part of an agent row update: `{}` when nothing was
 * reported (no write — the stored value is never written back, which would
 * be a pointless write and could race a concurrent beat's real update),
 * else the merged value.
 */
export function netSignalsPatch(
  stored: AgentNetSignals | null | undefined,
  update: AgentNetSignals | undefined,
): { netSignals?: AgentNetSignals | null } {
  return update === undefined ? {} : { netSignals: mergeNetSignals(stored, update) };
}
