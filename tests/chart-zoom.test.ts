import { describe, expect, it } from "vitest";
import {
  chartDomainTicks,
  chartRangeDomain,
  clampChartRange,
  defaultChartRange,
  overscanChartRange,
  panChartRange,
  resizeChartRange,
  segmentOverscanChartRange,
  segmentYAxisMax,
  stableYAxisMax,
  visibleChartRange,
  wheelZoomScale,
  zoomChartRange,
} from "../client/src/lib/chart-zoom";

describe("chart zoom range math", () => {
  it("shows the newest 100 points by default", () => {
    expect(defaultChartRange(250)).toEqual({ start: 150, end: 250 });
    expect(defaultChartRange(8)).toEqual({ start: 0, end: 8 });
  });

  it("zooms proportionally around the pointer anchor", () => {
    const centered = zoomChartRange({ start: 100, end: 200 }, 300, 0.5, 0.5);
    expect(centered.start).toBeCloseTo(125);
    expect(centered.end).toBeCloseTo(175);

    const anchoredAtEnd = zoomChartRange({ start: 100, end: 200 }, 300, 0.5, 1);
    expect(anchoredAtEnd).toEqual({ start: 150, end: 200 });
  });

  it("keeps fractional panning and clamps at both dataset edges", () => {
    expect(panChartRange({ start: 20, end: 60 }, 100, 2.5)).toEqual({ start: 22.5, end: 62.5 });
    expect(panChartRange({ start: 20, end: 60 }, 100, -100)).toEqual({ start: 0, end: 40 });
    expect(panChartRange({ start: 20, end: 60 }, 100, 100)).toEqual({ start: 60, end: 100 });
  });

  it("keeps a live-edge window pinned when new data arrives", () => {
    expect(resizeChartRange({ start: 150, end: 250 }, 250, 251, true))
      .toEqual({ start: 151, end: 251 });
    expect(resizeChartRange({ start: 100, end: 200 }, 250, 251, false))
      .toEqual({ start: 100, end: 200 });
    expect(resizeChartRange({ start: 150, end: 250 }, 250, 240, true))
      .toEqual({ start: 140, end: 240 });
  });

  it("enforces the minimum window and handles an empty dataset", () => {
    expect(clampChartRange({ start: 20, end: 21 }, 100)).toEqual({ start: 20, end: 30 });
    expect(clampChartRange({ start: 10, end: 20 }, 0)).toEqual({ start: 0, end: 0 });
  });

  it("maps fractional windows to continuous centered domains", () => {
    expect(chartRangeDomain({ start: 20.25, end: 60.25 }, 100)).toEqual([19.75, 59.75]);
    expect(chartRangeDomain({ start: 0, end: 0 }, 0)).toEqual([0, 1]);
  });

  it("retains the right overscan points for dense and sparse series", () => {
    expect(visibleChartRange({ start: 20.75, end: 60.75 }, 100))
      .toEqual({ start: 21, end: 61 });
    expect(overscanChartRange({ start: 20.25, end: 60.25 }, 100))
      .toEqual({ start: 19, end: 61 });
    expect(overscanChartRange({ start: 0, end: 20 }, 100, 2))
      .toEqual({ start: 0, end: 22 });
    expect(overscanChartRange({ start: 80, end: 100 }, 100, 2))
      .toEqual({ start: 78, end: 100 });
    expect(segmentOverscanChartRange(
      { start: 20, end: 40 },
      100,
      [[5, 25, 60], [0, 4]],
    )).toEqual({ start: 5, end: 61 });
  });

  it("builds tick positions and padded Y bounds", () => {
    expect(chartDomainTicks([10, 40], 4)).toEqual([10, 20, 30, 40]);
    expect(chartDomainTicks([-0.5, 0.5], 1)).toEqual([0]);
    expect(stableYAxisMax([
      { alpha: 1200, beta: 2600 },
      { alpha: 800, beta: null },
    ], ["alpha", "beta"])).toBe(2800);
    expect(stableYAxisMax([{ alpha: null }], ["alpha"])).toBe(1);
    expect(stableYAxisMax([{ alpha: 0.5 }], ["alpha"])).toBe(0.53);

    const rows = Array.from({ length: 61 }, () => ({} as Record<string, number>));
    rows[5].series = 9000;
    rows[25].series = 100;
    rows[30].series = 200;
    rows[60].series = 5000;
    expect(segmentYAxisMax(
      rows,
      [{ segKey: "series", dataIndices: [5, 25, 30, 60] }],
      { start: 20, end: 40 },
    )).toBe(2700);
  });

  it("converts wheel direction and units into proportional scales", () => {
    expect(wheelZoomScale(100, 0, 600)).toBeGreaterThan(1);
    expect(wheelZoomScale(-100, 0, 600)).toBeLessThan(1);
    expect(wheelZoomScale(3, 1, 600)).toBeGreaterThan(wheelZoomScale(3, 0, 600));
  });
});
