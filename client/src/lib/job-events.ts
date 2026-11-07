import type { NetworkHistory, NetworkHistoryEvent } from "@shared/network-events";
import type { HostResourceSummary } from "@shared/host-resources";

export type EventCategory = "network" | "cpu" | "memory" | "host";
export type EventTone = "neutral" | "active" | "warning" | "success";
export type EventPresentation = { label: string; description: string; tone: EventTone };

export function eventCategory(event: NetworkHistoryEvent): EventCategory {
  return event.data && "metric" in event.data ? event.data.metric : event.event.startsWith("host_") ? "host" : "network";
}

export function isInitialMonitoringGap(event: NetworkHistoryEvent, events: NetworkHistoryEvent[]): boolean {
  return event.event === "monitoring_gap" && event.source === "agent" && event.seq !== null
    && events.some((start) => start.event === "monitoring_start" && start.source === "agent" && start.tags.link == null
      && start.seq !== null && event.seq === start.seq + 1);
}

export function formatEventOffset(offsetMs: number): string {
  if (offsetMs < 60_000) return `+${(offsetMs / 1000).toFixed(1)}s`;
  const seconds = Math.floor(offsetMs / 1000), hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60, remainder = String(seconds % 60).padStart(2, "0");
  return hours ? `+${hours}h ${String(minutes).padStart(2, "0")}m ${remainder}s` : `+${minutes}m ${remainder}s`;
}

export const formatResourcePercent = (value: number) => `${Number(value.toFixed(1))}%`;

export function eventPresentation(event: NetworkHistoryEvent, initialGap: boolean): EventPresentation {
  const data = event.data;
  const metric = data && "metric" in data ? (data.metric === "cpu" ? "CPU" : "memory") : "resources";
  if (event.event === "host_high" && data && "durationMs" in data) return {
    label: `Host ${metric} high`, tone: "warning",
    description: `${formatResourcePercent(data.valuePercent)} usage; above ${data.thresholdPercent}% for at least ${Math.floor(data.durationMs / 1000)} seconds.`,
  };
  if (event.event === "host_recovered" && data && "durationMs" in data) return {
    label: `Host ${metric} recovered`, tone: "success",
    description: `${formatResourcePercent(data.valuePercent)} usage; below ${data.thresholdPercent}% for 30 seconds. Episode peak: ${formatResourcePercent(data.peakPercent)}.`,
  };
  if (event.event === "host_rise" && data && "previousPercent" in data) return {
    label: `Host ${metric} rising quickly`, tone: "active",
    description: `${formatResourcePercent(data.previousPercent)} to ${formatResourcePercent(data.valuePercent)} in ${data.windowMs / 60_000} minutes (+${Number((data.valuePercent - data.previousPercent).toFixed(1))} percentage points).`,
  };
  switch (event.event) {
    case "initial": return { label: "Initial", description: "Starting connection recorded by Core. These tags stay fixed for filtering and grouping.", tone: "neutral" };
    case "monitoring_start": return { label: "Network monitoring started", description: event.tags.link == null
      ? "Event recording started, but no usable network sample was available yet." : "The agent began observing the network connection.", tone: "neutral" };
    case "monitoring_gap": return { label: initialGap ? "Network tracking unavailable" : "Network tracking interrupted",
      description: initialGap ? "No usable network sample was available at the start. This does not mean the Internet was disconnected."
        : "Some network observations are missing. This alone does not mean the connection changed.", tone: "warning" };
    case "network_change": return { label: "Network changed", description: event.changed.includes("link")
      ? "A change in connection type was detected." : event.changed.includes("egress") ? "Core observed a change in the Internet connection."
        : "A change in the network interface or route was detected.", tone: "warning" };
    case "monitoring_end": return { label: "End", description: "The agent finished recording network events for this run.", tone: "neutral" };
    case "host_start": return { label: "Host monitoring started", description: "CPU and memory observations describe the host machine, not only the agent container.", tone: "neutral" };
    case "host_gap": return { label: "Host tracking unavailable", description: "Host CPU or memory samples are unavailable or missing. This is not evidence of high usage.", tone: "warning" };
    case "host_end": return { label: "Host monitoring ended", description: "The agent finished recording host-resource events for this run.", tone: "neutral" };
    default: return { label: "Agent event", description: "Open Details for the recorded observation.", tone: "neutral" };
  }
}

export function networkEventSummary(history: NetworkHistory, running: boolean, initialGap: boolean): EventPresentation & { status: string } {
  if (history.networkChanged) return { label: "Network changed", status: "Excluded from Strict", tone: "warning",
    description: `A network change was detected. Initial tags remain unchanged.${history.monitoring === "incomplete" ? " Network monitoring was also incomplete." : ""}` };
  if (history.monitoring === "complete") return { label: "No network changes detected", status: "Eligible for Strict", tone: "success",
    description: "Network monitoring covered the run from start to end." };
  if (running && history.monitoring === "monitoring") return { label: "Network monitoring active", status: "Verification pending", tone: "active",
    description: "Network coverage is checked when the run ends." };
  if (running && history.monitoring === "unknown") return { label: "Waiting for network report", status: "Verification pending", tone: "neutral",
    description: "Network observations have not been confirmed yet." };
  return { label: "Network monitoring incomplete", status: "Excluded from Strict", tone: "warning",
    description: `${initialGap ? "No usable network sample was available at the start." : "The run has no complete network monitoring history."} Missing historical coverage cannot be reconstructed later. This does not change the evaluation result.` };
}

export function hostEventSummary(resources: HostResourceSummary | null | undefined): EventPresentation {
  if (!resources || resources.monitoring === "unknown") return { label: "Host resources not monitored", tone: "neutral",
    description: "No host CPU/memory coverage was reported. An updated agent and supported host sampler are required." };
  if (resources.highUsage) return { label: "High host usage recorded", tone: "warning",
    description: `CPU or memory exceeded 80% for at least 30 seconds.${resources.monitoring === "incomplete" ? " Host monitoring was also incomplete." : ""} See events for recoveries and measured values.` };
  if (resources.monitoring === "incomplete") return { label: "Host monitoring incomplete", tone: "warning",
    description: `Some host observations are missing.${resources.rapidRise ? " A rapid usage increase was also recorded." : " Missing data is not evidence of healthy resource usage."}` };
  if (resources.rapidRise) return { label: "Rapid usage increase recorded", tone: "active",
    description: "Usage rose by at least 20 percentage points over five minutes. A rise alone is not a high-usage warning." };
  return { label: resources.monitoring === "complete" ? "Host monitoring complete" : "Host monitoring active",
    tone: resources.monitoring === "complete" ? "success" : "active",
    description: "No resource alerts recorded. The five-minute rise check needs a full sample window before it can detect a trend." };
}
