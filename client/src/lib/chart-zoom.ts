export interface ChartRange {
  start: number;
  end: number;
}

export type ChartDomain = [number, number];

export const DEFAULT_CHART_WINDOW = 100;
export const MIN_CHART_WINDOW = 10;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Map a fractional point range to a continuous numeric axis domain. */
export function chartRangeDomain(range: ChartRange, totalLength: number): ChartDomain {
  if (totalLength <= 0) return [0, 1];
  const current = clampChartRange(range, totalLength);
  // Point indices sit at cell centers, preserving the category chart's spacing.
  return [current.start - 0.5, current.end - 0.5];
}

/** Retain integer points outside the domain so path entry/exit stays clipped. */
export function overscanChartRange(
  range: ChartRange,
  totalLength: number,
  overscan = 1,
): ChartRange {
  const total = Math.max(0, totalLength);
  if (total === 0) return { start: 0, end: 0 };
  const current = clampChartRange(range, total);
  const padding = Math.max(0, Math.floor(overscan));
  return {
    start: Math.max(0, Math.floor(current.start) - padding),
    end: Math.min(total, Math.ceil(current.end) + padding),
  };
}

/** Build stable, evenly positioned ticks for a moving numeric domain. */
export function chartDomainTicks(domain: ChartDomain, count = 7): number[] {
  const tickCount = Math.max(2, Math.floor(count));
  const span = domain[1] - domain[0];
  if (!Number.isFinite(span) || span <= 0) return [domain[0]];
  return Array.from(
    { length: tickCount },
    (_, index) => domain[0] + (span * index) / (tickCount - 1),
  );
}

/** Calculate a padded Y maximum for the supplied row window. */
export function stableYAxisMax(
  rows: ReadonlyArray<Record<string, unknown>>,
  dataKeys: readonly string[],
): number {
  let maximum = 0;
  for (const row of rows) {
    for (const key of dataKeys) {
      const value = row[key];
      if (typeof value === "number" && Number.isFinite(value)) maximum = Math.max(maximum, value);
    }
  }
  if (maximum <= 0) return 1;
  const padded = maximum * 1.05;
  const step = 10 ** Math.floor(Math.log10(padded)) / 10;
  return Math.ceil(padded / step) * step;
}

export function defaultChartRange(totalLength: number): ChartRange {
  const total = Math.max(0, totalLength);
  return {
    start: Math.max(0, total - DEFAULT_CHART_WINDOW),
    end: total,
  };
}

export function clampChartRange(range: ChartRange, totalLength: number): ChartRange {
  const total = Math.max(0, totalLength);
  if (total === 0) return { start: 0, end: 0 };

  const minWindow = Math.min(MIN_CHART_WINDOW, total);
  const requestedWindow = Number.isFinite(range.end - range.start)
    ? range.end - range.start
    : minWindow;
  const windowSize = clamp(requestedWindow, minWindow, total);
  const start = clamp(range.start, 0, total - windowSize);
  return { start, end: start + windowSize };
}

/** Reconcile a window after data length changes, optionally keeping its live edge pinned. */
export function resizeChartRange(
  range: ChartRange,
  previousLength: number,
  nextLength: number,
  pinToLatest: boolean,
): ChartRange {
  const previous = clampChartRange(range, previousLength);
  if (!pinToLatest) return clampChartRange(previous, nextLength);

  const total = Math.max(0, nextLength);
  const windowSize = Math.min(previous.end - previous.start, total);
  return { start: total - windowSize, end: total };
}

export function zoomChartRange(
  range: ChartRange,
  totalLength: number,
  scale: number,
  anchorRatio: number,
): ChartRange {
  const current = clampChartRange(range, totalLength);
  const total = Math.max(0, totalLength);
  if (total === 0) return current;

  const minWindow = Math.min(MIN_CHART_WINDOW, total);
  const currentWindow = current.end - current.start;
  const nextWindow = clamp(currentWindow * clamp(scale, 0.5, 2), minWindow, total);
  if (nextWindow >= total) return { start: 0, end: total };

  const ratio = clamp(anchorRatio, 0, 1);
  const anchor = current.start + currentWindow * ratio;
  const start = clamp(anchor - nextWindow * ratio, 0, total - nextWindow);
  return { start, end: start + nextWindow };
}

export function panChartRange(
  range: ChartRange,
  totalLength: number,
  deltaPoints: number,
): ChartRange {
  const current = clampChartRange(range, totalLength);
  const total = Math.max(0, totalLength);
  const windowSize = current.end - current.start;
  if (total === 0 || windowSize >= total) return current;

  const start = clamp(current.start + deltaPoints, 0, total - windowSize);
  return { start, end: start + windowSize };
}

/** Convert browser wheel units into a bounded, proportional zoom scale. */
export function wheelZoomScale(deltaY: number, deltaMode: number, pageHeight: number): number {
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(1, pageHeight) : 1;
  const normalizedDelta = clamp(deltaY * unit, -240, 240);
  return Math.exp(normalizedDelta * 0.0015);
}
