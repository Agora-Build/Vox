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

  it("heartbeat acknowledges retries, rejects foreign leases, and isolates malformed telemetry", async () => {
    const body = { agentId, leaseId, linkType: "wifi", networkReport: report() };
    const first = await auth(request(app).post("/api/eval-agent/heartbeat")).send(body).expect(200);
    expect(first.body.networkAck).toMatchObject({ jobId: job.id, ackedEventSeqs: [100, 101] });
    expect((await auth(request(app).post("/api/eval-agent/heartbeat")).send(body).expect(200)).body.networkAck).toEqual(first.body.networkAck);
    await auth(request(app).post("/api/eval-agent/heartbeat")).send({ ...body, leaseId: "wrong" }).expect(403);
    const malformed = await auth(request(app).post("/api/eval-agent/heartbeat")).send({ ...body, networkReport: { ...report(), ip: "10.1.1.1" } }).expect(200);
    expect(malformed.body.networkReportStatus).toMatchObject({ status: "rejected", reason: "invalid_report", incomplete: true });
    expect(JSON.stringify(malformed.body)).not.toContain("10.1.1.1");
    await auth(request(app).post("/api/eval-agent/heartbeat")).send({ agentId, leaseId }).expect(200);
  });
  it("recovers from a conflicting heartbeat, records liveness, and accepts subsequent events", async () => {
    const path = "/api/eval-agent/heartbeat", original = report();
    await auth(request(app).post(path)).send({ agentId, leaseId, networkReport: original }).expect(200);
    const changed = report(); changed.events[0].tags.link = "cellular";
    await pool.query("UPDATE eval_agents SET last_seen_at=now()-interval '3 minutes' WHERE id=$1", [agentId]);
    const conflict = await auth(request(app).post(path)).send({ agentId, leaseId, state: "occupied", networkReport: changed }).expect(200);
    expect(conflict.body.networkAck.ackedEventSeqs).toEqual([101]);
    expect(conflict.body.networkReportStatus).toMatchObject({ status: "partial", incomplete: true,
      rejectedEvents: [{ seq: 100, reason: "event_conflict" }] });
    expect((await storage.getEvalAgent(agentId))!.lastSeenAt!.getTime()).toBeGreaterThan(Date.now() - 10000);
    expect((await storage.getEvalJob(job.id))?.status).toBe("running");
    const next = report(); next.events = [{ ...next.events[1], seq: 102 }]; next.lastSeq = 102;
    const resumed = await auth(request(app).post(path)).send({ agentId, leaseId, networkReport: next }).expect(200);
    expect(resumed.body.networkAck.ackedEventSeqs).toEqual([102]);
    expect(resumed.body.networkReportStatus).toMatchObject({ status: "accepted", incomplete: true });
    expect((await storage.getEvalJob(job.id))?.networkMonitoring).toBe("incomplete");
  });
  it("does not acknowledge malformed events but keeps valid events in the same heartbeat", async () => {
    const r = report();
    const response = await auth(request(app).post("/api/eval-agent/heartbeat")).send({ agentId, leaseId,
      networkReport: { ...r, events: [{ ...r.events[0], tags: { link: "invalid" } }, r.events[1]] } }).expect(200);
    expect(response.body.networkAck.ackedEventSeqs).toEqual([101]);
    expect(response.body.networkReportStatus).toMatchObject({ status: "partial", incomplete: true,
      rejectedEvents: [{ seq: 100, reason: "invalid_event" }] });
  });
  it("marks a prolonged heartbeat gap incomplete without failing the evaluation", async () => {
    const before = new Date(Date.now() - 180000);
    await pool.query("UPDATE eval_agents SET last_seen_at=$2 WHERE id=$1", [agentId, before]);
    await pool.query("UPDATE eval_jobs SET started_at=$2 WHERE id=$1", [job.id, before]);
    await pool.query("UPDATE eval_job_network_state SET started_at=$2 WHERE job_id=$1", [job.id, before]);
    job = (await storage.getEvalJob(job.id))!;
    await auth(request(app).post("/api/eval-agent/heartbeat")).send({ agentId, leaseId, networkReport: report() }).expect(200);
    expect(await storage.getEvalJob(job.id)).toMatchObject({ status: "running", networkMonitoring: "incomplete" });
    await auth(request(app).post(`/api/eval-agent/jobs/${job.id}/complete`)).send({ agentId, leaseId,
      networkReport: report(), results: { responseLatencyMedian: 100 } }).expect(200);
    expect(await storage.getEvalJob(job.id)).toMatchObject({ status: "completed", networkMonitoring: "incomplete" });
    expect(await storage.getEvalResultsByJob(job.id)).toHaveLength(1);
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
  it("saves the result despite a final event conflict, returning explicit recovery feedback", async () => {
    await auth(request(app).post("/api/eval-agent/heartbeat")).send({ agentId, leaseId, networkReport: report() }).expect(200);
    const r = report(); r.events[0].tags.link = "cellular";
    const path = `/api/eval-agent/jobs/${job.id}/complete`;
    const body = { agentId, leaseId, startedAt: job.startedAt!.toISOString(), networkReport: r, results: { responseLatencyMedian: 123 } };
    const done = await auth(request(app).post(path)).send(body).expect(200);
    expect(done.body.networkAck.ackedEventSeqs).toEqual([101]);
    expect(done.body.networkReportStatus).toMatchObject({ status: "partial", incomplete: true,
      rejectedEvents: [{ seq: 100, reason: "event_conflict" }] });
    await auth(request(app).post(path)).send(body).expect(200);
    expect(await storage.getEvalJob(job.id)).toMatchObject({ status: "completed", networkMonitoring: "incomplete" });
    expect(await storage.getEvalResultsByJob(job.id)).toHaveLength(1);
  });
  it("accepts results with invalid or missing historical network metadata without weakening lease checks", async () => {
    await pool.query("DELETE FROM eval_job_network_state WHERE job_id=$1", [job.id]);
    const path = `/api/eval-agent/jobs/${job.id}/complete`;
    const body = { agentId, leaseId, networkReport: { ...report(), version: 999 }, results: { responseLatencyMedian: 100 } };
    await auth(request(app).post(path)).send({ ...body, leaseId: "superseded" }).expect(403);
    expect((await storage.getEvalJob(job.id))?.status).toBe("running");
    const result = await auth(request(app).post(path)).send(body).expect(200);
    expect(result.body.networkReportStatus).toMatchObject({ status: "rejected", reason: "invalid_report", incomplete: true });
    expect(await storage.getEvalResultsByJob(job.id)).toHaveLength(1);
  });
  it("still rejects an old execution's result after a same-lease reclaim", async () => {
    const old = report();
    await pool.query("UPDATE eval_jobs SET status='pending' WHERE id=$1", [job.id]);
    job = (await storage.claimEvalJob(job.id, agentId, identity()))!;
    const path = `/api/eval-agent/jobs/${job.id}/complete`;
    const body = { agentId, leaseId, networkReport: old, results: { responseLatencyMedian: 100 } };
    await auth(request(app).post(path)).send(body).expect(409);
    await auth(request(app).post(path)).send({ agentId, leaseId, results: body.results }).expect(409);
    await auth(request(app).post(path)).send({ ...body, startedAt: old.startedAt }).expect(409);
    expect((await storage.getEvalJob(job.id))?.status).toBe("running");
    expect(await storage.getEvalResultsByJob(job.id)).toHaveLength(0);
    const recovered = await auth(request(app).post(path)).send({ ...body, startedAt: job.startedAt!.toISOString() }).expect(200);
    expect(recovered.body.networkReportStatus).toMatchObject({ status: "rejected", reason: "execution_mismatch", incomplete: true });
    expect(await storage.getEvalResultsByJob(job.id)).toHaveLength(1);
  });
  it("keeps a legacy daemon's first completion compatible without optional network metadata", async () => {
    await auth(request(app).post(`/api/eval-agent/jobs/${job.id}/complete`)).send({ agentId, leaseId,
      results: { responseLatencyMedian: 100 } }).expect(200);
    expect(await storage.getEvalJob(job.id)).toMatchObject({ status: "completed", networkMonitoring: "incomplete" });
    expect(await storage.getEvalResultsByJob(job.id)).toHaveLength(1);
  });
  it("requires execution identity on pre-upgrade reclaims even without historical event rows", async () => {
    await pool.query("DELETE FROM eval_job_network_events WHERE job_id=$1", [job.id]);
    await pool.query("DELETE FROM eval_job_network_state WHERE job_id=$1", [job.id]);
    await pool.query("UPDATE eval_jobs SET retry_count=1 WHERE id=$1", [job.id]);
    const path = `/api/eval-agent/jobs/${job.id}/complete`;
    const body = { agentId, leaseId, results: { responseLatencyMedian: 100 } };
    const response = await auth(request(app).post(path)).send(body).expect(409);
    expect(response.body.error).toContain("Execution timestamp required");
    expect((await storage.getEvalJob(job.id))?.status).toBe("running");
    expect(await storage.getEvalResultsByJob(job.id)).toHaveLength(0);
    await auth(request(app).post(path)).send({ ...body, startedAt: job.startedAt!.toISOString() }).expect(200);
    expect(await storage.getEvalResultsByJob(job.id)).toHaveLength(1);
  });
  it("job history requires authorization and exposes neither leases nor addresses", async () => {
    job = await claimed(true);
    for (const suffix of ["network-events", "events"]) {
      const path = `/api/eval-jobs/${job.id}/${suffix}`;
      await request(app).get(path).expect(401);
      await request(app).get(path).set("x-test-user", "2").expect(403);
      const history = await request(app).get(path).set("x-test-user", "1").expect(200);
      expect(history.body.events[0].event).toBe("initial");
      expect(JSON.stringify(history.body)).not.toMatch(/127\.0|leaseId|route-test-lease|agentId/);
      await request(app).get(`${path}?cursor=-1`).set("x-test-user", "1").expect(400);
      await request(app).get(`${path}?cursor=2147483648`).set("x-test-user", "1").expect(400);
    }
  });
  it("never exposes internal phone-number hashes in flows or legacy job snapshots", async () => {
    const numberHash = "test-private-number-equality-token";
    const lineLookup = { value: "twilio", carrierName: "Twilio", lineType: "voip", number: "...1234",
      lookedUpAt: new Date().toISOString(), numberHash };
    const flow = await storage.createEvalFlow({ name: "phone hash privacy", ownerId: 1, providerId, visibility: "public", config: {} });
    await storage.updateEvalFlow(flow.id, { lineLookup });
    const user = (req: request.Test, id = 1) => req.set("x-test-user", String(id));
    for (const path of [`/api/eval-flows/${flow.id}`, `/api/eval-flows?includePublic=true`,
      `/api/v1/eval-flows/${flow.id}`, "/api/v1/eval-flows"]) {
      for (const id of [1, 2]) {
        const response = await user(request(app).get(path), id).expect(200);
        expect(JSON.stringify(response.body)).not.toContain(numberHash);
        expect(JSON.stringify(response.body)).not.toContain("numberHash");
      }
    }
    expect((await storage.getEvalFlow(flow.id))!.lineLookup!.numberHash).toBe(numberHash);
    await pool.query("UPDATE eval_jobs SET snapshot=jsonb_set(snapshot,'{evalFlow,lineLookup}',$2::jsonb) WHERE id=$1", [job.id, JSON.stringify(lineLookup)]);
    for (const path of [`/api/eval-jobs/${job.id}`, `/api/eval-jobs/${job.id}/detail`, "/api/eval-jobs",
      `/api/v1/jobs/${job.id}`, "/api/v1/jobs"]) {
      const response = await user(request(app).get(path)).expect(200);
      expect(JSON.stringify(response.body)).not.toContain(numberHash);
      expect(JSON.stringify(response.body)).not.toContain("numberHash");
    }
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
      const overview = await request(app).get(`/api/metrics/realtime?hours=24&${filters}&health=${mode}`).expect(200);
      expect(ours(overview.body)).toHaveLength(expected);
      const detail = await request(app).get(`/api/metrics/realtime/detail?from=${Date.now() - 3600000}&to=${Date.now() + 3600000}&${filters}&health=${mode}`).expect(200);
      expect(ours(detail.body.metrics)).toHaveLength(expected);
      const board = await request(app).get(`/api/metrics/leaderboard?hours=24&${filters}&health=${mode}`).expect(200);
      expect(ours(board.body)[0].responseLatency).toBe(mode === "strict" ? 100 : 550);
      const api = await request(app).get(`/api/v1/metrics/realtime?hours=24&${filters}&health=${mode}`).expect(200);
      expect(ours(api.body.data)).toHaveLength(expected); expect(api.body.meta.health).toBe(mode);
      const apiBoard = await request(app).get(`/api/v1/metrics/leaderboard?hours=24&${filters}&health=${mode}`).expect(200);
      expect(apiBoard.body.meta.health).toBe(mode);
    }
    expect(stable).toBeGreaterThan(0);
    await request(app).get("/api/metrics/realtime?health=maybe").expect(400);
    const coverage = await request(app).get(`/api/metrics/network-coverage?tier=realtime&${filters}`).expect(200);
    expect(coverage.body.stable).toBeGreaterThanOrEqual(1); expect(coverage.body.unverified).toBeGreaterThanOrEqual(1);
  });
});
