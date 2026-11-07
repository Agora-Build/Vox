import { beforeEach, describe, expect, it } from "vitest";
import { HostResourceMonitor } from "../vox_eval_agentd/host-resource-monitor";
import { NetworkEventBuffer } from "../vox_eval_agentd/network-events";
import { networkReportSchema } from "../shared/network-events";
import type { HostResourceEvent } from "../shared/host-resources";

describe("host resource condition rules", () => {
  let now: number, monitor: HostResourceMonitor;
  const start = Date.parse("2026-11-07T00:00:00Z");
  const sample = (seconds: number, cpuPercent = 20, memoryPercent = 40) => {
    now = start + seconds * 1000;
    return monitor.observe({ gap: false, samples: [{ timestamp: now, cpuPercent, memoryPercent }] });
  };
  function series(from: number, to: number, cpu = 90, memory = 40) {
    const events: HostResourceEvent[] = [];
    for (let i = from; i <= to; i++) events.push(...sample(i, cpu, memory));
    return events;
  }
  beforeEach(() => { now = start; monitor = new HostResourceMonitor(() => now); });

  it("requires strictly above 80% for thirty continuous seconds", () => {
    expect(series(0, 29)).toEqual([]);
    expect(sample(30, 90)).toEqual([expect.objectContaining({ event: "host_high", data: expect.objectContaining({ metric: "cpu", durationMs: 30_000 }) })]);
    expect(series(31, 80)).toEqual([]);
  });
  it("does not call a brief spike or exactly 80% high usage", () => {
    series(0, 15); sample(16, 80);
    expect(series(17, 46)).toEqual([]);
    expect(series(47, 100, 80)).toEqual([]);
  });
  it("tracks CPU and memory independently", () => {
    const events = series(0, 30, 85, 95);
    expect(events.map((event) => event.data)).toEqual([
      expect.objectContaining({ metric: "cpu", valuePercent: 85 }), expect.objectContaining({ metric: "memory", valuePercent: 95 }),
    ]);
  });
  it("uses hysteresis and emits a single recovery with the episode peak", () => {
    series(0, 30); sample(31, 98); series(32, 45, 70); sample(46, 76);
    expect(series(47, 76, 70)).toEqual([]);
    expect(sample(77, 70)).toEqual([expect.objectContaining({ event: "host_recovered", data: expect.objectContaining({ valuePercent: 70, peakPercent: 98, durationMs: 77_000 }) })]);
    expect(series(78, 120, 70)).toEqual([]);
    expect(series(121, 151)).toEqual([expect.objectContaining({ event: "host_high" })]);
  });
  it("does not falsely recover at exactly 75%", () => {
    series(0, 30);
    expect(series(31, 70, 75)).toEqual([]);
  });
  it("needs a full five-minute window and measures percentage points, not relative percent", () => {
    series(0, 298, 40);
    expect(sample(299, 65)).toEqual([]);
    expect(sample(300, 65)).toEqual([expect.objectContaining({ event: "host_rise", timestamp: start + 300_000,
      data: expect.objectContaining({ previousPercent: 40, valuePercent: 65, risePoints: 20, windowMs: 300_000 }) })]);
    expect(series(301, 320, 65)).toEqual([]);
  });
  it("does not alert for a relative 20% rise from 40% to 48%", () => {
    series(0, 299, 40);
    expect(sample(300, 48)).toEqual([]);
  });
  it("does not flap when a rapid rise hovers around twenty points", () => {
    series(0, 299, 20); sample(300, 40);
    const events = [];
    for (let i = 301; i <= 330; i++) events.push(...sample(i, i % 2 ? 39 : 40));
    expect(events).toEqual([]);
  });
  it("marks an interrupted sampler as unavailable and resets sustained/window evidence", () => {
    series(0, 25);
    expect(sample(40, 90)).toEqual([expect.objectContaining({ event: "host_gap" })]);
    expect(series(41, 69)).toEqual([]);
    expect(sample(70, 90)).toEqual([expect.objectContaining({ event: "host_high" })]);
  });
  it("does not compare across explicit gaps or sampler restarts", () => {
    series(0, 299, 20);
    now = start + 300_000;
    const events = monitor.observe({ gap: true, samples: [{ timestamp: now, cpuPercent: 60, memoryPercent: 40 }] });
    expect(events.map((event) => event.event)).toEqual(["host_gap"]);
  });
  it("starts unknown instead of inventing healthy host metrics", () => {
    expect(monitor.begin().map((event) => event.event)).toEqual(["host_start", "host_gap"]);
    expect(monitor.snapshot()).toEqual({ ruleVersion: 1, cpuPercent: null, memoryPercent: null });
  });
  it("keeps a pre-job sample window and records active conditions at claim", () => {
    series(0, 299, 20); sample(300, 45);
    expect(monitor.begin()).toEqual([expect.objectContaining({ event: "host_start" }), expect.objectContaining({ event: "host_rise" })]);
    series(301, 331, 90);
    expect(monitor.begin().some((event) => event.event === "host_high")).toBe(true);
  });
  it("does not treat duplicate samples as new observations", () => {
    sample(0, 90);
    for (let i = 0; i < 100; i++) expect(sample(0, 90)).toEqual([]);
    expect(monitor.begin().some((event) => event.event === "host_high")).toBe(false);
  });
  it("invalidates a snapshot once fresh host samples stop arriving", () => {
    sample(0); now += 6000;
    expect(monitor.observe({ samples: [], gap: false }).map((event) => event.event)).toEqual(["host_gap"]);
    expect(monitor.snapshot().cpuPercent).toBeNull();
  });
});

describe("resource events on the acknowledged execution stream", () => {
  const start = "2026-11-07T00:00:00.000Z";
  const snapshot = { ruleVersion: 1 as const, cpuPercent: 20, memoryPercent: 40 };
  const high: HostResourceEvent = { event: "host_high", data: { ruleVersion: 1, metric: "cpu", valuePercent: 90, thresholdPercent: 80, durationMs: 30_000, peakPercent: 95 } };
  function buffer() {
    const b = new NetworkEventBuffer(); b.start(1, start, { link: "wifi", fingerprint: "private" });
    b.resource({ event: "host_start", data: snapshot }); return b;
  }
  it("versions the additive report and never turns high CPU into a network change", () => {
    const b = buffer(); b.resource(high); b.resource({ event: "host_end", data: snapshot });
    b.finish({ link: "wifi", fingerprint: "private" });
    const report = b.report()!;
    expect(report).toMatchObject({ version: 2, networkChanged: false, continuous: true, resources: { continuous: true, highUsage: true } });
    expect(networkReportSchema.safeParse(report).success).toBe(true);
  });
  it("missing host metrics do not poison otherwise complete network monitoring", () => {
    const b = buffer(); b.resource({ event: "host_gap", data: snapshot });
    expect(b.report()).toMatchObject({ continuous: true, resources: { continuous: false, highUsage: false } });
  });
  it("deduplicates resource acknowledgments and preserves in-flight events", () => {
    const b = buffer(), sent = b.report()!; b.resource(high);
    b.acknowledge({ jobId: 1, startedAt: start, ackedEventSeqs: [1, 2, 3] }, sent);
    expect(b.report()!.events.map((event) => event.event)).toEqual(["host_high"]);
  });
  it("retains high-usage summaries after pending event details expire", () => {
    let mono = 0;
    const b = new NetworkEventBuffer(() => mono); b.start(1, start, { link: "wifi", fingerprint: "private" });
    b.resource({ event: "host_start", data: snapshot }); b.resource(high); mono = 121_000;
    expect(b.report()).toMatchObject({ events: [], resources: { continuous: false, highUsage: true } });
  });
  it("rejects private extra fields and invalid threshold/rise measurements", () => {
    const b = buffer(); b.resource(high); const report = b.report()!;
    const event = report.events.at(-1)!;
    expect(networkReportSchema.safeParse({ ...report, events: [{ ...event, data: { ...high.data, processName: "secret" } }] }).success).toBe(false);
    expect(networkReportSchema.safeParse({ ...report, version: 1 }).success).toBe(false);
    expect(networkReportSchema.safeParse({ ...report, events: [{ ...event, data: { ...high.data, valuePercent: 75 } }] }).success).toBe(false);
    expect(networkReportSchema.safeParse({ ...report, events: [{ ...event, event: "host_rise", data: { ruleVersion: 1, metric: "cpu", previousPercent: 40, valuePercent: 48, windowMs: 300_000, risePoints: 20 } }] }).success).toBe(false);
  });
});
