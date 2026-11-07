import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostResourceObserver, linuxResourceCounters } from "../vox_eval_agentd/host-resource-observer";

describe("real host resource observations", () => {
  let dir: string, observer: HostResourceObserver, now: number;
  function status(overrides: Record<string, unknown> = {}, resourceOverrides: Record<string, unknown> = {}) {
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ version: 1, monitor: "host-a", timestamp: now,
      available: false, resources: { version: 1, gapCount: 0, available: true,
        samples: [{ timestamp: now, cpuPercent: 42, memoryPercent: 63 }], ...resourceOverrides }, ...overrides }));
  }
  beforeEach(() => {
    now = Date.now(); dir = fs.mkdtempSync(path.join(os.tmpdir(), "vox-host-resources-"));
    vi.stubEnv("VOX_NETWORK_STATUS_FILE", path.join(dir, "status.json")); observer = new HostResourceObserver();
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

  it("counts all cores once, excludes duplicate guest ticks, and uses MemAvailable rather than free memory", () => {
    expect(linuxResourceCounters("cpu  10 20 30 400 50 6 7 8 99 100\ncpu0 1 1 1", "MemTotal: 1000 kB\nMemFree: 5 kB\nMemAvailable: 300 kB\n"))
      .toEqual({ total: 531, idle: 450, memoryPercent: 70 });
  });
  it.each([
    ["cpu 1 2 3", "MemTotal: 1000 kB\nMemAvailable: 300 kB"],
    ["cpu 1 2 3 4 5 6 7 NaN", "MemTotal: 1000 kB\nMemAvailable: 300 kB"],
    ["cpu 1 2 3 4 5 6 7 8", "MemTotal: 1000 kB\nMemFree: 300 kB"],
    ["cpu 1 2 3 4 5 6 7 8", "MemTotal: 1000 kB\nMemAvailable: 1001 kB"],
  ])("refuses incomplete/invalid host counters", (cpu, memory) => {
    expect(() => linuxResourceCounters(cpu, memory)).toThrow();
  });
  it("reads resource samples even when network observations are unavailable", () => {
    status(); expect(observer.sample()).toEqual({ gap: false, samples: [{ timestamp: now, cpuPercent: 42, memoryPercent: 63 }] });
  });
  it("loads pre-job history once, then only newly observed samples", () => {
    status({}, { samples: [{ timestamp: now - 1000, cpuPercent: 41, memoryPercent: 62 }, { timestamp: now, cpuPercent: 42, memoryPercent: 63 }] });
    expect(observer.sample().samples).toHaveLength(2);
    expect(observer.sample()).toEqual({ gap: false, samples: [] });
  });
  it("detects a restarted sampler or dropped sample history", () => {
    status(); observer.sample(); status({ monitor: "host-b" }); expect(observer.sample().gap).toBe(true);
    status({ monitor: "host-b" }, { gapCount: 1 }); expect(observer.sample().gap).toBe(true);
  });
  it("does not confuse old samplers or missing files with healthy utilization", () => {
    expect(observer.sample()).toEqual({ samples: [], gap: true });
    status({ resources: undefined }); expect(observer.sample().gap).toBe(true);
    status({}, { available: false }); expect(observer.sample().gap).toBe(true);
    status({ timestamp: now - 6000 }); expect(observer.sample().gap).toBe(true);
    status({}, { samples: [{ timestamp: now - 6000, cpuPercent: 40, memoryPercent: 60 }] }); expect(observer.sample().gap).toBe(true);
  });
  it.each([NaN, Infinity, -1, 101, "95"])("rejects an invalid utilization reading %s", (cpuPercent) => {
    status({}, { samples: [{ timestamp: now, cpuPercent, memoryPercent: 40 }] }); expect(observer.sample().gap).toBe(true);
  });
  it("bounds file size, sample count and ordering", () => {
    fs.writeFileSync(path.join(dir, "status.json"), " ".repeat(140000)); expect(observer.sample().gap).toBe(true);
    const sample = { timestamp: now, cpuPercent: 40, memoryPercent: 60 };
    status({}, { samples: Array(311).fill(sample) }); expect(observer.sample().gap).toBe(true);
    status({}, { samples: [sample, sample] }); expect(observer.sample().gap).toBe(true);
  });
  it("strips unexpected local data before passing samples to the event monitor", () => {
    status({}, { samples: [{ timestamp: now, cpuPercent: 40, memoryPercent: 60, processName: "private-process" }] });
    expect(JSON.stringify(observer.sample())).not.toContain("private-process");
  });
});
