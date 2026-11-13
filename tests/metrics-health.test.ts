import { describe, expect, it } from "vitest";
import { parseMetricsTags, tagsCacheKey, validateMetricsQuery } from "../server/metrics-params";

function validateQuery(query: Record<string, string | string[]>, view: Parameters<typeof validateMetricsQuery>[1]) {
  const params = new URLSearchParams();
  for (const [key, values] of Object.entries(query)) {
    for (const value of Array.isArray(values) ? values : [values]) params.append(key, value);
  }
  return validateMetricsQuery(`/api/metrics?${params}`, view);
}

describe("metrics Agent Health query contract", () => {
  it("includes all otherwise eligible runs unless Strict is explicitly requested", () => {
    expect(parseMetricsTags({})).toEqual({ tagFilters: [], groupBy: undefined, health: "all" });
    expect(parseMetricsTags({ health: "all" })).toEqual(parseMetricsTags({}));
    expect(parseMetricsTags({ health: "strict" })).toMatchObject({ health: "strict" });
  });

  it.each(["", "true", "false", "All", null, {}, ["strict"], ["strict", "all"]])("rejects invalid or repeated health values %j", (health) => {
    expect(parseMetricsTags({ health })).toHaveProperty("error");
  });

  it("shares All/default cache entries and isolates Strict", () => {
    const cacheKey = (query: Parameters<typeof parseMetricsTags>[0]) => {
      const parsed = parseMetricsTags(query);
      if ("error" in parsed) throw new Error(parsed.error);
      return tagsCacheKey(parsed);
    };
    expect(cacheKey({})).toBe(cacheKey({ health: "all" }));
    expect(cacheKey({ health: "strict" })).not.toBe(cacheKey({}));
  });

  it("retains explicit tag filtering and grouping in both health modes", () => {
    for (const health of ["all", "strict"]) {
      expect(parseMetricsTags({ health, tag: ["isp:att", "access:lastmile"], groupBy: "link" })).toMatchObject({
        health, groupBy: "link", tagFilters: [{ key: "isp", value: "att" }, { key: "access", value: "lastmile" }],
      });
    }
  });
});

describe("metrics query parameter allowlists", () => {
  it.each(["overview", "detail", "availability", "coverage", "v1Realtime", "v1Leaderboard"] as const)("rejects old selectors and misspellings for %s", (view) => {
    for (const key of ["network", "strict", "helath", "unused", "__proto__", "toString", "health[]"]) {
      expect(validateQuery({ [key]: "strict" }, view)?.error).toContain(`Unsupported query parameter(s): ${key}.`);
      expect(validateQuery({ health: "strict", [key]: "all" }, view)).toHaveProperty("error");
    }
    expect(validateQuery({ tag: ["link:wifi"], transport: "web" }, view)).toBeUndefined();
    if (view !== "coverage") expect(validateQuery({ health: "strict" }, view)).toBeUndefined();
  });

  it("only accepts selectors meaningful for each endpoint", () => {
    expect(validateMetricsQuery("/api/metrics/realtime", "overview")).toBeUndefined();
    expect(validateQuery({ hours: "24", groupBy: "isp", country: "US" }, "overview")).toBeUndefined();
    expect(validateQuery({ tier: "mine", hours: "24", limit: "50" }, "v1Realtime")).toBeUndefined();
    expect(validateQuery({ tier: "mainline", groupBy: "link", regionScope: ["country:US"] }, "v1Leaderboard")).toBeUndefined();
    expect(validateQuery({ from: "1", to: "2", siteId: "na-us-seattle-01" }, "detail")).toBeUndefined();
    expect(validateQuery({ tier: "realtime", hours: "24" }, "availability")).toBeUndefined();
    expect(validateQuery({ tier: "community", hours: "24", country: "US" }, "coverage")).toBeUndefined();
    for (const view of ["overview", "v1Leaderboard", "detail", "availability", "coverage"] as const) {
      expect(validateQuery({ limit: "50" }, view)).toHaveProperty("error");
    }
    for (const view of ["detail", "availability", "coverage"] as const) {
      expect(validateQuery({ groupBy: "link" }, view)).toHaveProperty("error");
    }
    expect(validateQuery({ hours: "24" }, "detail")).toHaveProperty("error");
    expect(validateQuery({ country: "US" }, "availability")).toHaveProperty("error");
    expect(validateQuery({ health: "strict" }, "coverage")).toHaveProperty("error");
  });
});
