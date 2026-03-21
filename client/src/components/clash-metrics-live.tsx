interface LiveMetrics {
  [key: string]: unknown;
}

export default function ClashMetricsLive({ metrics, agentAName, agentBName }: {
  metrics: LiveMetrics | null;
  agentAName?: string;
  agentBName?: string;
}) {
  if (!metrics) {
    return (
      <div className="text-sm text-muted-foreground">
        Waiting for metrics data...
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <span className="text-sm font-medium">Live Metrics</span>
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-muted-foreground">{agentAName || "Agent A"}</span>
          <div className="font-mono">
            {metrics.latencyA != null ? `${metrics.latencyA}ms` : "—"}
          </div>
        </div>
        <div>
          <span className="text-muted-foreground">{agentBName || "Agent B"}</span>
          <div className="font-mono">
            {metrics.latencyB != null ? `${metrics.latencyB}ms` : "—"}
          </div>
        </div>
      </div>
    </div>
  );
}
