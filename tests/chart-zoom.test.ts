import { describe, expect, it } from "vitest";
import {
  chartDomainTicks,
  chartRangeDomain,
  clampChartRange,
  defaultChartRange,
  overscanChartRange,
  panChartRange,
  stableYAxisMax,
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

  it("enforces the minimum window and handles an empty dataset", () => {
    expect(clampChartRange({ start: 20, end: 21 }, 100)).toEqual({ start: 20, end: 30 });
    expect(clampChartRange({ start: 10, end: 20 }, 0)).toEqual({ start: 0, end: 0 });
  });

  it("maps fractional windows to continuous centered domains", () => {
    expect(chartRangeDomain({ start: 20.25, end: 60.25 }, 100)).toEqual([19.75, 59.75]);
    expect(chartRangeDomain({ start: 0, end: 0 }, 0)).toEqual([0, 1]);
  });

  it("retains overscan rows outside the visible domain", () => {
    expect(overscanChartRange({ start: 20.25, end: 60.25 }, 100)).toEqual({ start: 19, end: 62 });
    expect(overscanChartRange({ start: 0, end: 20 }, 100, 2)).toEqual({ start: 0, end: 22 });
    expect(overscanChartRange({ start: 80, end: 100 }, 100, 2)).toEqual({ start: 78, end: 100 });
  });

  it("keeps tick positions and Y domains stable during navigation", () => {
    expect(chartDomainTicks([10, 40], 4)).toEqual([10, 20, 30, 40]);
    expect(stableYAxisMax([
      { alpha: 1200, beta: 2600 },
      { alpha: 800, beta: null },
    ], ["alpha", "beta"])).toBe(2800);
    expect(stableYAxisMax([{ alpha: null }], ["alpha"])).toBe(1);
  });

  it("converts wheel direction and units into proportional scales", () => {
    expect(wheelZoomScale(100, 0, 600)).toBeGreaterThan(1);
    expect(wheelZoomScale(-100, 0, 600)).toBeLessThan(1);
    expect(wheelZoomScale(3, 1, 600)).toBeGreaterThan(wheelZoomScale(3, 0, 600));
  });
});
