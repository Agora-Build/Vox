import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
await vi.hoisted(async () => {
  if (process.env.DATABASE_URL) {
    const { prepareIsolatedCoreDb } = await import("./helpers/isolated-core-db");
    process.env.DATABASE_URL = await prepareIsolatedCoreDb(process.env.DATABASE_URL, "vox_test_network_events_routes");
  }
});
vi.mock("../server/location", async (original) => ({ ...await original<typeof import("../server/location")>(), runAgentLocationCheck: vi.fn().mockResolvedValue({ region: null, siteId: null, locationTrust: "unknown" }) }));
vi.mock("../server/sim-carrier", async (original) => ({ ...await original<typeof import("../server/sim-carrier")>(), noteSimReport: vi.fn().mockResolvedValue(undefined) }));
import express from "express";
import { createServer } from "node:http";
import request from "supertest";
import { storage, pool, hashToken } from "../server/storage";
import { registerRoutes } from "../server/routes";
import type { EvalJob } from "../shared/schema";
import type { NetworkReport } from "../shared/network-events";

const d = process.env.DATABASE_URL ? describe : describe.skip;
d("network event HTTP contract and benchmark policy", () => {
  const app = express();
  const token = "network-events-route-test-only", leaseId = "route-test-lease";
  let agentId: number, tokenId: number, providerId: string, job: EvalJob;
  let tag = "";
  const auth = (req: request.Test) => req.set("Authorization", `Bearer ${token}`);
  const report = (): NetworkReport => ({ version: 1, jobId: job.id, startedAt: job.startedAt!.toISOString(), firstSeq: 100, lastSeq: 101,
    networkChanged: false, changeCount: 0, continuous: true, evictedThroughSeq: 0, events: [
      { seq: 100, event: "monitoring_start", timestamp: job.startedAt!.getTime(), offsetMs: 0, tags: { link: "wifi" }, changed: [] },
      { seq: 101, event: "monitoring_end", timestamp: job.startedAt!.getTime() + 1000, offsetMs: 1000, tags: { link: "wifi" }, changed: [] },
    ] });
  const identity = () => ({ id: tokenId, siteId: "na-us-seattle-01", region: "na-us-seattle", dispatchTier: "public", createdBy: 1, ownerOrgId: null, locationTrust: "trusted" });
  async function claimed(privateJob = false) {
    const pending = await storage.createEvalJob({ triggerType: 2, createdBy: 1, targetTokenId: tokenId, config: {}, status: "pending",
      snapshot: { creatorPlan: "principal", provider: { id: providerId },
        evalFlow: { visibility: privateJob ? "private" : "public", isMainline: true, ownerId: 1, tags: [{ key: "suite", value: tag }] },
        evalSet: { visibility: "public", isMainline: true },
      } as any });
    return (await storage.claimEvalJob(pending.id, agentId, identity()))!;
  }
  beforeAll(async () => {
    await pool.query("INSERT INTO users(id,username,email,plan,is_enabled) VALUES(1,'network-route-owner','route-owner@test.local','principal',true),(2,'network-route-other','route-other@test.local','premium',true)");
    providerId = (await storage.createProvider({ name: "network route test", sku: "convoai" } as any)).id;
    tokenId = (await storage.createEvalAgentToken({ name: "network route test", tokenHash: hashToken(token), createdBy: 1, dispatchTier: "public", siteId: "na-us-seattle-01" } as any)).id;
    agentId = (await storage.createEvalAgent({ name: "network route test", tokenId, state: "idle" } as any)).id;
    app.use(express.json());
    app.use((req, _res, next) => { const userId = req.header("x-test-user"); if (userId) (req as any).session = { userId: Number(userId) }; next(); });
    const timers = vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref() {} } as NodeJS.Timeout);
    try { await registerRoutes(createServer(app), app); } finally { timers.mockRestore(); }
  });
  beforeEach(async () => {
    tag = `events${Date.now()}${Math.floor(Math.random() * 100000)}`;
    await pool.query("UPDATE eval_agents SET current_lease_id=$2, observed_ip='127.0.0.1', link_type='wifi' WHERE id=$1", [agentId, leaseId]);
    job = await claimed();
  });
  afterAll(async () => { await pool.end(); });

  it("heartbeat acknowledges retries and rejects foreign lease and malformed reports", async () => {
    const body = { agentId, leaseId, linkType: "wifi", networkReport: report() };
    const first = await auth(request(app).post("/api/eval-agent/heartbeat")).send(body).expect(200);
    expect(first.body.networkAck).toMatchObject({ jobId: job.id, ackedEventSeqs: [100, 101] });
    expect((await auth(request(app).post("/api/eval-agent/heartbeat")).send(body).expect(200)).body.networkAck).toEqual(first.body.networkAck);
    await auth(request(app).post("/api/eval-agent/heartbeat")).send({ ...body, leaseId: "wrong" }).expect(403);
    await auth(request(app).post("/api/eval-agent/heartbeat")).send({ ...body, networkReport: { ...report(), ip: "10.1.1.1" } }).expect(400);
    await auth(request(app).post("/api/eval-agent/heartbeat")).send({ agentId, leaseId }).expect(200);
  });
  it("claim freezes the fresh caller IP/link and fences the lease", async () => {
    const pending = await storage.createEvalJob({ triggerType: 2, createdBy: 1, targetTokenId: tokenId, config: {}, status: "pending" });
    await auth(request(app).post(`/api/eval-agent/jobs/${pending.id}/claim`)).send({ agentId, leaseId: "old", linkType: "cellular" }).expect(403);
    const result = await auth(request(app).post(`/api/eval-agent/jobs/${pending.id}/claim`)).send({ agentId, leaseId, linkType: "cellular" }).expect(200);
    expect(result.body.tags).toContainEqual({ key: "link", value: "cellular", source: "detected" });
    expect(new Date(result.body.startedAt).getTime()).toBeGreaterThan(0);
  });
  it("completion commits the final report and idempotently returns its ack", async () => {
    const body = { agentId, leaseId, networkReport: report(), results: { responseLatencyMedian: 100 } };
    const path = `/api/eval-agent/jobs/${job.id}/complete`;
    expect((await auth(request(app).post(path)).send(body).expect(200)).body.networkAck.ackedEventSeqs).toEqual([100, 101]);
    expect((await storage.getEvalJob(job.id))?.networkMonitoring).toBe("complete");
    expect((await auth(request(app).post(path)).send(body).expect(200)).body.networkAck.ackedEventSeqs).toEqual([100, 101]);
    expect(await storage.getEvalResultsByJob(job.id)).toHaveLength(1);
  });
  it("job history requires authorization and exposes neither leases nor addresses", async () => {
    job = await claimed(true);
    const path = `/api/eval-jobs/${job.id}/network-events`;
    await request(app).get(path).expect(401);
    await request(app).get(path).set("x-test-user", "2").expect(403);
    const history = await request(app).get(path).set("x-test-user", "1").expect(200);
    expect(history.body.events[0].event).toBe("initial");
    expect(JSON.stringify(history.body)).not.toMatch(/127\.0|leaseId|route-test-lease|agentId/);
    await request(app).get(`${path}?cursor=-1`).set("x-test-user", "1").expect(400);
    await request(app).get(`${path}?cursor=2147483648`).set("x-test-user", "1").expect(400);
  });
  it("strict/all is honored and cache-isolated on console overview/detail/leaderboard and public v1", async () => {
    const path = `/api/eval-agent/jobs/${job.id}/complete`;
    await auth(request(app).post(path)).send({ agentId, leaseId, networkReport: report(), results: { responseLatencyMedian: 100 } }).expect(200);
    const stable = job.id; job = await claimed();
    await auth(request(app).post(`/api/eval-agent/jobs/${job.id}/complete`)).send({ agentId, leaseId, results: { responseLatencyMedian: 1000 } }).expect(200);
    const filters = `tag=suite:${tag}`;
    const ours = (rows: any[]) => rows.filter((r) => (r.providerId ?? r.provider) === providerId);
    for (const mode of ["strict", "all", "strict"]) {
      const expected = mode === "strict" ? 1 : 2;
      const overview = await request(app).get(`/api/metrics/realtime?hours=24&${filters}&network=${mode}`).expect(200);
      expect(ours(overview.body)).toHaveLength(expected);
      const detail = await request(app).get(`/api/metrics/realtime/detail?from=${Date.now() - 3600000}&to=${Date.now() + 3600000}&${filters}&network=${mode}`).expect(200);
      expect(ours(detail.body.metrics)).toHaveLength(expected);
      const board = await request(app).get(`/api/metrics/leaderboard?hours=24&${filters}&network=${mode}`).expect(200);
      expect(ours(board.body)[0].responseLatency).toBe(mode === "strict" ? 100 : 550);
      const api = await request(app).get(`/api/v1/metrics/realtime?hours=24&${filters}&network=${mode}`).expect(200);
      expect(ours(api.body.data)).toHaveLength(expected); expect(api.body.meta.network).toBe(mode);
      const apiBoard = await request(app).get(`/api/v1/metrics/leaderboard?hours=24&${filters}&network=${mode}`).expect(200);
      expect(apiBoard.body.meta.network).toBe(mode);
    }
    expect(stable).toBeGreaterThan(0);
    await request(app).get("/api/metrics/realtime?network=maybe").expect(400);
    const coverage = await request(app).get(`/api/metrics/network-coverage?tier=realtime&${filters}`).expect(200);
    expect(coverage.body.stable).toBeGreaterThanOrEqual(1); expect(coverage.body.unverified).toBeGreaterThanOrEqual(1);
  });
});
