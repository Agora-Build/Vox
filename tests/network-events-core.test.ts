import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
await vi.hoisted(async () => {
  if (process.env.DATABASE_URL) {
    const { prepareIsolatedCoreDb } = await import("./helpers/isolated-core-db");
    process.env.DATABASE_URL = await prepareIsolatedCoreDb(process.env.DATABASE_URL, "vox_test_network_events");
  }
});
import { storage, pool } from "../server/storage";
import { recordAgentNetworkEvents, receiveAgentNetworkEvents, getJobNetworkHistory } from "../server/network-events";
import type { EvalJob } from "../shared/schema";
import type { NetworkReport } from "../shared/network-events";

const d = process.env.DATABASE_URL ? describe : describe.skip;
d("Core network history, claim fencing and strict metrics", () => {
  let tokenId: number, agentId: number, providerId: string, job: EvalJob;
  const leaseId = "test-lease-network";
  const identity = () => ({ id: tokenId, siteId: "na-us-seattle-01", region: "na-us-seattle", dispatchTier: "public", createdBy: 1, ownerOrgId: null, locationTrust: "trusted" });
  async function claim() {
    const pending = await storage.createEvalJob({ triggerType: 2, createdBy: 1, siteId: null, targetTokenId: tokenId,
      status: "pending", config: {}, snapshot: { creatorPlan: "principal", evalFlow: { visibility: "public", isMainline: true }, evalSet: { visibility: "public", isMainline: true } } as any });
    return (await storage.claimEvalJob(pending.id, agentId, identity(), { asnLookup: () => ({ asn: 7018, org: "AT&T" }) }))!;
  }
  const report = (seq = 1): NetworkReport => ({ version: 1, jobId: job.id, startedAt: job.startedAt!.toISOString(), firstSeq: seq, lastSeq: seq + 1,
    networkChanged: false, changeCount: 0, continuous: true, evictedThroughSeq: 0,
    events: [
      { seq, event: "monitoring_start", timestamp: job.startedAt!.getTime(), offsetMs: 0, tags: { link: "wifi" }, changed: [] },
      { seq: seq + 1, event: "monitoring_end", timestamp: job.startedAt!.getTime() + 1000, offsetMs: 1000, tags: { link: "wifi" }, changed: [] },
    ] });
  const record = (r?: NetworkReport, final = false, ip = "80.150.1.1") => recordAgentNetworkEvents({ agentId, leaseId, ip, report: r, ...(final ? { finalJobId: job.id } : {}) });
  const current = () => storage.getEvalJob(job.id).then((j) => j!);
  const receive = (rawReport?: unknown, final = false) => receiveAgentNetworkEvents({ agentId, leaseId, rawReport, ...(final ? { finalJobId: job.id } : {}) });
  beforeAll(async () => {
    await pool.query("INSERT INTO users(id,username,email,plan) VALUES(1,'network-events','events@test.local','principal')");
    providerId = (await pool.query("SELECT id FROM providers LIMIT 1")).rows[0].id;
    tokenId = (await storage.createEvalAgentToken({ name: "network-events", tokenHash: "network-events-test", siteId: "na-us-seattle-01", dispatchTier: "public", createdBy: 1 } as any)).id;
    agentId = (await storage.createEvalAgent({ name: "network-events", tokenId, state: "idle" } as any)).id;
  });
  beforeEach(async () => {
    await pool.query("UPDATE eval_agents SET current_lease_id=$2, observed_ip='80.150.1.1', link_type='wifi' WHERE id=$1", [agentId, leaseId]);
    job = await claim();
  });
  afterAll(async () => { await pool.end(); });

  it("atomically records an immutable initial tag snapshot with a millisecond claim identity", async () => {
    const h = await getJobNetworkHistory(job);
    expect(h.events).toHaveLength(1); expect(h.events[0]).toMatchObject({ event: "initial", offsetMs: 0, tags: { isp: "att", link: "wifi" } });
    expect((await pool.query("SELECT started_at=date_trunc('milliseconds',started_at) AS exact FROM eval_jobs WHERE id=$1", [job.id])).rows[0].exact).toBe(true);
    expect(job.networkMonitoring).toBe("unknown");
  });
  it("deduplicates concurrently across independent DB transactions and acknowledges a lost ack", async () => {
    const r = report(); const acks = await Promise.all([record(r), record(r), record(r)]);
    expect(acks.every((a) => a?.ackedEventSeqs.join() === "1,2")).toBe(true);
    expect((await getJobNetworkHistory(await current())).events).toHaveLength(3);
  });
  it("rolls back a conflicting immutable event rather than overwriting it", async () => {
    const r = report(); await record(r); r.events[0].tags.link = "cellular";
    await expect(record(r)).rejects.toMatchObject({ status: 409 });
    expect((await getJobNetworkHistory(await current())).events[1].tags.link).toBe("wifi");
  });
  it("rejects another lease and another claim timestamp", async () => {
    await expect(recordAgentNetworkEvents({ agentId, leaseId: "another-lease", report: report() })).rejects.toMatchObject({ status: 409 });
    const r = report(); r.startedAt = new Date(job.startedAt!.getTime() - 1).toISOString();
    await expect(record(r)).rejects.toMatchObject({ status: 409 });
  });
  it("reclaiming on the same lease creates a new identity and rejects old reports", async () => {
    const old = report(); await pool.query("UPDATE eval_jobs SET status='pending' WHERE id=$1", [job.id]);
    job = (await storage.claimEvalJob(job.id, agentId, identity()))!;
    expect(job.startedAt!.getTime()).toBeGreaterThan(Date.parse(old.startedAt));
    await expect(record(old)).rejects.toMatchObject({ status: 409 });
    expect((await getJobNetworkHistory(job)).events).toHaveLength(1);
  });
  it("checks the live lease inside the claim transaction", async () => {
    await pool.query("UPDATE eval_jobs SET status='pending' WHERE id=$1", [job.id]);
    expect(await storage.claimEvalJob(job.id, agentId, identity(), { expectedLeaseId: "superseded" })).toBeUndefined();
    expect((await current()).status).toBe("pending");
  });
  it("preserves claim uniqueness when a reaper clears startedAt or the clock moves backward", async () => {
    const previous = new Date(job.startedAt!.getTime() + 3600000);
    await pool.query("UPDATE eval_job_network_state SET started_at=$2 WHERE job_id=$1", [job.id, previous]);
    await pool.query("UPDATE eval_jobs SET status='pending', started_at=NULL WHERE id=$1", [job.id]);
    job = (await storage.claimEvalJob(job.id, agentId, identity()))!;
    expect(job.startedAt!.getTime()).toBe(previous.getTime() + 1);
  });
  it("rejects reports attached to a different completion", async () => {
    await expect(recordAgentNetworkEvents({ agentId, leaseId, report: report(), finalJobId: job.id + 1 })).rejects.toMatchObject({ status: 409 });
  });
  it("only marks a fully delivered final report complete; legacy completion is incomplete", async () => {
    await record(report()); expect((await current()).networkMonitoring).toBe("monitoring");
    await record(report(), true); expect((await current()).networkMonitoring).toBe("complete");
    job = await claim(); await record(undefined, true); expect((await current()).networkMonitoring).toBe("incomplete");
  });
  it("missing expired events cannot turn a run into a strict benchmark", async () => {
    const r = report(); r.events.shift(); r.evictedThroughSeq = r.firstSeq;
    await record(r, true); expect((await current()).networkMonitoring).toBe("incomplete");
  });
  it("expired events already accepted by Core do not destroy complete coverage", async () => {
    const r = report(); await record({ ...r, events: [r.events[0]], lastSeq: 1 });
    r.events.shift(); r.evictedThroughSeq = 1; await record(r, true);
    expect((await current()).networkMonitoring).toBe("complete");
  });
  it("keeps handoffs sticky, freezes tags and does not claim an ISP for historical observations", async () => {
    const r = report(); r.lastSeq = 3; r.events[1].seq = 3;
    r.events.splice(1, 0, { seq: 2, event: "network_change", timestamp: job.startedAt!.getTime() + 500, offsetMs: 500, tags: { link: "cellular" }, changed: ["link"] });
    r.networkChanged = true; r.changeCount = 1;
    await record(r); const first = await current(); await record({ ...r, events: [] }, true);
    const h = await getJobNetworkHistory(await current());
    expect(h.networkChanged).toBe(true); expect(first.tags).toEqual(job.tags);
    expect(h.events.find((e) => e.event === "network_change")?.tags).toMatchObject({ link: "cellular", isp: null });
    expect(JSON.stringify(h)).not.toMatch(/80\.150|lease-network|observedIp|leaseId/);
  });
  it("Core observes an IP handoff even for old agents and never rewrites baseline tags", async () => {
    await record(undefined, false, "1.1.1.1");
    expect((await current()).networkChanged).toBe(true); expect((await current()).tags).toEqual(job.tags);
  });
  it("a classifier refresh without a topology change is not a handoff", async () => {
    await pool.query("UPDATE eval_agents SET access_class='datacenter' WHERE id=$1", [agentId]);
    await record(report()); expect((await current()).networkChanged).toBe(false);
  });
  it("terminal retries acknowledge stored IDs without accepting new history", async () => {
    const r = report(); await record(r, true);
    expect((await record(r, true))?.ackedEventSeqs).toEqual([1, 2]);
    r.lastSeq = 3; r.events[1].seq = 3;
    await expect(record(r, true)).rejects.toMatchObject({ status: 409 });
  });
  it("fences result finalization against an old claim start", async () => {
    const old = job.startedAt; await pool.query("UPDATE eval_jobs SET started_at=started_at+interval '1 millisecond' WHERE id=$1", [job.id]);
    expect(await storage.finalizeRunningJobWithResult(job.id, undefined, null, { agentId, leaseId, startedAt: old })).toBeUndefined();
    expect((await current()).status).toBe("running");
  });
  it("accepts valid events beside a conflict, preserves history, and keeps incompleteness sticky", async () => {
    const r = report(); await record(r);
    r.events[0].tags.link = "cellular";
    r.lastSeq = 3; r.networkChanged = true; r.changeCount = 1;
    r.events.push({ seq: 3, event: "network_change", timestamp: job.startedAt!.getTime() + 2000,
      offsetMs: 2000, tags: { link: "cellular" }, changed: ["link"] });
    const response = await receive(r);
    expect(response.networkAck?.ackedEventSeqs).toEqual([2, 3]);
    expect(response.networkReportStatus).toMatchObject({ status: "partial", incomplete: true,
      rejectedEvents: [{ seq: 1, reason: "event_conflict" }] });
    expect((await getJobNetworkHistory(await current())).events[1].tags.link).toBe("wifi");
    expect((await current()).status).toBe("running");
    const next = { ...r, events: [{ ...r.events[1], seq: 4 }], lastSeq: 4 };
    expect((await receive(next, true)).networkReportStatus).toMatchObject({ status: "accepted", incomplete: true });
    expect((await current()).networkMonitoring).toBe("incomplete");
  });
  it("rejects malformed events individually without blocking valid observations", async () => {
    const r = report();
    const response = await receive({ ...r, events: [{ ...r.events[0], privateIp: "10.1.1.1" }, r.events[1]] });
    expect(response.networkAck?.ackedEventSeqs).toEqual([2]);
    expect(response.networkReportStatus).toMatchObject({ status: "partial", incomplete: true,
      rejectedEvents: [{ seq: 1, reason: "invalid_event" }] });
    expect(JSON.stringify(response)).not.toContain("10.1.1.1");
  });
  it("recovers a missing pre-upgrade history without fabricating complete coverage", async () => {
    await pool.query("DELETE FROM eval_job_network_state WHERE job_id=$1", [job.id]);
    await pool.query("DELETE FROM eval_job_network_events WHERE job_id=$1", [job.id]);
    const response = await receive(report(), true);
    expect(response.networkAck?.ackedEventSeqs).toEqual([1, 2]);
    expect(response.networkReportStatus).toMatchObject({ status: "accepted", incomplete: true });
    expect((await current()).tags).toEqual(job.tags);
    expect((await getJobNetworkHistory(await current())).events.map((event) => event.event)).toEqual(["monitoring_start", "monitoring_end"]);
  });
  it("offers sequence resynchronization and accepts subsequent events without restoring eligibility", async () => {
    await record(report());
    const response = await receive(report(10));
    expect(response.networkReportStatus).toMatchObject({ status: "rejected", reason: "sequence_mismatch", expectedFirstSeq: 1 });
    const r = report(); r.events = [{ ...r.events[1], seq: 12 }]; r.lastSeq = 12;
    expect((await receive(r)).networkAck?.ackedEventSeqs).toEqual([12]);
    expect((await current()).networkMonitoring).toBe("incomplete");
  });
  it("does not let stale execution feedback taint its successor and still rejects superseded leases", async () => {
    const old = report(); await pool.query("UPDATE eval_jobs SET status='pending' WHERE id=$1", [job.id]);
    job = (await storage.claimEvalJob(job.id, agentId, identity()))!;
    expect((await receive(old)).networkReportStatus).toMatchObject({ status: "rejected", reason: "execution_mismatch", startedAt: old.startedAt });
    expect((await current()).networkMonitoring).toBe("unknown");
    await expect(receiveAgentNetworkEvents({ agentId, leaseId: "wrong", rawReport: report() })).rejects.toMatchObject({ status: 403 });
  });
  it("saves authorized results even when the network envelope is invalid", async () => {
    const onAck = vi.fn(), onStatus = vi.fn();
    const done = await storage.finalizeRunningJobWithResult(job.id, undefined, { evalJobId: job.id, providerId, siteId: null }, {
      agentId, leaseId, startedAt: job.startedAt, network: { report: { ...report(), version: 999 }, onAck, onStatus },
    });
    expect(done).toMatchObject({ status: "completed", networkMonitoring: "incomplete" });
    expect(await storage.getEvalResultsByJob(job.id)).toHaveLength(1);
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected", reason: "invalid_report" }));
    expect(onAck.mock.calls[0][0]?.ackedEventSeqs ?? []).toEqual([]);
  });
  it("rolls back only failed telemetry storage, saving the result and requesting a safe retry", async () => {
    await pool.query(`CREATE FUNCTION network_test_storage_error() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test network storage unavailable'; END $$`);
    await pool.query(`CREATE TRIGGER network_test_storage_error BEFORE INSERT ON eval_job_network_events
      FOR EACH ROW WHEN (NEW.source='agent') EXECUTE FUNCTION network_test_storage_error()`);
    const onAck = vi.fn(), onStatus = vi.fn();
    try {
      const done = await storage.finalizeRunningJobWithResult(job.id, undefined, { evalJobId: job.id, providerId, siteId: null }, {
        agentId, leaseId, startedAt: job.startedAt, network: { report: report(), onAck, onStatus },
      });
      expect(done).toMatchObject({ status: "completed", networkMonitoring: "incomplete" });
      expect(await storage.getEvalResultsByJob(job.id)).toHaveLength(1);
      expect(onAck).toHaveBeenCalledWith(undefined);
      expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "retry", rejectedEvents: [] }));
    } finally {
      await pool.query("DROP TRIGGER network_test_storage_error ON eval_job_network_events");
      await pool.query("DROP FUNCTION network_test_storage_error()");
    }
  });
  it("preserves liveness and results when the fallback telemetry marker also fails", async () => {
    await pool.query(`CREATE FUNCTION network_test_marker_error() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test network state unavailable'; END $$`);
    await pool.query(`CREATE TRIGGER network_test_marker_error BEFORE UPDATE ON eval_job_network_state
      FOR EACH ROW EXECUTE FUNCTION network_test_marker_error()`);
    const onAck = vi.fn(), onStatus = vi.fn();
    try {
      expect((await receive(report())).networkReportStatus).toMatchObject({ status: "retry", incomplete: true, rejectedEvents: [] });
      expect(await current()).toMatchObject({ status: "running", networkMonitoring: "incomplete" });
      const done = await storage.finalizeRunningJobWithResult(job.id, undefined, { evalJobId: job.id, providerId, siteId: null }, {
        agentId, leaseId, startedAt: job.startedAt, network: { report: report(), onAck, onStatus },
      });
      expect(done).toMatchObject({ status: "completed", networkMonitoring: "incomplete" });
      expect(await storage.getEvalResultsByJob(job.id)).toHaveLength(1);
      expect(onAck).toHaveBeenCalledWith(undefined);
      expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "retry", incomplete: true, rejectedEvents: [] }));
    } finally {
      await pool.query("DROP TRIGGER network_test_marker_error ON eval_job_network_state");
      await pool.query("DROP FUNCTION network_test_marker_error()");
    }
    await receive(report(), true);
    expect((await current()).networkMonitoring).toBe("incomplete");
  });
  it("commits final events, eligibility, result and ack atomically", async () => {
    const ack = vi.fn();
    const holder = { agentId, leaseId, startedAt: job.startedAt, network: { report: report(), ip: "80.150.1.1", onAck: ack } };
    await expect(storage.finalizeRunningJobWithResult(job.id, undefined, { evalJobId: job.id, providerId: "nonexistent-provider", siteId: null }, holder)).rejects.toThrow();
    expect(ack).not.toHaveBeenCalled(); expect((await current()).networkMonitoring).toBe("unknown");
    expect((await getJobNetworkHistory(await current())).events).toHaveLength(1);
    const done = await storage.finalizeRunningJobWithResult(job.id, undefined, { evalJobId: job.id, providerId, siteId: null }, holder);
    expect(done).toMatchObject({ status: "completed", networkMonitoring: "complete" });
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ackedEventSeqs: [1, 2] }));
    const altered = report(); altered.events[0].tags.link = "cellular";
    await expect(record(altered, true)).rejects.toMatchObject({ status: 409 });
  });
  it("strict/all agree across raw, bucketed, detail, leaderboard, regions and counts", async () => {
    await record(report(), true); await storage.finalizeRunningJobWithResult(job.id, undefined, { evalJobId: job.id, providerId, siteId: "na-us-seattle-01", responseLatencyMedian: 100 });
    const stableId = job.id; job = await claim();
    await storage.finalizeRunningJobWithResult(job.id, undefined, { evalJobId: job.id, providerId, siteId: "na-us-seattle-02", responseLatencyMedian: 1000 });
    const filter = [{ key: "test", value: `job-${stableId}` }];
    await pool.query("UPDATE eval_jobs SET tags=COALESCE(tags,'[]') || $1::jsonb WHERE id=ANY($2::int[])", [JSON.stringify([{ ...filter[0], source: "flow" }]), [stableId, job.id]]);
    const strict = { tagFilters: filter }, all = { ...strict, network: "all" as const };
    expect((await storage.getMainlineMetrics(24, undefined, "web", strict))).toHaveLength(1);
    expect((await storage.getMainlineMetrics(24, undefined, "web", all))).toHaveLength(2);
    expect((await storage.getMainlineMetrics(undefined, undefined, "web", strict))[0].responseLatencyMedian).toBe(100);
    expect((await storage.getMainlineMetrics(undefined, undefined, "web", all))[0].responseLatencyMedian).toBe(550);
    const window = { from: Date.now() - 3600000, to: Date.now() + 3600000 };
    expect((await storage.getMetricsDetail("mainline", window, undefined, undefined, "web", filter)).metrics).toHaveLength(1);
    expect((await storage.getMetricsDetail("mainline", window, undefined, undefined, "web", filter, "all")).metrics).toHaveLength(2);
    expect(await storage.getTierEvalResults("mainline", 100, strict)).toHaveLength(1);
    expect(await storage.getTierEvalResults("mainline", 100, all)).toHaveLength(2);
    expect(await storage.getAvailableRegions("mainline", 24, undefined, "web", strict)).toMatchObject({ baseIds: ["na-us-seattle"] });
    expect(await storage.getNetworkCoverage("mainline", 24, undefined, undefined, "web", strict)).toEqual({ stable: 1, changed: 0, unverified: 1 });
  });
});
