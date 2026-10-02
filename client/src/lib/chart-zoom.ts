import { format } from "date-fns";

export interface ChartRange {
  start: number;
  end: number;
}

export type ChartDomain = [number, number];

export interface ChartMetric {
  id?: number;
  providerId: string;
  provider: string;
  responseLatency: number | null;
  interruptLatency: number | null;
  turnSuccessRate: number | null;
  timestamp: string;
  evalFlowId?: number | null;
  evalFlowName?: string | null;
  resolution?: string;
}

export interface CombinedChartRow {
  chartIndex: number;
  timestamp: string;
  rawTime: number;
  chartTime?: number;
  [key: string]: string | number | undefined;
}

interface ChartProviders {
  data: CombinedChartRow[];
  providers: Array<{ key: string; name: string; stroke: string }>;
}

const PROVIDER_PALETTE = [
  "#f97316",
  "#22c55e",
  "#a855f7",
  "#ef4444",
  "#eab308",
];

function fallbackProviderColor(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index++) {
    hash = ((hash << 5) - hash + id.charCodeAt(index)) | 0;
  }
  return PROVIDER_PALETTE[((hash % PROVIDER_PALETTE.length) + PROVIDER_PALETTE.length) % PROVIDER_PALETTE.length];
}

function providerKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function buildCombinedChartData(
  metrics: readonly ChartMetric[],
  colorMap: ReadonlyMap<string, string>,
  hiddenProviders?: ReadonlySet<string>,
  timeBucketMs = 60000,
): ChartProviders {
  if (metrics.length === 0) return { data: [], providers: [] };

  const providerInfo = new Map<string, { id: string; name: string }>();
  for (const metric of metrics) {
    if (hiddenProviders?.has(metric.providerId)) continue;
    if (!providerInfo.has(metric.providerId)) {
      providerInfo.set(metric.providerId, { id: metric.providerId, name: metric.provider });
    }
  }

  const providers = Array.from(providerInfo.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ id, name }) => ({
      key: providerKey(name),
      name,
      stroke: colorMap.get(id) || fallbackProviderColor(id),
    }));
  const nameToKey = new Map(providers.map(provider => [provider.name, provider.key]));
  const timeGroups = new Map<number, {
    counts: Map<string, number>;
    layers: Array<{ rawTime: number; values: Map<string, ChartMetric> }>;
  }>();

  // Keep every timestamp on the X axis so hiding a provider cannot shift the view.
  const orderedMetrics = timeBucketMs === 1 ? [...metrics].sort((a, b) => (a.id ?? 0) - (b.id ?? 0)) : metrics;
  for (const metric of orderedMetrics) {
    const time = new Date(metric.timestamp).getTime();
    if (!Number.isFinite(time)) continue;
    const timeKey = Math.floor(time / timeBucketMs) * timeBucketMs;
    const timeGroup = timeGroups.get(timeKey) ?? { counts: new Map(), layers: [] };
    timeGroups.set(timeKey, timeGroup);
    // Raw tests can share a timestamp. Allocate layers before filtering providers.
    const layer = timeBucketMs === 1 ? timeGroup.counts.get(metric.providerId) ?? 0 : 0;
    timeGroup.counts.set(metric.providerId, layer + 1);
    const group = timeGroup.layers[layer] ?? { rawTime: timeKey, values: new Map() };
    timeGroup.layers[layer] = group;
    const key = nameToKey.get(metric.provider);
    if (key && !group.values.has(key)) group.values.set(key, metric);
  }

  let previousChartTime = -Infinity;
  const data = Array.from(timeGroups.values())
    .sort((a, b) => a.layers[0].rawTime - b.layers[0].rawTime)
    .flatMap(({ layers }) => layers.map((group, index) => {
      // Tiny collision-safe offsets retain every test; tooltips keep the original timestamp.
      const step = Math.max(0.000001, Math.abs(group.rawTime) * Number.EPSILON);
      const chartTime = Math.max(group.rawTime + index / layers.length, previousChartTime + step);
      previousChartTime = chartTime;
      return { ...group, chartTime };
    }))
    .map((group, chartIndex) => {
      const row: CombinedChartRow = {
        chartIndex,
        timestamp: format(new Date(group.rawTime), "MM/dd/yy HH:mm"),
        rawTime: group.rawTime,
        chartTime: group.chartTime,
        resolution: group.values.values().next().value?.resolution,
      };
      for (const provider of providers) {
        const metric = group.values.get(provider.key);
        row[`${provider.key}_response`] = metric?.responseLatency ?? undefined;
        row[`${provider.key}_interrupt`] = metric?.interruptLatency ?? undefined;
        row[`${provider.key}_tsr`] = metric?.turnSuccessRate != null
          ? Math.round(metric.turnSuccessRate * 100)
          : undefined;
        row[`${provider.key}_wfname`] = metric?.evalFlowName ?? undefined;
        row[`${provider.key}_wfid`] = metric?.evalFlowId ?? undefined;
      }
      return row;
    });

  return { data, providers };
}

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

function lowerBound(values: readonly number[], target: number, position = (value: number) => value): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (position(values[middle]) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Select visible rows plus only the sparse neighbors needed for clipped paths. */
export function segmentRenderIndices(
  range: ChartRange,
  totalLength: number,
  segments: ReadonlyArray<readonly number[]>,
  exactBounds = false,
): number[] {
  const total = Math.max(0, totalLength);
  const visible = exactBounds ? range : visibleChartRange(range, total);
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
  timeDomain?: ChartDomain,
): number {
  if (rows.length === 0) return 1;
  const [left, right] = timeDomain ?? chartRangeDomain(range, rows.length);
  const x = (index: number) => timeDomain ? Number(rows[index].chartTime ?? rows[index].rawTime) : index;
  let maximum = 0;

  const valueAt = (segKey: string, index: number): number | null => {
    const value = rows[index]?.[segKey];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };

  for (const { segKey, dataIndices } of segments) {
    if (dataIndices.length === 0) continue;
    const first = dataIndices[0];
    const last = dataIndices[dataIndices.length - 1];
    if (x(last) < left || x(first) > right) continue;

    const firstInside = lowerBound(dataIndices, left, x);
    for (let position = firstInside; position < dataIndices.length; position++) {
      const index = dataIndices[position];
      if (x(index) > right) break;
      const value = valueAt(segKey, index);
      if (value != null) maximum = Math.max(maximum, value);
    }

    for (const boundary of [left, right]) {
      const after = lowerBound(dataIndices, boundary, x);
      if (after <= 0 || after >= dataIndices.length || x(dataIndices[after]) === boundary) continue;
      const beforeIndex = dataIndices[after - 1];
      const afterIndex = dataIndices[after];
      const beforeValue = valueAt(segKey, beforeIndex);
      const afterValue = valueAt(segKey, afterIndex);
      if (beforeValue == null || afterValue == null) continue;
      const ratio = (boundary - x(beforeIndex)) / (x(afterIndex) - x(beforeIndex));
      maximum = Math.max(maximum, beforeValue + (afterValue - beforeValue) * ratio);
    }
  }

  return paddedYAxisMax(maximum);
}

export function defaultChartRange(totalLength: number, defaultWindow = DEFAULT_CHART_WINDOW): ChartRange {
  const total = Math.max(0, totalLength);
  return {
    start: Math.max(0, total - defaultWindow),
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
  const total = Math.max(0, nextLength);
  // Preserve the window while provider filters temporarily hide every point.
  if (total === 0) return { ...range };

  const previous = clampChartRange(range, previousLength);
  if (!pinToLatest) return clampChartRange(previous, total);
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

/** Find row offsets in a temporal viewport, including empty windows between sparse points. */
export function timeDomainBounds(rows: readonly CombinedChartRow[], domain: ChartDomain): ChartRange {
  const bound = (target: number) => {
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((rows[middle].chartTime ?? rows[middle].rawTime) < target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return { start: bound(domain[0]), end: bound(domain[1] + 1) };
}

/** Convert browser wheel units into a bounded, proportional zoom scale. */
export function wheelZoomScale(
  deltaY: number,
  deltaMode: number,
  pageHeight: number,
  sensitivity = 1,
): number {
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(1, pageHeight) : 1;
  const normalizedDelta = clamp(deltaY * unit, -240, 240);
  return Math.exp(normalizedDelta * 0.0015 * Math.max(0, sensitivity));
}
