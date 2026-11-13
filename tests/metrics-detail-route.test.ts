import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import { createServer } from "http";
import request from "supertest";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";

const FROM = Date.UTC(2026, 0, 1);
const windowQuery = `from=${FROM}&to=${FROM + 3600000}`;
let app: Express;

beforeEach(async () => {
  app = express();
  app.use((req, _res, next) => {
    const userId = req.header("x-test-user");
    if (userId) (req as unknown as { session: { userId: number } }).session = { userId: Number(userId) };
    next();
  });
  // Route mounting installs background schedulers; never run them in this isolated test.
  const timers = vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref() {} } as NodeJS.Timeout);
  try {
    await registerRoutes(createServer(app), app);
  } finally {
    timers.mockRestore();
  }
  vi.spyOn(storage, "getAllProviders").mockResolvedValue([]);
  vi.spyOn(storage, "getAllRegionLocations").mockResolvedValue([]);
  vi.spyOn(storage, "getMetricsDetail").mockResolvedValue({ from: FROM, to: FROM + 3600000, resolution: "raw", truncated: false, metrics: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("metrics detail routes", () => {
  it("rejects unauthenticated and disabled users before querying or reading cached private data", async () => {
    const user = vi.spyOn(storage, "getUser").mockResolvedValue({ id: 1, isEnabled: true } as never);
    await request(app).get(`/api/metrics/my-evals/detail?${windowQuery}`).expect(401);
    expect(storage.getMetricsDetail).not.toHaveBeenCalled();
    await request(app).get(`/api/metrics/my-evals/detail?${windowQuery}`).set("x-test-user", "1").expect(200);
    user.mockResolvedValue({ id: 1, isEnabled: false } as never);
    await request(app).get(`/api/metrics/my-evals/detail?${windowQuery}`).set("x-test-user", "1").expect(401);
    expect(storage.getMetricsDetail).toHaveBeenCalledTimes(1);
  });

  it("partitions private cache entries by user and passes the authenticated identity to storage", async () => {
    vi.spyOn(storage, "getUser").mockImplementation(async id => ({ id, isEnabled: true }) as never);
    await request(app).get(`/api/metrics/my-evals/detail?${windowQuery}`).set("x-test-user", "1").expect(200);
    await request(app).get(`/api/metrics/my-evals/detail?${windowQuery}`).set("x-test-user", "2").expect(200);
    expect(storage.getMetricsDetail).toHaveBeenCalledTimes(2);
    expect(vi.mocked(storage.getMetricsDetail).mock.calls.map(call => call[2])).toEqual([1, 2]);
  });

  it("normalizes public detail cache keys on the server", async () => {
    for (const offset of [1, 2]) {
      await request(app).get(`/api/metrics/realtime/detail?from=${FROM + offset}&to=${FROM + 3600000 - offset}`).expect(200);
    }
    expect(storage.getMetricsDetail).toHaveBeenCalledTimes(1);
    expect(storage.getMetricsDetail).toHaveBeenCalledWith("mainline", { from: FROM, to: FROM + 3600000 }, undefined, undefined, "web", [], "all");
  });

  it("defaults to All and partitions Strict from overview and chart-detail caches", async () => {
    const overview = vi.spyOn(storage, "getMainlineMetrics").mockResolvedValue([]);
    vi.spyOn(storage, "getProvider").mockResolvedValue({ id: "health-test", name: "Health test" } as never);
    const leaderboard = vi.spyOn(storage, "getTierEvalResults").mockResolvedValue([
      { id: 1, providerId: "health-test", siteId: null, responseLatencyMedian: 100, jobTags: [] } as never,
    ]);
    for (const path of ["/api/metrics/realtime", "/api/metrics/leaderboard", `/api/metrics/realtime/detail?${windowQuery}`]) {
      const join = path.includes("?") ? "&" : "?";
      for (const filter of ["", `${join}health=all`, `${join}health=strict`]) {
        await request(app).get(`${path}${filter}`).expect(200);
      }
      await request(app).get(`${path}${join}network=strict`).expect(400);
      await request(app).get(`${path}${join}extra=ignored`).expect(400);
    }
    expect(overview).toHaveBeenCalledTimes(2);
    expect(overview.mock.calls.map((call) => call[3]?.health)).toEqual(["all", "strict"]);
    expect(leaderboard).toHaveBeenCalledTimes(2);
    expect(leaderboard.mock.calls.map((call) => call[2]?.health)).toEqual(["all", "strict"]);
    expect(storage.getMetricsDetail).toHaveBeenCalledTimes(2);
    expect(vi.mocked(storage.getMetricsDetail).mock.calls.map((call) => call[6])).toEqual(["all", "strict"]);
  });

  it.each(["health=other", "health=strict&health=all"])("rejects invalid or repeated health selectors %s", async (filter) => {
    const overview = vi.spyOn(storage, "getMainlineMetrics").mockResolvedValue([]);
    const leaderboard = vi.spyOn(storage, "getTierEvalResults").mockResolvedValue([]);
    for (const path of ["/api/metrics/realtime", "/api/metrics/leaderboard", `/api/metrics/realtime/detail?${windowQuery}`,
      "/api/v1/metrics/realtime", "/api/v1/metrics/leaderboard"]) {
      await request(app).get(`${path}${path.includes("?") ? "&" : "?"}${filter}`).expect(400);
    }
    expect(overview).not.toHaveBeenCalled();
    expect(leaderboard).not.toHaveBeenCalled();
    expect(storage.getMetricsDetail).not.toHaveBeenCalled();
  });

  it.each(["network=all", "network=strict", "health=strict&network=all", "strict=all", "helath=strict", "extra=value", "__proto__=all", "toString=all"])("rejects unsupported query parameters %s across all metrics endpoints", async (filter) => {
    vi.spyOn(storage, "getUser").mockResolvedValue({ id: 1, isEnabled: true } as never);
    const overview = vi.spyOn(storage, "getMainlineMetrics").mockResolvedValue([]);
    const leaderboard = vi.spyOn(storage, "getTierEvalResults").mockResolvedValue([]);
    const coverage = vi.spyOn(storage, "getNetworkCoverage").mockResolvedValue({ stable: 0, changed: 0, unverified: 0 });
    const available = vi.spyOn(storage, "getAvailableRegions").mockResolvedValue({ baseIds: [], hasUnverified: false });
    for (const path of ["/api/metrics/realtime", "/api/metrics/community", "/api/metrics/my-evals", "/api/metrics/leaderboard",
      `/api/metrics/realtime/detail?${windowQuery}`, `/api/metrics/community/detail?${windowQuery}`, `/api/metrics/my-evals/detail?${windowQuery}`,
      "/api/metrics/available-regions?tier=realtime", "/api/metrics/network-coverage?tier=realtime",
      "/api/v1/metrics/realtime", "/api/v1/metrics/leaderboard"]) {
      const res = await request(app).get(`${path}${path.includes("?") ? "&" : "?"}${filter}`).set("x-test-user", "1").expect(400);
      expect(res.body.error).toContain("Unsupported query parameter(s):");
      expect(res.body.error).toContain("Supported parameters:");
    }
    expect(overview).not.toHaveBeenCalled();
    expect(leaderboard).not.toHaveBeenCalled();
    expect(coverage).not.toHaveBeenCalled();
    expect(available).not.toHaveBeenCalled();
    expect(storage.getMetricsDetail).not.toHaveBeenCalled();
  });

  it.each(["realtime", "leaderboard"])("v1 %s defaults to All, accepts opt-in Strict, and exposes canonical health metadata", async (endpoint) => {
    const results = vi.spyOn(storage, "getTierEvalResults").mockResolvedValue([]);
    for (const [query, mode] of [["", "all"], ["?health=all", "all"], ["?health=strict", "strict"]]) {
      const res = await request(app).get(`/api/v1/metrics/${endpoint}${query}`).expect(200);
      expect(res.body.meta).toMatchObject({ health: mode });
      expect(res.body.meta).not.toHaveProperty("network");
      expect(results.mock.lastCall?.[2]?.health).toBe(mode);
    }
  });

  it("region availability defaults to All and keeps Strict opt-in", async () => {
    const available = vi.spyOn(storage, "getAvailableRegions").mockResolvedValue({ baseIds: [], hasUnverified: false });
    for (const filter of ["", "&health=all", "&health=strict"]) {
      await request(app).get(`/api/metrics/available-regions?tier=realtime${filter}`).expect(200);
    }
    expect(available).toHaveBeenCalledTimes(2);
    expect(available.mock.calls.map((call) => call[4]?.health)).toEqual(["all", "strict"]);
  });

  it("rejects unsupported tiers, transports, and overly broad detail windows", async () => {
    await request(app).get(`/api/metrics/constructor/detail?${windowQuery}`).expect(400);
    await request(app).get(`/api/metrics/realtime/detail?${windowQuery}&transport=other`).expect(400);
    await request(app).get(`/api/metrics/realtime/detail?from=${FROM}&to=${FROM + 91 * 86400000}`).expect(400);
    expect(storage.getMetricsDetail).not.toHaveBeenCalled();
  });

  it("limits public detail request bursts without affecting overview requests", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RATE_LIMIT_DISABLED", "false");
    for (let i = 0; i < 60; i++) await request(app).get(`/api/metrics/realtime/detail?${windowQuery}`).expect(200);
    await request(app).get(`/api/metrics/realtime/detail?${windowQuery}`).expect(429);
    vi.spyOn(storage, "getMainlineMetrics").mockResolvedValue([]);
    await request(app).get("/api/metrics/realtime").expect(200);
  });

  it("does not rate-limit local detail navigation", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RATE_LIMIT_DISABLED", "false");
    for (let i = 0; i < 61; i++) await request(app).get(`/api/metrics/realtime/detail?${windowQuery}`).expect(200);
  });
});
