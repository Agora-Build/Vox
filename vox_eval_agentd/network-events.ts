import {
  NETWORK_EVENT_RETENTION_MS, MAX_NETWORK_EVENT_BATCH, MAX_NETWORK_EVENTS_PER_RUN,
  type AgentNetworkEvent, type NetworkAck, type NetworkReport, type NetworkReportStatus,
} from "../shared/network-event-protocol";
import type { LinkType } from "../shared/tags";
import type { HostResourceEvent, HostResourceReport } from "../shared/host-resources";

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
    previous?: NetworkObservation; sampledAt: number; deliveredAt: number; ended: boolean;
    resources?: HostResourceReport;
    resourcesEnabled: boolean;
  };
  constructor(private now = () => performance.now(), private wall = () => Date.now()) {}

  start(jobId: number, startedAt: string, observation?: NetworkObservation, resourcesEnabled = true): void {
    this.run = { jobId, startedAt, firstSeq: this.seq + 1, start: this.now(), wallStart: this.wall(),
      pending: [], networkChanged: false, changeCount: 0, continuous: !!observation,
      evictedThroughSeq: 0, previous: observation, sampledAt: this.now(), deliveredAt: this.now(), ended: false, resourcesEnabled };
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

  resource(event: HostResourceEvent): void {
    const run = this.run;
    if (!run || run.ended || !run.resourcesEnabled) return;
    run.resources ??= { ruleVersion: 1, continuous: true, highUsage: false, rapidRise: false };
    if (event.event === "host_gap") run.resources.continuous = false;
    if (event.event === "host_high") run.resources.highUsage = true;
    if (event.event === "host_rise") run.resources.rapidRise = true;
    this.append(event.event, [], null, event.timestamp, event.data);
  }

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

  private append(event: AgentNetworkEvent["event"], changed: AgentNetworkEvent["changed"], link: LinkType | null, timestamp?: number, data?: HostResourceEvent["data"]): void {
    const run = this.run!;
    if (this.seq - run.firstSeq + 1 >= MAX_NETWORK_EVENTS_PER_RUN) {
      run.continuous = false;
      if (run.resources) run.resources.continuous = false;
      return;
    }
    const elapsed = Math.max(0, Math.round(this.now() - run.start));
    const offsetMs = timestamp === undefined ? elapsed : Math.max(0, Math.min(elapsed, timestamp - run.wallStart));
    run.pending.push({ at: this.now() - (elapsed - offsetMs), event: { seq: ++this.seq, event,
      timestamp: timestamp ?? run.wallStart + elapsed, offsetMs, tags: { link }, changed, ...(data ? { data } : {}) } as AgentNetworkEvent });
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
    if (this.now() - run.deliveredAt >= NETWORK_EVENT_RETENTION_MS) {
      run.continuous = false;
      if (run.resources) run.resources.continuous = false;
    }
    this.expire();
    return { version: run.resources ? 2 : 1, jobId: run.jobId, startedAt: run.startedAt, firstSeq: run.firstSeq, lastSeq: this.seq,
      networkChanged: run.networkChanged, changeCount: run.changeCount, continuous: run.continuous,
      evictedThroughSeq: run.evictedThroughSeq, events: run.pending.map(({ event }) => structuredClone(event)),
      ...(run.resources ? { resources: { ...run.resources } } : {}) };
  }

  acknowledge(ack: NetworkAck | undefined, sent?: NetworkReport): void {
    const run = this.run;
    if (!ack || !run || ack.jobId !== run.jobId || ack.startedAt !== run.startedAt || !Array.isArray(ack.ackedEventSeqs)) return;
    if (sent && (sent.jobId !== run.jobId || sent.startedAt !== run.startedAt)) return;
    if (this.now() - run.deliveredAt >= NETWORK_EVENT_RETENTION_MS) {
      run.continuous = false;
      if (run.resources) run.resources.continuous = false;
    }
    run.deliveredAt = this.now();
    const submitted = sent && new Set(sent.events.map((event) => event.seq));
    const accepted = new Set(ack.ackedEventSeqs.filter((seq) => !submitted || submitted.has(seq)));
    run.pending = run.pending.filter(({ event }) => !accepted.has(event.seq));
  }

  recover(status: NetworkReportStatus | undefined, sent: NetworkReport | undefined): void {
    const run = this.run;
    if (!status || !run || !sent || status.jobId !== run.jobId || status.startedAt !== run.startedAt
      || sent.jobId !== run.jobId || sent.startedAt !== run.startedAt) return;
    if (status.incomplete || status.status === "partial" || status.status === "rejected") {
      run.continuous = false;
      // Network-only gaps do not invalidate host samples. Rejected or lost
      // telemetry does, because the shared sequence can no longer prove coverage.
      if (run.resources && status.status !== "accepted") run.resources.continuous = false;
    }
    if (status.status !== "partial" && status.status !== "rejected") return;
    const submitted = new Set(sent.events.map((event) => event.seq));
    const rejected = new Set((status.rejectedEvents ?? []).filter((event) => submitted.has(event.seq)).map((event) => event.seq));
    run.pending = run.pending.filter(({ event }) => !rejected.has(event.seq));
    const first = status.expectedFirstSeq;
    if (first !== undefined && Number.isSafeInteger(first) && first > 0
      && Math.max(this.seq, first - 1) - first < MAX_NETWORK_EVENTS_PER_RUN) {
      run.firstSeq = first;
      this.seq = Math.max(this.seq, first - 1);
    }
  }

  clear(): void { this.run = undefined; }
}
