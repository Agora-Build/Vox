import { describe, expect, it } from "vitest";
import { detailWindow, mergeMetricDetail, metricsDetailResolution, metricsResolution, METRICS_DAY_MS as DAY, parseMetricsDetailWindow } from "../shared/metrics-window";
import { buildCombinedChartData, defaultChartRange, segmentRenderIndices, segmentYAxisMax, timeDomainBounds, zoomChartRange, type ChartMetric } from "../client/src/lib/chart-zoom";

describe("adaptive metrics windows", () => {
  it("uses individual tests within seven days and hourly averages within ninety", () => {
    expect(metricsResolution(7 * DAY)).toBe("raw");
    expect(metricsResolution(7 * DAY + 1)).toBe("hour");
    expect(metricsResolution(90 * DAY)).toBe("hour");
    expect(metricsResolution(90 * DAY + 1)).toBe("day");
  });

  it("aligns detail requests but skips broad history and invalid windows", () => {
    const from = Date.parse("2026-01-01T12:01:01Z");
    expect(detailWindow(from, from + 600000)).toEqual({ from: from - 1000, to: from + 659000 });
    expect(detailWindow(from, from + 30 * DAY)).toEqual({ from: from - 61000, to: from + 30 * DAY + 3539000 });
    expect(detailWindow(from, from + 91 * DAY)).toBeNull();
    expect(detailWindow(NaN, from)).toBeNull();
    expect(detailWindow(from, from)).toBeNull();
  });

  it("rejects malformed, unordered, oversized, and out-of-date-range API parameters", () => {
    const from = Date.parse("2026-01-01Z");
    expect(parseMetricsDetailWindow(String(from), String(from + DAY))).toEqual({ from, to: from + DAY });
    for (const [a, b] of [[undefined, "1"], ["", "1"], [["1"], "2"], ["NaN", "2"], ["1.1", "2"], ["2", "1"], ["-1", "2"], ["1", String(1095 * DAY + 2)], ["8640000000000000", "8640000000000001"]]) {
      expect(parseMetricsDetailWindow(a, b)).toHaveProperty("error");
    }
  });

  it("canonicalizes server cache keys and rejects overly broad detail requests", () => {
    expect(parseMetricsDetailWindow("1", "59999")).toEqual(parseMetricsDetailWindow("2", "59998"));
    expect(parseMetricsDetailWindow("0", String(91 * DAY))).toHaveProperty("error");
  });

  it("retains the intended resolution at outward-aligned seven- and ninety-day boundaries", () => {
    const from = Date.parse("2026-01-01T12:01:01Z");
    for (const [days, resolution] of [[7, "raw"], [90, "hour"]] as const) {
      const request = detailWindow(from, from + days * DAY)!;
      const parsed = parseMetricsDetailWindow(String(request.from), String(request.to));
      expect(parsed).not.toHaveProperty("error");
      if ("error" in parsed) throw new Error(parsed.error);
      expect(parsed).toEqual(request);
      expect(metricsDetailResolution(parsed.to - parsed.from)).toBe(resolution);
    }
  });

  it("replaces buckets only within the requested historical interval, including empty detail", () => {
    const overview = [0, DAY, 2 * DAY].map(time => ({ timestamp: new Date(time).toISOString(), value: 100 }));
    const detail = { from: DAY, to: 2 * DAY, metrics: [{ timestamp: new Date(DAY + 3600000).toISOString(), value: 250 }] };
    expect(mergeMetricDetail(overview, detail).map(row => row.value)).toEqual([100, 100, 250]);
    expect(mergeMetricDetail(overview, { ...detail, metrics: [] })).toEqual([overview[0], overview[2]]);
    expect(mergeMetricDetail(overview, null)).toEqual(overview);
  });

  it("removes daily buckets overlapping partial-day detail on either boundary", () => {
    const overview = [0, DAY, 2 * DAY, 3 * DAY].map(time => ({ timestamp: new Date(time).toISOString() }));
    const detail = { from: DAY + 3600000, to: 2 * DAY + 3600000, metrics: [{ timestamp: new Date(DAY + 3600000).toISOString() }] };
    expect(mergeMetricDetail(overview, detail)).toEqual([overview[0], overview[3], detail.metrics[0]]);
  });
});

describe("temporal chart navigation", () => {
  const metric = (time: number): ChartMetric => ({ providerId: "alpha", provider: "Alpha", timestamp: new Date(time).toISOString(), responseLatency: 100, interruptLatency: 50, turnSuccessRate: 0.9 });

  it("retains the exact dates and pointer anchor when detail adds many rows", () => {
    const overview = [0, DAY, 2 * DAY].map(metric);
    const domain: [number, number] = [DAY, 2 * DAY];
    const before = buildCombinedChartData(overview, new Map(), undefined, 1).data;
    const detailed = buildCombinedChartData([...overview, ...Array.from({ length: 24 }, (_, i) => metric(DAY + i * 3600000))], new Map(), undefined, 1).data;
    expect(timeDomainBounds(before, domain)).toEqual({ start: 1, end: 3 });
    expect(timeDomainBounds(detailed, domain)).toEqual({ start: 1, end: 26 });
    expect(defaultChartRange(200 * 1440, 100 * 1440)).toEqual({ start: 100 * 1440, end: 200 * 1440 });
    const range = { start: 1440, end: 2880 };
    const zoomed = zoomChartRange(range, 4320, 0.5, 0.25);
    expect(zoomed.start + (zoomed.end - zoomed.start) * 0.25).toBe(range.start + 360);
    expect(domain).toEqual([DAY, 2 * DAY]);
  });

  it("preserves individual tests in the same minute", () => {
    expect(buildCombinedChartData([metric(DAY + 1), metric(DAY + 2)], new Map(), undefined, 1).data).toHaveLength(2);
  });

  it("retains sparse crossing neighbors in an empty temporal window", () => {
    const rows = buildCombinedChartData([metric(0), metric(DAY), metric(2 * DAY)], new Map()).data;
    const bounds = timeDomainBounds(rows, [DAY / 3, DAY / 2]);
    expect(bounds).toEqual({ start: 1, end: 1 });
    expect(segmentRenderIndices(bounds, rows.length, [[0, 2]], true)).toEqual([0, 1, 2]);
  });

  it("interpolates Y bounds using elapsed time, not uneven row offsets", () => {
    const rows = [{ rawTime: 0, series: 100 }, { rawTime: 1 }, { rawTime: 1000, series: 900 }];
    expect(segmentYAxisMax(rows, [{ segKey: "series", dataIndices: [0, 2] }], { start: 1, end: 1 }, [100, 200])).toBe(280);
  });
});
