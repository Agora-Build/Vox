import fs from "node:fs";
import { HOST_RESOURCE_RULES, type HostResourceSample } from "../shared/host-resources";

export type HostResourceObservation = { samples: HostResourceSample[]; gap: boolean };

export function linuxResourceCounters(stat: string, meminfo: string) {
  const values = stat.split("\n")[0].trim().split(/\s+/);
  if (values.shift() !== "cpu" || values.length < 8) throw new Error("Missing aggregate CPU counters");
  const ticks = values.slice(0, 8).map(Number);
  if (ticks.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Invalid CPU counters");
  const total = ticks.reduce((sum, value) => sum + value, 0), idle = ticks[3] + ticks[4];
  const memory = Object.fromEntries([...meminfo.matchAll(/^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/gm)].map((match) => [match[1], Number(match[2])]));
  if (!(memory.MemTotal > 0) || !Number.isFinite(memory.MemAvailable) || memory.MemAvailable < 0 || memory.MemAvailable > memory.MemTotal) throw new Error("Missing available host memory");
  return { total, idle, memoryPercent: (1 - memory.MemAvailable / memory.MemTotal) * 100 };
}

/** Never substitute container/cgroup utilization for the machine under test. */
export class HostResourceObserver {
  private previous?: { total: number; idle: number };
  private latest?: HostResourceSample;
  private monitor?: string;
  private gaps?: number;
  private lastTimestamp?: number;

  sample(): HostResourceObservation {
    try {
      const hostFile = process.env.VOX_NETWORK_STATUS_FILE;
      if (hostFile) {
        if (fs.statSync(hostFile).size > 128 * 1024) throw new Error("Oversized host status");
        const status = JSON.parse(fs.readFileSync(hostFile, "utf8"));
        const resources = status.resources;
        if (status.version !== 1 || typeof status.monitor !== "string" || !Number.isSafeInteger(status.timestamp)
          || Math.abs(Date.now() - status.timestamp) > HOST_RESOURCE_RULES.maxSampleGapMs
          || resources?.version !== 1 || resources.available !== true || !Number.isSafeInteger(resources.gapCount)
          || resources.gapCount < 0 || !Array.isArray(resources.samples) || !resources.samples.length || resources.samples.length > 310) throw new Error("Unavailable host resources");
        let previous = -1;
        const samples: HostResourceSample[] = resources.samples.map((sample: HostResourceSample) => {
          if (!Number.isSafeInteger(sample.timestamp) || sample.timestamp <= previous || sample.timestamp > status.timestamp
            || ![sample.cpuPercent, sample.memoryPercent].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100)) throw new Error("Invalid host resource sample");
          previous = sample.timestamp;
          return { timestamp: sample.timestamp, cpuPercent: sample.cpuPercent, memoryPercent: sample.memoryPercent };
        });
        if (Math.abs(Date.now() - samples.at(-1)!.timestamp) > HOST_RESOURCE_RULES.maxSampleGapMs) throw new Error("Stale resource sample");
        const restarted = this.monitor !== undefined && (this.monitor !== status.monitor || this.gaps !== resources.gapCount
          || samples.at(-1)!.timestamp < (this.lastTimestamp ?? 0));
        const fresh = restarted || this.lastTimestamp === undefined ? samples : samples.filter((sample) => sample.timestamp > this.lastTimestamp!);
        this.monitor = status.monitor;
        this.gaps = resources.gapCount;
        this.lastTimestamp = samples.at(-1)!.timestamp;
        return { samples: fresh, gap: restarted };
      }
      if (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv") || process.platform !== "linux") return { samples: [], gap: true };
      const counters = linuxResourceCounters(fs.readFileSync("/proc/stat", "utf8"), fs.readFileSync("/proc/meminfo", "utf8"));
      const previous = this.previous;
      this.previous = counters;
      if (!previous) return { samples: [], gap: true };
      const total = counters.total - previous.total, idle = counters.idle - previous.idle;
      if (total === 0 && this.latest && Date.now() - this.latest.timestamp <= HOST_RESOURCE_RULES.maxSampleGapMs) return { samples: [], gap: false };
      if (total <= 0 || idle < 0 || idle > total) throw new Error("CPU counters reset");
      this.latest = { timestamp: Date.now(), cpuPercent: Math.round((1 - idle / total) * 10_000) / 100,
        memoryPercent: Math.round(counters.memoryPercent * 100) / 100 };
      return { samples: [this.latest], gap: false };
    } catch {
      this.previous = undefined;
      return { samples: [], gap: true };
    }
  }
}
