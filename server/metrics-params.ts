import type { MetricTier } from "./storage";
import { parseTagFilter, parseGroupBy, formatTag, effectiveTags, UNTAGGED_VALUE, REGION_GROUP_KEY, type Tag, type JobTag, type TagBoard } from "@shared/tags";
import { resultRegion } from "@shared/regions";

// The client-supplied knobs of a metrics view, shared by the console routes
// (/api/metrics/*) and the public v1 API (/api/v1/metrics/*) so the two can't
// disagree about what a window, a transport or a tier means.

/** Longest window accepted: ~114 years — anything larger can't make a valid Date. */
export const MAX_METRICS_HOURS = 1_000_000;

/**
 * The time window. `hours` must be a positive integer up to MAX_METRICS_HOURS;
 * absent means "all time". Returns { hoursBack } on success, or { error }
 * describing a 400.
 */
export function parseMetricsWindow(hours: unknown): { hoursBack?: number } | { error: string } {
  if (hours === undefined) return {};
  const parsed = Number(hours);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_METRICS_HOURS) {
    return { error: `hours must be a positive integer up to ${MAX_METRICS_HOURS} (omit for all time)` };
  }
  return { hoursBack: parsed };
}

/**
 * Transport partition (design 2026-09-21 §11): each metrics view is scoped to
 * exactly one transport — web and phone are separate categories, never mixed.
 */
export function parseMetricsTransport(raw: unknown): { transport: "web" | "phone" } | { error: string } {
  const t = raw === undefined ? "web" : String(raw);
  if (t !== "web" && t !== "phone") return { error: "transport must be web or phone" };
  return { transport: t };
}

/**
 * Which results a public v1 metrics view covers. `mainline` (default) and
 * `community` are public data; `mine` is the caller's own private evals — the
 * console's My Evals — and needs an API key (or a signed-in session).
 */
export type ApiMetricsTier = "mainline" | "community" | "mine";
export function parseMetricsTier(raw: unknown): { tier: ApiMetricsTier; storageTier: MetricTier } | { error: string } {
  const t = raw === undefined ? "mainline" : String(raw);
  if (t === "mainline") return { tier: t, storageTier: "mainline" };
  if (t === "community") return { tier: t, storageTier: "community" };
  if (t === "mine") return { tier: t, storageTier: "myEvals" };
  return { error: "tier must be mainline, community or mine" };
}

/**
 * Network-tag knobs of a metrics view (designs/2026-10-22-network-tags-design.md
 * "Analysis"): `tag=key:value` — repeatable, every one must match the job's
 * effective value on the view's board — and `groupBy=key`, which splits rows
 * by that key's effective value. Both go through shared/tags.ts's parsers, so
 * a bad value is a 400 with the same message as everywhere else.
 */
export function parseMetricsTags(query: { tag?: unknown; groupBy?: unknown }): { tagFilters: Tag[]; groupBy?: string } | { error: string } {
  const tf = parseTagFilter(query.tag);
  if ("error" in tf) return { error: tf.error };
  const gb = parseGroupBy(query.groupBy);
  if ("error" in gb) return { error: gb.error };
  return { tagFilters: tf.filters, groupBy: gb.groupBy };
}

/** Cache-key part for the tag knobs. Filters are sorted: AND doesn't care about order. */
export function tagsCacheKey(v: { tagFilters: Tag[]; groupBy?: string }): string {
  return `tags=${v.tagFilters.map(formatTag).sort().join(",")}:groupBy=${v.groupBy ?? ""}`;
}

/**
 * The group a row falls in when it has no effective value for the groupBy key
 * — nothing is dropped. Reserved: normalizeTag refuses it as a tag value, so a
 * real tag can never be mistaken for this group.
 */
export const UNTAGGED = UNTAGGED_VALUE;

/**
 * A row's `groupBy` value on a board: its effective value for the key, or
 * `untagged`. JS twin of server/tag-sql.ts (both apply `effectiveTags`).
 */
export function tagGroupValue(jobTags: JobTag[] | null | undefined, board: TagBoard, key: string): string {
  return effectiveTags(jobTags, board).find((t) => t.key === key)?.value ?? UNTAGGED;
}

/**
 * The group a row falls in under `groupBy=region` when it has no region —
 * neither a site nor a recording region (design "Group by region").
 */
export const UNATTRIBUTED = "unattributed";

/** The fallback group of a groupBy key: `unattributed` for region, `untagged` for a tag. */
export function emptyGroupValue(groupBy: string): string {
  return groupBy === REGION_GROUP_KEY ? UNATTRIBUTED : UNTAGGED;
}

/**
 * A raw row's `groupBy` value on a board. `region` is reserved (not a tag
 * key): the result's region — its recording region (an analysis), else its
 * site's location base — or `unattributed`. Any other key is a tag:
 * `tagGroupValue`. JS twin of `groupValueSql` (server/tag-sql.ts).
 */
export function groupValue(
  row: { jobTags?: JobTag[] | null; siteId?: string | null; recordingRegion?: string | null },
  board: TagBoard,
  groupBy: string,
): string {
  if (groupBy === REGION_GROUP_KEY) return resultRegion(row.siteId, row.recordingRegion) ?? UNATTRIBUTED;
  return tagGroupValue(row.jobTags, board, groupBy);
}

/**
 * Leaderboard access columns (design "Last mile vs datacenter" → Analysis):
 * which column a result feeds — its effective `access` (detected only, on
 * every board) — or undefined for `unknown` / no access tag.
 */
export function accessColumn(jobTags: JobTag[] | null | undefined, board: TagBoard): "lastMile" | "datacenter" | undefined {
  const access = effectiveTags(jobTags, board).find((t) => t.key === "access")?.value;
  return access === "lastmile" ? "lastMile" : access === "datacenter" ? "datacenter" : undefined;
}

/** Access columns are added only when the view isn't already filtered to one access class. */
export function wantsAccessColumns(tagFilters: Tag[]): boolean {
  return !tagFilters.some((t) => t.key === "access");
}
