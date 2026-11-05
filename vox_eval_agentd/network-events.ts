import {
  NETWORK_EVENT_RETENTION_MS, MAX_NETWORK_EVENT_BATCH, MAX_NETWORK_EVENTS_PER_RUN,
  type AgentNetworkEvent, type NetworkAck, type NetworkReport,
} from "../shared/network-event-protocol";
import type { LinkType } from "../shared/tags";

export type NetworkObservation = {
  link: LinkType | null;
  /** Private local fingerprint; never included in a report. */
  fingerprint: string;
  timestamp?: number;
};

/** A lease-scoped sequence, with one bounded, acknowledged queue per claim. */
export class NetworkEventBuffer {
  private seq = 0;
  private run?: {
    jobId: number; startedAt: string; firstSeq: number; start: number; wallStart: number;
    pending: Array<{ at: number; event: AgentNetworkEvent }>;
    networkChanged: boolean; changeCount: number; continuous: boolean; evictedThroughSeq: number;
    previous?: NetworkObservation; sampledAt: number; ended: boolean;
  };
  constructor(private now = () => performance.now(), private wall = () => Date.now()) {}

  start(jobId: number, startedAt: string, observation?: NetworkObservation): void {
    this.run = { jobId, startedAt, firstSeq: this.seq + 1, start: this.now(), wallStart: this.wall(),
      pending: [], networkChanged: false, changeCount: 0, continuous: !!observation,
      evictedThroughSeq: 0, previous: observation, sampledAt: this.now(), ended: false };
    this.append("monitoring_start", [], observation?.link ?? null);
    if (!observation) this.append("monitoring_gap", ["monitoring"], null);
  }

  observe(observation?: NetworkObservation): boolean {
    const run = this.run;
    if (!run || run.ended) return false;
    const at = this.now();
    if (!observation || at - run.sampledAt > 5000) {
      if (run.continuous) this.append("monitoring_gap", ["monitoring"], observation?.link ?? null);
      run.continuous = false;
    }
    run.sampledAt = at;
    const changed = !!(observation && run.previous && observation.fingerprint !== run.previous.fingerprint);
    if (changed && observation) {
      run.networkChanged = true;
      run.changeCount = Math.min(MAX_NETWORK_EVENTS_PER_RUN, run.changeCount + 1);
      this.append("network_change", observation.link !== run.previous?.link ? ["link", "interface"] : ["interface"], observation.link, observation.timestamp);
    }
    if (observation) run.previous = observation;
    return changed;
  }

  gap(): void { this.observe(undefined); }

  noteMissingChanges(count: number): void {
    const run = this.run;
    if (!run || run.ended || count <= 0) return;
    run.networkChanged = true;
    run.changeCount = Math.min(MAX_NETWORK_EVENTS_PER_RUN, run.changeCount + count);
    this.gap();
  }

  finish(observation?: NetworkObservation): void {
    if (!this.run || this.run.ended) return;
    this.observe(observation);
    this.append("monitoring_end", [], observation?.link ?? this.run.previous?.link ?? null);
    this.run.ended = true;
  }

  private append(event: AgentNetworkEvent["event"], changed: AgentNetworkEvent["changed"], link: LinkType | null, timestamp?: number): void {
    const run = this.run!;
    if (this.seq - run.firstSeq + 1 >= MAX_NETWORK_EVENTS_PER_RUN) {
      run.continuous = false;
      return;
    }
    const elapsed = Math.max(0, Math.round(this.now() - run.start));
    const offsetMs = timestamp === undefined ? elapsed : Math.max(0, Math.min(elapsed, timestamp - run.wallStart));
    run.pending.push({ at: this.now() - (elapsed - offsetMs), event: { seq: ++this.seq, event,
      timestamp: timestamp ?? run.wallStart + elapsed, offsetMs, tags: { link }, changed } });
    this.expire();
  }

  private expire(): void {
    const run = this.run!;
    while (run.pending.length && (run.pending[0].at <= this.now() - NETWORK_EVENT_RETENTION_MS || run.pending.length > MAX_NETWORK_EVENT_BATCH)) {
      run.evictedThroughSeq = Math.max(run.evictedThroughSeq, run.pending.shift()!.event.seq);
    }
  }

  report(): NetworkReport | undefined {
    const run = this.run;
    if (!run) return undefined;
    this.expire();
    return { version: 1, jobId: run.jobId, startedAt: run.startedAt, firstSeq: run.firstSeq, lastSeq: this.seq,
      networkChanged: run.networkChanged, changeCount: run.changeCount, continuous: run.continuous,
      evictedThroughSeq: run.evictedThroughSeq, events: run.pending.map(({ event }) => structuredClone(event)) };
  }

  acknowledge(ack: NetworkAck | undefined): void {
    const run = this.run;
    if (!ack || !run || ack.jobId !== run.jobId || ack.startedAt !== run.startedAt || !Array.isArray(ack.ackedEventSeqs)) return;
    const accepted = new Set(ack.ackedEventSeqs);
    run.pending = run.pending.filter(({ event }) => !accepted.has(event.seq));
  }

  clear(): void { this.run = undefined; }
}
