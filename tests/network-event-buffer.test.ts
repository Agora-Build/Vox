import { describe, it, expect, beforeEach } from "vitest";
import { NetworkEventBuffer } from "../vox_eval_agentd/network-events";
import { networkReportSchema, networkEventTags, MAX_NETWORK_EVENT_BATCH } from "../shared/network-events";
import { parseMetricsTags, tagsCacheKey } from "../server/metrics-params";

describe("acknowledged network-event buffer", () => {
  let mono: number, wall: number, buffer: NetworkEventBuffer;
  const start = "2026-11-05T00:00:00.000Z";
  const wifi = { link: "wifi" as const, fingerprint: "private-wifi" };
  const cellular = { link: "cellular" as const, fingerprint: "private-cellular" };
  beforeEach(() => { mono = 0; wall = Date.parse(start); buffer = new NetworkEventBuffer(() => mono, () => wall); buffer.start(1, start, wifi); });

  it("acknowledges only immutable IDs accepted for this claim", () => {
    const initial = buffer.report()!;
    mono += 1000; buffer.observe(cellular);
    buffer.acknowledge({ jobId: 1, startedAt: start, ackedEventSeqs: [initial.events[0].seq] });
    expect(buffer.report()!.events.map((e) => e.event)).toEqual(["network_change"]);
    expect(buffer.report()!.networkChanged).toBe(true);
  });
  it("retries an identical payload after a lost acknowledgment", () => {
    const initial = buffer.report(); mono += 1000;
    expect(buffer.report()).toEqual(initial);
  });
  it("ignores acknowledgments from another job or an earlier claim", () => {
    buffer.acknowledge({ jobId: 2, startedAt: start, ackedEventSeqs: [1] });
    buffer.acknowledge({ jobId: 1, startedAt: "2026-11-04T00:00:00.000Z", ackedEventSeqs: [1] });
    expect(buffer.report()!.events).toHaveLength(1);
  });
  it("evicts after two monotonic minutes but retains whole-run changes", () => {
    mono = 1000; buffer.observe(cellular);
    mono = 122000; wall -= 1000000;
    const report = buffer.report()!;
    expect(report.events).toEqual([]);
    expect(report).toMatchObject({ networkChanged: true, changeCount: 1, evictedThroughSeq: 2, lastSeq: 2 });
  });
  it("bounds a noisy event queue and retains a sticky count", () => {
    for (let i = 0; i < 200; i++) { mono += 10; buffer.observe(i % 2 ? wifi : cellular); }
    const report = buffer.report()!;
    expect(report.events).toHaveLength(MAX_NETWORK_EVENT_BATCH);
    expect(report.changeCount).toBe(200);
    expect(report.evictedThroughSeq).toBeGreaterThan(0);
    expect(networkReportSchema.safeParse(report).success).toBe(true);
  });
  it("keeps the sequence increasing across jobs without an attempt ID", () => {
    buffer.finish(wifi); const last = buffer.report()!.lastSeq; buffer.clear();
    buffer.start(2, start, wifi);
    expect(buffer.report()!.firstSeq).toBe(last + 1);
    expect(buffer.report()).not.toHaveProperty("attemptId");
  });
  it("ends once and includes the final observation", () => {
    mono = 1000; buffer.finish(cellular); buffer.finish(wifi); buffer.observe(wifi);
    expect(buffer.report()!.events.map((e) => e.event)).toEqual(["monitoring_start", "network_change", "monitoring_end"]);
    expect(buffer.report()!.changeCount).toBe(1);
  });
  it("unknown or interrupted monitoring never recovers strict eligibility", () => {
    buffer.gap(); mono = 1000; buffer.observe(wifi); buffer.finish(wifi);
    expect(buffer.report()!.continuous).toBe(false);
    expect(buffer.report()!.networkChanged).toBe(false);
  });
  it("detects timer suspension even if the network returns unchanged", () => {
    mono = 6000; buffer.observe(wifi); expect(buffer.report()!.continuous).toBe(false);
  });
  it("does not put private fingerprints on the wire", () => {
    buffer.observe(cellular); expect(JSON.stringify(buffer.report())).not.toContain("private-");
  });
  it("report snapshots cannot mutate queued payloads", () => {
    buffer.report()!.events[0].tags.link = "cellular";
    expect(buffer.report()!.events[0].tags.link).toBe("wifi");
  });
  it("missing initial evidence emits a gap", () => {
    buffer.start(2, start); expect(buffer.report()!.events.map((e) => e.event)).toEqual(["monitoring_start", "monitoring_gap"]);
    expect(buffer.report()!.continuous).toBe(false);
  });
  it("retains the host sampler's change summary when older details were evicted", () => {
    buffer.noteMissingChanges(10); buffer.finish(wifi);
    expect(buffer.report()).toMatchObject({ networkChanged: true, changeCount: 10, continuous: false });
  });
});

describe("network protocol validation and policy", () => {
  const good = () => { const b = new NetworkEventBuffer(); b.start(1, new Date().toISOString()); return b.report()!; };
  it("rejects duplicate sequences", () => { const r = good(); r.events.push(r.events[0]); expect(networkReportSchema.safeParse(r).success).toBe(false); });
  it("rejects raw private fields", () => { const r = good(); expect(networkReportSchema.safeParse({ ...r, ip: "10.0.0.1" }).success).toBe(false); });
  it("rejects contradictory change summaries", () => { const r = good(); r.changeCount = 1; expect(networkReportSchema.safeParse(r).success).toBe(false); });
  it("rejects out-of-range IDs and oversized reports", () => {
    const r = good(); r.events[0].seq = 999; expect(networkReportSchema.safeParse(r).success).toBe(false);
    const oversizedId = good(); oversizedId.jobId = 2147483648; expect(networkReportSchema.safeParse(oversizedId).success).toBe(false);
  });
  it("defaults to strict and rejects ambiguous values", () => {
    expect(parseMetricsTags({})).toMatchObject({ network: "strict" });
    expect(parseMetricsTags({ network: "all" })).toMatchObject({ network: "all" });
    expect(parseMetricsTags({ network: ["strict", "all"] })).toHaveProperty("error");
  });
  it("partitions caches by policy", () => {
    expect(tagsCacheKey({ tagFilters: [], network: "all" })).not.toBe(tagsCacheKey({ tagFilters: [] }));
  });
  it("event maps prefer detected values while preserving other baseline dimensions", () => {
    expect(networkEventTags([{ key: "isp", value: "manual", source: "agent" }, { key: "isp", value: "att", source: "detected" }, { key: "line", value: "twilio", source: "flow" }])).toEqual({ isp: "att", line: "twilio" });
  });
});
