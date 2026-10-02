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
    || end > 8640000000000000 || end - start > METRICS_RETENTION_DAYS * METRICS_DAY_MS) {
    return { error: "from and to must define an ordered window of at most three years" };
  }
  return { from: start, to: end };
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
      return time < detail.from || time >= detail.to;
    }),
    ...detail.metrics,
  ];
}
