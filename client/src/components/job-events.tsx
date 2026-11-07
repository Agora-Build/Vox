import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Activity, ArrowRightLeft, ChevronDown, CircleHelp, Cpu, Flag, Loader2, MemoryStick, Network, Radio, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { eventCategory, eventPresentation, formatEventOffset, formatResourcePercent, hostEventSummary, isInitialMonitoringGap, networkEventSummary,
  type EventPresentation, type EventTone } from "@/lib/job-events";
import type { EvalJob } from "@shared/schema";
import type { NetworkHistory, NetworkHistoryEvent } from "@shared/network-events";

const TONES: Record<EventTone, { panel: string; marker: string }> = {
  neutral: { panel: "border-border bg-muted/20", marker: "border-border bg-card text-muted-foreground" },
  active: { panel: "border-primary/20 bg-primary/5", marker: "border-primary/25 bg-card text-primary" },
  warning: { panel: "border-amber-500/20 bg-amber-500/5", marker: "border-amber-500/30 bg-card text-amber-700 dark:text-amber-400" },
  success: { panel: "border-emerald-500/20 bg-emerald-500/5", marker: "border-emerald-500/30 bg-card text-emerald-700 dark:text-emerald-400" },
};

function Tags({ event, unknown = false }: { event: NetworkHistoryEvent; unknown?: boolean }) {
  return <div className="flex flex-wrap gap-1.5">{Object.entries(event.tags).filter(([, value]) => unknown || value != null).map(([key, value]) => (
    <Badge key={key} variant="outline" className="min-w-0 max-w-full bg-background/40 font-mono text-[11px] font-normal break-all">{key}:{value ?? "unknown"}</Badge>
  ))}</div>;
}

function Summary({ label, description, tone, status, kind }: EventPresentation & { status?: string; kind: "network" | "host" }) {
  const Icon = kind === "network" ? Network : Cpu;
  return <div data-testid={`${kind}-event-summary`} className={cn("min-w-0 rounded-xl border p-3.5", TONES[tone].panel)}>
    <div className="flex items-start gap-2"><Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1">
      <p className="text-sm font-medium">{label}</p>
      {status && <p className="mt-1 text-[11px] text-muted-foreground">{status}</p>}
    </div></div>
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{description}</p>
  </div>;
}

function EventRow({ event, last, initialGap }: { event: NetworkHistoryEvent; last: boolean; initialGap: boolean }) {
  const presentation = eventPresentation(event, initialGap), kind = eventCategory(event);
  const Icon = kind === "cpu" ? Cpu : kind === "memory" ? MemoryStick : event.event === "monitoring_end" || event.event === "host_end" ? Flag
    : event.event === "network_change" ? ArrowRightLeft : presentation.tone === "warning" ? TriangleAlert : event.event === "initial" ? Network : Radio;
  const timestamp = new Date(event.timestamp), data = event.data;
  return <li data-testid={`job-event-${event.id}`} className="grid grid-cols-[3.5rem_1.75rem_minmax(0,1fr)] gap-x-2 sm:grid-cols-[5rem_2rem_minmax(0,1fr)] sm:gap-x-3">
    <div className="pt-1.5 text-right font-mono text-[10px] tabular-nums text-muted-foreground sm:text-xs" title={`+${(event.offsetMs / 1000).toFixed(1)} seconds`}>{formatEventOffset(event.offsetMs)}</div>
    <div className="relative flex justify-center">
      {!last && <div aria-hidden="true" className="absolute bottom-0 top-7 w-px bg-border" />}
      <span className={cn("relative z-10 flex h-7 w-7 items-center justify-center rounded-full border sm:h-8 sm:w-8", TONES[presentation.tone].marker)}><Icon aria-hidden="true" className="h-3.5 w-3.5" /></span>
    </div>
    <div className={cn("min-w-0 pt-1", last ? "pb-1" : "pb-6")}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm font-medium">{presentation.label}</span>
        <time className="text-[11px] tabular-nums text-muted-foreground" dateTime={timestamp.toISOString()} title={timestamp.toLocaleString()}>{timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
      </div>
      <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{presentation.description}</p>
      {(event.event === "initial" || event.event === "network_change") && <div className="mt-2.5"><Tags event={event} /></div>}
      {data && "cpuPercent" in data && data.cpuPercent !== null && data.memoryPercent !== null && <p className="mt-2 font-mono text-[11px] text-muted-foreground">CPU {formatResourcePercent(data.cpuPercent)} &middot; Memory {formatResourcePercent(data.memoryPercent)}</p>}
      <details className="group mt-2 text-xs">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><ChevronDown aria-hidden="true" className="h-3 w-3 transition-transform motion-reduce:transition-none group-open:rotate-180" />Details<span className="sr-only"> for {presentation.label}</span></summary>
        <div className="mt-2 space-y-2 rounded-lg border bg-muted/20 p-3">
          <p className="text-muted-foreground">{event.source === "core" ? "Core observation" : "Agent observation"} &middot; {timestamp.toLocaleString()}</p>
          <p className="break-words text-muted-foreground">Event: {event.event}</p>
          {event.changed.length > 0 && <p className="text-muted-foreground">Recorded dimensions: {event.changed.join(", ")}</p>}
          <Tags event={event} unknown />
          {data && <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-[11px]">{Object.entries(data).map(([key, value]) => <div key={key} className="contents"><dt className="break-all text-muted-foreground">{key}</dt><dd className="break-all">{value ?? "unavailable"}</dd></div>)}</dl>}
        </div>
      </details>
    </div>
  </li>;
}

export function JobEvents({ job }: { job: EvalJob }) {
  const [expanded, setExpanded] = useState(false);
  const [category, setCategory] = useState("All");
  const query = useInfiniteQuery<NetworkHistory>({
    queryKey: ["job-events", job.id, job.startedAt], initialPageParam: 0,
    enabled: expanded,
    queryFn: async ({ pageParam, signal }) => {
      const response = await fetch(`/api/eval-jobs/${job.id}/events?cursor=${pageParam}`, { signal });
      if (!response.ok) throw new Error("Failed to load events");
      return response.json();
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: expanded && job.status === "running" ? 10_000 : false,
  });
  const history = query.data?.pages[0];
  const events = (query.data?.pages.flatMap((page) => page.events) ?? []).sort((a, b) => a.offsetMs - b.offsetMs || a.id - b.id);
  const initialGap = events.some((event) => isInitialMonitoringGap(event, events));
  const visibleEvents = events.filter((event) => category === "All" || eventCategory(event) === category.toLowerCase()
    || (category !== "Network" && eventCategory(event) === "host"));
  return <Collapsible open={expanded} onOpenChange={setExpanded} asChild><Card data-testid="job-network-timeline" className="overflow-hidden">
    <CardHeader className="gap-4 space-y-0 p-4 sm:p-6">
      <CollapsibleTrigger asChild>
        <button type="button" aria-label="Events" className="flex w-full items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border bg-muted/30"><Activity aria-hidden="true" className="h-4 w-4 text-muted-foreground" /></div>
          <div className="min-w-0 flex-1"><CardTitle role="heading" aria-level={2} className="text-base">Events</CardTitle><CardDescription className="mt-1 text-xs">Agent conditions during this evaluation</CardDescription></div>
          <ChevronDown aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", expanded && "rotate-180")} />
        </button>
      </CollapsibleTrigger>
      {expanded && history && <div className="grid gap-3 md:grid-cols-2">
        <Summary kind="network" {...networkEventSummary(history, job.status === "running", initialGap)} />
        <Summary kind="host" {...hostEventSummary(history.resources)} />
      </div>}
    </CardHeader>
    <CollapsibleContent asChild><CardContent className="space-y-4 px-4 pb-4 pt-0 sm:px-6 sm:pb-6">
      {query.isPending && <p className="flex items-center gap-2 py-3 text-sm text-muted-foreground" role="status"><Loader2 aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" />Loading events...</p>}
      {query.isError && <p className="text-sm text-destructive" role="alert">Events could not be loaded. <Button variant="link" size="sm" onClick={() => query.refetch()}>Retry</Button></p>}
      {history && <div role="group" aria-label="Event category" className="flex w-fit max-w-full flex-wrap gap-1 rounded-lg border bg-muted/30 p-1">
        {["All", "Network", "CPU", "Memory"].map((value) => <Button key={value} variant="ghost" size="sm" aria-pressed={category === value}
          className={cn("h-7 px-3 text-xs", category === value && "bg-background shadow-sm")} onClick={() => setCategory(value)}>{value}</Button>)}
      </div>}
      {history && visibleEvents.length === 0 && <p className="py-2 text-sm text-muted-foreground">No {category === "All" ? "" : `${category.toLowerCase()} `}events recorded{query.hasNextPage ? " in the loaded history" : " for this run"}.</p>}
      <ol aria-label="Evaluation events" className={cn("pr-1", visibleEvents.length > 8 && "max-h-[36rem] overflow-y-auto")}>
        {visibleEvents.map((event, index) => <EventRow key={event.id} event={event} last={index === visibleEvents.length - 1} initialGap={isInitialMonitoringGap(event, events)} />)}
      </ol>
      {query.hasNextPage && <Button variant="outline" size="sm" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading..." : "Load more events"}</Button>}
      {history && <details className="group border-t pt-3 text-xs text-muted-foreground">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><CircleHelp aria-hidden="true" className="h-3.5 w-3.5" />How monitoring works<ChevronDown aria-hidden="true" className="h-3 w-3 transition-transform motion-reduce:transition-none group-open:rotate-180" /></summary>
        <div className="mt-2 max-w-3xl space-y-2 leading-relaxed">
          <p>Initial network tags stay frozen. Later events describe observations, not replacements for the baseline. Missing monitoring cannot be reconstructed later.</p>
          <p>CPU and memory warnings require usage above 80% for 30 seconds; recovery requires below 75% for 30 seconds. A rapid rise means at least 20 percentage points over five minutes, not a relative 20% increase.</p>
          <p>Host-resource events are diagnostic and do not change the evaluation result or current Strict eligibility. Strict currently checks complete network coverage and no detected network changes.</p>
          <p>The agent retains unacknowledged events for two minutes. Recorded conditions remain in its run summary even if pending details expire. Missing samples never prove stability.</p>
          {history.changeCount > 0 && <p>{history.changeCount} network change observation(s). Core and agent may observe the same transition.</p>}
        </div>
      </details>}
    </CardContent></CollapsibleContent>
  </Card></Collapsible>;
}
