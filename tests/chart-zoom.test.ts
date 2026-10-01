import { describe, expect, it } from "vitest";
import {
  clampChartRange,
  defaultChartRange,
  panChartRange,
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

  it("converts wheel direction and units into proportional scales", () => {
    expect(wheelZoomScale(100, 0, 600)).toBeGreaterThan(1);
    expect(wheelZoomScale(-100, 0, 600)).toBeLessThan(1);
    expect(wheelZoomScale(3, 1, 600)).toBeGreaterThan(wheelZoomScale(3, 0, 600));
  });
});
