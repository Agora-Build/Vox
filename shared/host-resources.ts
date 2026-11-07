// Versioned, deterministic rules shared by the host sampler, daemon and console.
export const HOST_RESOURCE_RULES = {
  version: 1,
  highPercent: 80,
  recoveryPercent: 75,
  sustainedMs: 30_000,
  risePoints: 20,
  riseWindowMs: 300_000,
  maxSampleGapMs: 5_000,
} as const;

export type HostResourceMetric = "cpu" | "memory";
export type HostResourceSample = { timestamp: number; cpuPercent: number; memoryPercent: number };
export type HostResourceCoverage = "unknown" | "monitoring" | "complete" | "incomplete";
export type HostResourceSummary = {
  ruleVersion: 1;
  monitoring: HostResourceCoverage;
  highUsage: boolean;
  rapidRise: boolean;
};
export type HostResourceReport = { ruleVersion: 1; continuous: boolean; highUsage: boolean; rapidRise: boolean };
export type HostResourceSnapshot = { ruleVersion: 1; cpuPercent: number | null; memoryPercent: number | null };
export type HostResourceCondition = {
  ruleVersion: 1; metric: HostResourceMetric; valuePercent: number;
  thresholdPercent: number; durationMs: number; peakPercent: number;
};
export type HostResourceRise = {
  ruleVersion: 1; metric: HostResourceMetric; valuePercent: number;
  previousPercent: number; windowMs: number; risePoints: number;
};
export type HostResourceEvent = (
  | { event: "host_start" | "host_gap" | "host_end"; data: HostResourceSnapshot }
  | { event: "host_high" | "host_recovered"; data: HostResourceCondition }
  | { event: "host_rise"; data: HostResourceRise }
) & { timestamp?: number };
export type HostResourceEventData = HostResourceEvent["data"];

export function isHostResourceEvent(event: string): boolean {
  return event.startsWith("host_");
}
