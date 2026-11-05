import { useInfiniteQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { EvalJob } from "@shared/schema";
import type { NetworkHistory } from "@shared/network-events";

const LABELS: Record<string, string> = {
  initial: "Initial network", network_change: "Network changed", monitoring_start: "Monitoring started",
  monitoring_end: "Monitoring ended", monitoring_gap: "Monitoring gap",
};

export function JobNetworkTimeline({ job }: { job: EvalJob }) {
  const query = useInfiniteQuery<NetworkHistory>({
    queryKey: ["job-network-events", job.id, job.startedAt], initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const response = await fetch(`/api/eval-jobs/${job.id}/network-events?cursor=${pageParam}`, { signal });
      if (!response.ok) throw new Error("Failed to load network history");
      return response.json();
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: job.status === "running" ? 10000 : false,
  });
  const history = query.data?.pages[0];
  const events = (query.data?.pages.flatMap((page) => page.events) ?? []).sort((a, b) => a.offsetMs - b.offsetMs || a.id - b.id);
  const eligible = history?.monitoring === "complete" && !history.networkChanged;
  return (
    <Card data-testid="job-network-timeline">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Network timeline</CardTitle>
          {history && <Badge variant={eligible ? "secondary" : "outline"}>{history.networkChanged ? "Network changed" : eligible ? "Verified stable" : history.monitoring === "monitoring" ? "Monitoring" : "Unverified"}</Badge>}
        </div>
        <CardDescription>Baseline tags stay frozen at claim. Events describe later observations; delayed events cannot verify a historical ISP.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isPending && <p className="text-sm text-muted-foreground" role="status">Loading network history...</p>}
        {query.isError && <p className="text-sm text-destructive" role="alert">Network history could not be loaded. <Button variant="link" size="sm" onClick={() => query.refetch()}>Retry</Button></p>}
        {history && <p className="text-xs text-muted-foreground">{eligible ? "Eligible for strict benchmarks." : "Excluded from strict benchmarks until complete monitoring confirms no network changes."} {history.changeCount > 0 && `${history.changeCount} change observation(s). Core and agent may observe the same transition.`}</p>}
        {history?.monitoring === "incomplete" && <p className="text-xs text-amber-600 dark:text-amber-400">Monitoring was unavailable or some event details are missing. Expiring the agent's two-minute buffer never clears a recorded network change.</p>}
        {history && events.length === 0 && <p className="text-sm text-muted-foreground">No network events recorded for this run. Older agents and historical jobs are unverified.</p>}
        <ol className="max-h-96 overflow-y-auto space-y-4 pr-2">
          {events.map((event) => (
            <li key={event.id} className="border-l-2 border-muted pl-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="font-mono text-xs text-muted-foreground">+{(event.offsetMs / 1000).toFixed(1)}s</span>
                <span className="font-medium">{LABELS[event.event] ?? event.event}</span>
                <span className="text-xs text-muted-foreground">{event.source === "core" ? "Core observation" : "Agent observation"}</span>
                <time className="text-xs text-muted-foreground" dateTime={new Date(event.timestamp).toISOString()}>{new Date(event.timestamp).toLocaleString()}</time>
              </div>
              {event.changed.length > 0 && <p className="text-xs text-muted-foreground">Changed: {event.changed.join(", ")}</p>}
              <div className="mt-1 flex flex-wrap gap-1">
                {Object.entries(event.tags).map(([key, value]) => <Badge key={key} variant="outline" className="font-mono text-[11px] font-normal break-all">{key}:{value ?? "unknown"}</Badge>)}
              </div>
            </li>
          ))}
        </ol>
        {query.hasNextPage && <Button variant="outline" size="sm" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading..." : "Load more events"}</Button>}
      </CardContent>
    </Card>
  );
}
