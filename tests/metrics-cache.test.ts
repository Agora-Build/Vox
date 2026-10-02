import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricsCache } from "../server/metrics-cache";

afterEach(() => vi.restoreAllMocks());

describe("metrics cache", () => {
  it("caps each cache independently so viewport traffic cannot evict overview data", () => {
    const overview = new MetricsCache(2);
    const detail = new MetricsCache(2);
    overview.set("realtime", [1]);
    for (let i = 0; i < 100; i++) detail.set(String(i), [i]);
    expect(overview.get("realtime")).toEqual([1]);
    expect(detail.get("97")).toBeNull();
    expect(detail.get("98")).toEqual([98]);
    expect(detail.get("99")).toEqual([99]);
  });

  it("expires entries and refreshes existing entries without evicting unrelated keys", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const cache = new MetricsCache(2, 100);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 3);
    expect(cache.get("a")).toBe(3);
    expect(cache.get("b")).toBe(2);
    now.mockReturnValue(100);
    expect(cache.get("a")).toBeNull();
    cache.set("c", 4);
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toBe(4);
  });
});
