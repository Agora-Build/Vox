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

/** Return the integer point indices that intersect the continuous chart domain. */
export function visibleChartRange(range: ChartRange, totalLength: number): ChartRange {
  const total = Math.max(0, totalLength);
  if (total === 0) return { start: 0, end: 0 };
  const current = clampChartRange(range, total);
  return {
    start: Math.max(0, Math.ceil(current.start - 0.5)),
    end: Math.min(total, Math.floor(current.end - 0.5) + 1),
  };
}

/** Retain integer points outside the domain so path entry/exit stays clipped. */
export function overscanChartRange(
  range: ChartRange,
  totalLength: number,
  overscan = 1,
): ChartRange {
  const total = Math.max(0, totalLength);
  const visible = visibleChartRange(range, total);
  const padding = Math.max(0, Math.floor(overscan));
  return {
    start: Math.max(0, visible.start - padding),
    end: Math.min(total, visible.end + padding),
  };
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Select visible rows plus only the sparse neighbors needed for clipped paths. */
export function segmentRenderIndices(
  range: ChartRange,
  totalLength: number,
  segments: ReadonlyArray<readonly number[]>,
): number[] {
  const total = Math.max(0, totalLength);
  const visible = visibleChartRange(range, total);
  const selected = new Set<number>();

  for (let index = visible.start; index < visible.end; index++) selected.add(index);
  if (visible.start > 0) selected.add(visible.start - 1);
  if (visible.end < total) selected.add(visible.end);

  for (const dataIndices of segments) {
    if (dataIndices.length === 0) continue;
    const first = dataIndices[0];
    const last = dataIndices[dataIndices.length - 1];
    if (last < visible.start || first >= visible.end) continue;

    const firstVisible = lowerBound(dataIndices, visible.start);
    if (firstVisible > 0) selected.add(dataIndices[firstVisible - 1]);

    const firstAfter = lowerBound(dataIndices, visible.end);
    if (firstAfter < dataIndices.length) selected.add(dataIndices[firstAfter]);
  }

  return Array.from(selected).sort((a, b) => a - b);
}

/** Build stable ticks snapped to real point indices inside a numeric domain. */
export function chartDomainTicks(domain: ChartDomain, count = 7): number[] {
  const requestedCount = Math.max(1, Math.floor(count));
  const first = Math.ceil(domain[0]);
  const last = Math.floor(domain[1]);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) {
    return [(domain[0] + domain[1]) / 2];
  }

  const tickCount = Math.min(requestedCount, last - first + 1);
  if (tickCount === 1) return [Math.round((first + last) / 2)];
  return Array.from(
    { length: tickCount },
    (_, index) => Math.round(first + ((last - first) * index) / (tickCount - 1)),
  );
}

function paddedYAxisMax(maximum: number): number {
  if (maximum <= 0) return 1;
  const padded = maximum * 1.05;
  const step = 10 ** Math.floor(Math.log10(padded)) / 10;
  return Number((Math.ceil(padded / step) * step).toPrecision(12));
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
  return paddedYAxisMax(maximum);
}

/** Calculate the visible maximum, including interpolated sparse-line edge crossings. */
export function segmentYAxisMax(
  rows: ReadonlyArray<Record<string, unknown>>,
  segments: ReadonlyArray<{ segKey: string; dataIndices: readonly number[] }>,
  range: ChartRange,
): number {
  if (rows.length === 0) return 1;
  const [left, right] = chartRangeDomain(range, rows.length);
  let maximum = 0;

  const valueAt = (segKey: string, index: number): number | null => {
    const value = rows[index]?.[segKey];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };

  for (const { segKey, dataIndices } of segments) {
    if (dataIndices.length === 0) continue;
    const first = dataIndices[0];
    const last = dataIndices[dataIndices.length - 1];
    if (last < left || first > right) continue;

    const firstInside = lowerBound(dataIndices, left);
    for (let position = firstInside; position < dataIndices.length; position++) {
      const index = dataIndices[position];
      if (index > right) break;
      const value = valueAt(segKey, index);
      if (value != null) maximum = Math.max(maximum, value);
    }

    for (const boundary of [left, right]) {
      const after = lowerBound(dataIndices, boundary);
      if (after <= 0 || after >= dataIndices.length || dataIndices[after] === boundary) continue;
      const beforeIndex = dataIndices[after - 1];
      const afterIndex = dataIndices[after];
      const beforeValue = valueAt(segKey, beforeIndex);
      const afterValue = valueAt(segKey, afterIndex);
      if (beforeValue == null || afterValue == null) continue;
      const ratio = (boundary - beforeIndex) / (afterIndex - beforeIndex);
      maximum = Math.max(maximum, beforeValue + (afterValue - beforeValue) * ratio);
    }
  }

  return paddedYAxisMax(maximum);
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
