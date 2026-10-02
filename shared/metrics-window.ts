export const METRICS_DAY_MS = 24 * 60 * 60 * 1000;
export const METRICS_RETENTION_DAYS = 3 * 365;
export type MetricsResolution = "raw" | "hour" | "day";

export interface MetricsWindow {
  from: number;
  to: number;
}

export function metricsResolution(spanMs: number): MetricsResolution {
  if (spanMs <= 7 * METRICS_DAY_MS) return "raw";
  if (spanMs <= 90 * METRICS_DAY_MS) return "hour";
  return "day";
}

/** Detail requests expand by at most one bucket when aligned outward. */
export function metricsDetailResolution(spanMs: number): "raw" | "hour" {
  return spanMs <= 7 * METRICS_DAY_MS + 60000 ? "raw" : "hour";
}

/** Align requests for cache reuse and complete buckets without moving the viewport. */
export function detailWindow(from: number, to: number): MetricsWindow | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const resolution = metricsResolution(to - from);
  if (resolution === "day") return null;
  const unit = resolution === "raw" ? 60000 : 3600000;
  return { from: Math.floor(from / unit) * unit, to: Math.ceil(to / unit) * unit };
}

export function parseMetricsDetailWindow(from: unknown, to: unknown): MetricsWindow | { error: string } {
  if (typeof from !== "string" || typeof to !== "string" || !from.trim() || !to.trim()) {
    return { error: "from and to must be epoch timestamps in milliseconds" };
  }
  const start = Number(from);
  const end = Number(to);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start
    || end > 8640000000000000 || end - start > 90 * METRICS_DAY_MS + 3600000) {
    return { error: "from and to must define an ordered detail window of at most 90 days (plus bucket alignment)" };
  }
  const minuteWindow = { from: Math.floor(start / 60000) * 60000, to: Math.ceil(end / 60000) * 60000 };
  const unit = metricsDetailResolution(minuteWindow.to - minuteWindow.from) === "raw" ? 60000 : 3600000;
  const window = { from: Math.floor(start / unit) * unit, to: Math.ceil(end / unit) * unit };
  if (window.to - window.from > 90 * METRICS_DAY_MS + 3600000) return { error: "aligned detail window exceeds 90 days" };
  return window;
}

/** Replace overview buckets in the loaded interval, never average two resolutions together. */
export function mergeMetricDetail<T extends { timestamp: string }>(
  overview: readonly T[],
  detail: { metrics: readonly T[]; from: number; to: number } | null,
): T[] {
  if (!detail) return [...overview];
  return [
    ...overview.filter(row => {
      const time = new Date(row.timestamp).getTime();
      // Drop whole overlapping days: brief offscreen gaps are preferable to mixed-resolution averages.
      return time + METRICS_DAY_MS <= detail.from || time >= detail.to;
    }),
    ...detail.metrics,
  ];
}
