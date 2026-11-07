import { HOST_RESOURCE_RULES as rules, type HostResourceSample, type HostResourceMetric,
  type HostResourceEvent, type HostResourceSnapshot } from "../shared/host-resources";
import type { HostResourceObservation } from "./host-resource-observer";

type Condition = { above?: number; below?: number; active: boolean; peak: number; rising: boolean; riseResetSince?: number };
const emptyCondition = (): Condition => ({ active: false, peak: 0, rising: false });
const valueFor = (sample: HostResourceSample, metric: HostResourceMetric) => metric === "cpu" ? sample.cpuPercent : sample.memoryPercent;

export class HostResourceMonitor {
  private samples: HostResourceSample[] = [];
  private conditions = { cpu: emptyCondition(), memory: emptyCondition() };
  private available = false;

  constructor(private now = () => Date.now()) {}

  snapshot(): HostResourceSnapshot {
    const latest = this.samples.at(-1);
    const fresh = this.available && latest && Math.abs(this.now() - latest.timestamp) <= rules.maxSampleGapMs;
    return { ruleVersion: 1, cpuPercent: fresh ? latest.cpuPercent : null, memoryPercent: fresh ? latest.memoryPercent : null };
  }

  private gap(events: HostResourceEvent[]): void {
    if (this.available) events.push({ event: "host_gap", data: { ruleVersion: 1, cpuPercent: null, memoryPercent: null } });
    this.available = false;
    this.samples = [];
    this.conditions = { cpu: emptyCondition(), memory: emptyCondition() };
  }

  observe(observation: HostResourceObservation): HostResourceEvent[] {
    const events: HostResourceEvent[] = [];
    if (observation.gap) this.gap(events);
    for (const sample of observation.samples) {
      const prior = this.samples.at(-1);
      if (prior && sample.timestamp <= prior.timestamp) continue;
      if (prior && sample.timestamp - prior.timestamp > rules.maxSampleGapMs) this.gap(events);
      this.available = true;
      this.samples.push(sample);
      const cutoff = sample.timestamp - rules.riseWindowMs;
      // Retain the sample immediately before the window, not just newer ones.
      while (this.samples.length > 1 && this.samples[1].timestamp <= cutoff) this.samples.shift();
      const baseline = this.samples[0];
      for (const metric of ["cpu", "memory"] as const) {
        const state = this.conditions[metric], value = valueFor(sample, metric);
        if (value > rules.highPercent) {
          state.above ??= sample.timestamp;
          state.peak = Math.max(state.peak, value);
          state.below = undefined;
          if (!state.active && sample.timestamp - state.above >= rules.sustainedMs) {
            state.active = true;
            events.push({ event: "host_high", timestamp: sample.timestamp, data: { ruleVersion: 1, metric, valuePercent: value, thresholdPercent: rules.highPercent,
              durationMs: sample.timestamp - state.above, peakPercent: state.peak } });
          }
        } else if (!state.active) {
          state.above = undefined;
          state.peak = 0;
        }
        if (state.active) {
          state.peak = Math.max(state.peak, value);
          if (value < rules.recoveryPercent) {
            state.below ??= sample.timestamp;
            if (sample.timestamp - state.below >= rules.sustainedMs) {
              events.push({ event: "host_recovered", timestamp: sample.timestamp, data: { ruleVersion: 1, metric, valuePercent: value, thresholdPercent: rules.recoveryPercent,
                durationMs: sample.timestamp - state.above!, peakPercent: state.peak } });
              state.active = false; state.above = undefined; state.below = undefined; state.peak = 0;
            }
          } else state.below = undefined;
        }
        const ready = sample.timestamp - baseline.timestamp >= rules.riseWindowMs
          && sample.timestamp - baseline.timestamp <= rules.riseWindowMs + rules.maxSampleGapMs;
        const rise = ready && value - valueFor(baseline, metric) >= rules.risePoints;
        if (rise && !state.rising) {
          events.push({ event: "host_rise", timestamp: sample.timestamp, data: { ruleVersion: 1, metric, valuePercent: value,
            previousPercent: valueFor(baseline, metric), windowMs: rules.riseWindowMs, risePoints: rules.risePoints } });
          state.rising = true;
        }
        if (state.rising && ready && value - valueFor(baseline, metric) < rules.risePoints - 5) {
          state.riseResetSince ??= sample.timestamp;
          if (sample.timestamp - state.riseResetSince >= rules.sustainedMs) state.rising = false;
        } else state.riseResetSince = undefined;
      }
    }
    const last = this.samples.at(-1);
    if (this.available && (!last || Math.abs(this.now() - last.timestamp) > rules.maxSampleGapMs)) this.gap(events);
    return events;
  }

  begin(): HostResourceEvent[] {
    const data = this.snapshot();
    const events: HostResourceEvent[] = [{ event: "host_start", data }];
    if (data.cpuPercent === null || data.memoryPercent === null) return [...events, { event: "host_gap", data }];
    const latest = this.samples.at(-1)!;
    for (const metric of ["cpu", "memory"] as const) {
      const state = this.conditions[metric];
      if (state.active && valueFor(latest, metric) > rules.highPercent) events.push({ event: "host_high", data: { ruleVersion: 1,
        metric, valuePercent: valueFor(latest, metric), thresholdPercent: rules.highPercent,
        durationMs: latest.timestamp - state.above!, peakPercent: state.peak } });
      if (state.rising && valueFor(latest, metric) - valueFor(this.samples[0], metric) >= rules.risePoints) events.push({ event: "host_rise", data: { ruleVersion: 1, metric, valuePercent: valueFor(latest, metric),
        previousPercent: valueFor(this.samples[0], metric), windowMs: rules.riseWindowMs, risePoints: rules.risePoints } });
    }
    return events;
  }
}
