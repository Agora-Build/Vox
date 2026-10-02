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

afterEach(() => vi.restoreAllMocks());

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
    expect(storage.getMetricsDetail).toHaveBeenCalledWith("mainline", { from: FROM, to: FROM + 3600000 }, undefined, undefined, "web");
  });

  it("rejects unsupported tiers, transports, and overly broad detail windows", async () => {
    await request(app).get(`/api/metrics/constructor/detail?${windowQuery}`).expect(400);
    await request(app).get(`/api/metrics/realtime/detail?${windowQuery}&transport=other`).expect(400);
    await request(app).get(`/api/metrics/realtime/detail?from=${FROM}&to=${FROM + 91 * 86400000}`).expect(400);
    expect(storage.getMetricsDetail).not.toHaveBeenCalled();
  });
});
