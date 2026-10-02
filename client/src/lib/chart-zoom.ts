export interface ChartRange {
  start: number;
  end: number;
}

export const DEFAULT_CHART_WINDOW = 100;
export const MIN_CHART_WINDOW = 10;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
