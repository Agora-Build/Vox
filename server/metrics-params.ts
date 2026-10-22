import type { MetricTier } from "./storage";

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
