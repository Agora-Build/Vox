import { z } from "zod";
import { LINK_VALUES, type JobTag } from "./tags";
import { MAX_NETWORK_EVENT_BATCH, MAX_NETWORK_EVENTS_PER_RUN } from "./network-event-protocol";
export { NETWORK_EVENT_RETENTION_MS, MAX_NETWORK_EVENT_BATCH, MAX_NETWORK_EVENTS_PER_RUN } from "./network-event-protocol";

export type NetworkMode = "strict" | "all";
export type NetworkMonitoring = "unknown" | "monitoring" | "complete" | "incomplete";
export type NetworkEventTags = Record<string, string | null>;

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const agentNetworkEventSchema = z.object({
  seq: sequence.positive(),
  event: z.enum(["monitoring_start", "network_change", "monitoring_gap", "monitoring_end"]),
  timestamp: z.number().int().min(0).max(8_640_000_000_000_000),
  offsetMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
  tags: z.object({ link: z.enum(LINK_VALUES).nullable() }).strict(),
  changed: z.array(z.enum(["link", "interface", "egress", "monitoring"])).max(4),
}).strict();

export const networkReportEnvelopeSchema = z.object({
  version: z.literal(1),
  jobId: z.number().int().positive().max(2_147_483_647),
  startedAt: z.string().datetime(),
  firstSeq: sequence.positive(),
  lastSeq: sequence,
  networkChanged: z.boolean(),
  changeCount: sequence.max(MAX_NETWORK_EVENTS_PER_RUN),
  continuous: z.boolean(),
  evictedThroughSeq: sequence,
  events: z.array(z.unknown()).max(MAX_NETWORK_EVENT_BATCH),
}).strict();

export const networkReportSchema = networkReportEnvelopeSchema.extend({
  events: z.array(agentNetworkEventSchema).max(MAX_NETWORK_EVENT_BATCH),
}).superRefine((report, ctx) => {
  if (report.lastSeq < report.firstSeq - 1 || report.lastSeq - report.firstSeq >= MAX_NETWORK_EVENTS_PER_RUN
    || report.evictedThroughSeq > report.lastSeq || report.events.some((event) => event.seq < report.firstSeq || event.seq > report.lastSeq)
    || new Set(report.events.map((event) => event.seq)).size !== report.events.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid network event sequence range" });
  }
  if (!report.networkChanged && (report.changeCount > 0 || report.events.some((e) => e.event === "network_change"))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Network change summary is inconsistent" });
  }
});

export type AgentNetworkEvent = z.infer<typeof agentNetworkEventSchema>;
export type NetworkReport = z.infer<typeof networkReportSchema>;
export type NetworkAck = { jobId: number; startedAt: string; ackedEventSeqs: number[] };
export type NetworkRejectionReason = "event_conflict" | "invalid_event" | "invalid_report" | "execution_mismatch" | "sequence_mismatch";
export type NetworkRejectedEvent = { seq: number; reason: NetworkRejectionReason };
export type NetworkReportStatus = {
  jobId?: number;
  startedAt?: string;
  status: "accepted" | "partial" | "rejected" | "retry";
  incomplete: boolean;
  rejectedEvents: NetworkRejectedEvent[];
  reason?: NetworkRejectionReason | "storage_unavailable";
  expectedFirstSeq?: number;
};
export type NetworkReportResponse = { networkAck?: NetworkAck; networkReportStatus?: NetworkReportStatus };
export type NetworkHistoryEvent = {
  id: number;
  event: "initial" | AgentNetworkEvent["event"];
  source: "agent" | "core";
  seq: number | null;
  timestamp: number;
  offsetMs: number;
  tags: NetworkEventTags;
  changed: string[];
};
export type NetworkHistory = {
  events: NetworkHistoryEvent[];
  nextCursor: number | null;
  networkChanged: boolean;
  monitoring: NetworkMonitoring;
  changeCount: number;
};

/** Preserve the baseline elsewhere; event snapshots prefer detected evidence. */
export function networkEventTags(tags: JobTag[] | null | undefined): NetworkEventTags {
  const result: NetworkEventTags = {};
  for (const tag of tags ?? []) if (!(tag.key in result)) result[tag.key] = tag.value;
  for (const tag of tags ?? []) if (tag.source === "detected") result[tag.key] = tag.value;
  return result;
}
