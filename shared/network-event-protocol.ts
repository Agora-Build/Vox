// Runtime-safe constants for the standalone daemon; validation stays in Core.
export const NETWORK_EVENT_RETENTION_MS = 120_000;
export const MAX_NETWORK_EVENT_BATCH = 128;
export const MAX_NETWORK_EVENTS_PER_RUN = 20_000;
export type { AgentNetworkEvent, NetworkAck, NetworkReport, NetworkReportStatus } from "./network-events";
