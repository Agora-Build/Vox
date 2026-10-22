import { useState, useMemo } from "react";
import { appendRegionScopes, formatSite, formatRegionScopeSelection } from "@/lib/utils";
import { RegionScopeSelector } from "@/components/region-scope-selector";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ArrowUpDown, ArrowUp, ArrowDown, Info } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRegionLocations } from "@/hooks/use-regions";
import { MetricsTagControls, useMetricsTagUrlState, appendTagParams, tagParamsKey, customTagKeys, groupLabel, isEmptyGroup, accessView, LAST_MILE_HINT } from "@/components/metrics-tag-controls";
import { formatTag } from "@shared/tags";

interface LeaderboardEntry {
  rank: number;
  provider: string;
  siteId: string;
  regionLabel?: string;
  countryCode?: string | null;
  countryName?: string | null;
  macroRegionCode?: string | null;
  macroRegionName?: string | null;
  // Latency is null (NA) when every run in the group was non-responsive.
  responseLatency: number | null;
  responseLatencyP95: number | null;
  interruptLatency: number | null;
  interruptLatencyP95: number | null;
  // Turn Success Rate (0..1), or null. Includes no-response turns as failures.
  turnSuccessRate: number | null;
  networkResilience: number | null;
  naturalness: number | null;
  noiseReduction: number | null;
  compositeScore: number;
  /** With groupBy: this row's value of the grouped tag ("untagged" when none). */
  tagValue?: string;
  /** Without an access filter: the same averages over the row's last-mile / datacenter results. */
  lastMile?: AccessColumn;
  datacenter?: AccessColumn;
}

interface AccessColumn {
  count: number;
  responseLatency: number | null;
  interruptLatency: number | null;
  turnSuccessRate: number | null;
}

/** "820 / 610" — last mile / datacenter; a side with no results shows a dash. */
function AccessSplit({ lm, dc, format, testId }: { lm?: AccessColumn; dc?: AccessColumn; format: (c: AccessColumn) => string; testId: string }) {
  const side = (c?: AccessColumn) => (c && c.count > 0 ? format(c) : "–");
  return (
    <div className="text-xs text-muted-foreground" data-testid={testId} title="Last mile / datacenter">
      {side(lm)} / {side(dc)}
    </div>
  );
}

type SortField = "rank" | "responseLatency" | "interruptLatency" | "turnSuccessRate" | "networkResilience" | "naturalness" | "noiseReduction";
type SortDirection = "asc" | "desc";

// null = not measured: latency when every run was non-responsive; Network /
// Naturalness / Noise until something measures them (#217).
const naNum = (v: number | null, suffix = "") => v == null ? "N/A" : `${v}${suffix}`;
// Turn Success Rate is 0..1; null = no evaluable turns. Show as a percentage.
const naPct = (v: number | null) => v == null ? "N/A" : `${Math.round(v * 100)}%`;

export default function Leaderboard() {
  const [regionScopes, setRegionScopes] = useState<string[]>(["all"]);
  const [sortField, setSortField] = useState<SortField>("rank");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [timeRange, setTimeRange] = useState<string>("168"); // 7 days default
  const [selectedEntry, setSelectedEntry] = useState<LeaderboardEntry | null>(null);
  const { data: regionLocations } = useRegionLocations();
  const { tagFilters, setTagFilters, groupBy, setGroupBy } = useMetricsTagUrlState();

  const regionScopeKey = [...regionScopes].sort().join(",");
  // All (no access filter): each row also shows its last-mile / datacenter split.
  const showAccess = accessView(tagFilters) === "all";
  const { data: leaderboardData, isLoading } = useQuery<LeaderboardEntry[]>({
    queryKey: ['/api/metrics/leaderboard', timeRange, regionScopeKey, tagParamsKey(tagFilters, groupBy)],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (timeRange !== "all") {
        params.set("hours", timeRange);
      }
      appendRegionScopes(params, regionScopes);
      appendTagParams(params, tagFilters, groupBy);
      const res = await fetch(`/api/metrics/leaderboard?${params}`);
      if (!res.ok) throw new Error("Failed to fetch leaderboard");
      return res.json();
    },
  });

  const filteredAndSortedData = useMemo(() => {
    if (!leaderboardData) return [];

    // Sort data
    const sorted = [...leaderboardData].sort((a, b) => {
      if (sortField === "rank") {
        return sortDirection === "asc" ? a.rank - b.rank : b.rank - a.rank;
      }

      const av = a[sortField];
      const bv = b[sortField];
      // NA (null) always sinks to the bottom, whichever direction — a
      // non-responsive agent must never sort as the fastest.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;

      const lowerIsBetter = sortField === "responseLatency" || sortField === "interruptLatency";
      const comparison = lowerIsBetter ? av - bv : bv - av;
      return sortDirection === "asc" ? comparison : -comparison;
    });

    return sorted;
  }, [leaderboardData, sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      // Default direction based on field type
      if (field === "responseLatency" || field === "interruptLatency" || field === "rank") {
        setSortDirection("asc"); // Lower is better
      } else {
        setSortDirection("desc"); // Higher is better
      }
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return <ArrowUpDown className="h-4 w-4 ml-1" />;
    }
    return sortDirection === "asc"
      ? <ArrowUp className="h-4 w-4 ml-1" />
      : <ArrowDown className="h-4 w-4 ml-1" />;
  };

  const regionLabel = formatRegionScopeSelection(regionLocations ?? [], regionScopes);

  const timeRangeLabel = timeRange === "24" ? "Last 24 hours"
    : timeRange === "168" ? "Last 7 days"
    : timeRange === "720" ? "Last 30 days"
    : "All time";

  return (
    <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight" data-testid="text-leaderboard-title">Global Leaderboard</h1>
            <Popover>
              <PopoverTrigger asChild>
                <Info className="h-5 w-5 text-muted-foreground cursor-pointer hover:text-foreground transition-colors shrink-0" />
              </PopoverTrigger>
              <PopoverContent className="w-96" align="start">
                <div className="space-y-3">
                  <h4 className="font-semibold leading-none">Ranking Algorithm</h4>
                  <p className="text-sm text-muted-foreground">
                    Rankings are computed using a <strong>normalized weighted composite score</strong> across 6 metrics:
                  </p>
                  <div className="text-sm space-y-1">
                    <div className="flex justify-between"><span>Turn Success Rate</span><span className="font-mono text-muted-foreground">25%</span></div>
                    <div className="flex justify-between"><span>Response Latency</span><span className="font-mono text-muted-foreground">25%</span></div>
                    <div className="flex justify-between"><span>Interrupt Latency</span><span className="font-mono text-muted-foreground">15%</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Noise Reduction (coming soon)</span><span className="font-mono text-muted-foreground">15%</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Network Resilience (coming soon)</span><span className="font-mono text-muted-foreground">10%</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Naturalness (coming soon)</span><span className="font-mono text-muted-foreground">10%</span></div>
                  </div>
                  <div className="text-xs text-muted-foreground border-t pt-2 space-y-1">
                    <p>Each metric is normalized to 0-1 using min-max scaling across all entries. Lower-is-better metrics (latencies) are inverted. The composite score is the weighted sum, ranked highest-first.</p>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
          <p className="text-sm sm:text-base text-muted-foreground mt-2">
            Ranked by weighted composite score across 6 performance metrics.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Time range" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="24">24 hours</SelectItem>
              <SelectItem value="168">7 days</SelectItem>
              <SelectItem value="720">30 days</SelectItem>
              <SelectItem value="all">All time</SelectItem>
            </SelectContent>
          </Select>
          <RegionScopeSelector
            locations={regionLocations ?? []}
            value={regionScopes}
            onChange={setRegionScopes}
          />
          <MetricsTagControls
            tagFilters={tagFilters}
            onTagFiltersChange={setTagFilters}
            groupBy={groupBy}
            onGroupByChange={setGroupBy}
            customKeys={customTagKeys(undefined, [...tagFilters.map((t) => t.key), groupBy])}
          />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Performance Rankings</CardTitle>
          <CardDescription>
            {regionLabel} • {timeRangeLabel} - Ranked by composite score (mainline data only)
            {tagFilters.length > 0 && <> • Tagged {tagFilters.map(formatTag).join(", ")}</>}
            {groupBy && <> • Grouped by {groupBy}</>}
            {showAccess && <> • Under each value: last mile / datacenter</>}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filteredAndSortedData.length > 0 ? (
            <Table className="min-w-[800px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[80px]">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 p-0 font-medium hover:bg-transparent"
                      onClick={() => handleSort("rank")}
                    >
                      Rank
                      <SortIcon field="rank" />
                    </Button>
                  </TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Region</TableHead>
                  {showAccess && (
                    <TableHead className="text-right" data-testid="header-access">
                      <span title={`Last mile: ${LAST_MILE_HINT.toLowerCase()}. Datacenter: measured from a server in a datacenter or cloud.`}>
                        Results LM / DC
                      </span>
                    </TableHead>
                  )}
                  {groupBy && <TableHead className="font-mono" data-testid="header-group">{groupBy}</TableHead>}
                  <TableHead className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 p-0 font-medium hover:bg-transparent"
                      onClick={() => handleSort("responseLatency")}
                    >
                      Response (ms)
                      <SortIcon field="responseLatency" />
                    </Button>
                  </TableHead>
                  <TableHead className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 p-0 font-medium hover:bg-transparent"
                      onClick={() => handleSort("interruptLatency")}
                    >
                      Interrupt (ms)
                      <SortIcon field="interruptLatency" />
                    </Button>
                  </TableHead>
                  <TableHead className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 p-0 font-medium hover:bg-transparent"
                      onClick={() => handleSort("turnSuccessRate")}
                      title="Share of turns handled correctly — responded, stopped on interrupt, no false barge-in. No-response turns count as failures."
                    >
                      Turn Success
                      <SortIcon field="turnSuccessRate" />
                    </Button>
                  </TableHead>
                  <TableHead className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 p-0 font-medium hover:bg-transparent"
                      onClick={() => handleSort("networkResilience")}
                    >
                      Network
                      <SortIcon field="networkResilience" />
                    </Button>
                  </TableHead>
                  <TableHead className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 p-0 font-medium hover:bg-transparent"
                      onClick={() => handleSort("naturalness")}
                    >
                      Naturalness
                      <SortIcon field="naturalness" />
                    </Button>
                  </TableHead>
                  <TableHead className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 p-0 font-medium hover:bg-transparent"
                      onClick={() => handleSort("noiseReduction")}
                    >
                      Noise
                      <SortIcon field="noiseReduction" />
                    </Button>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAndSortedData.map((entry) => (
                  <TableRow
                    key={`${entry.provider}-${entry.siteId}-${entry.tagValue ?? ""}`}
                    data-testid={`row-leaderboard-${entry.rank}`}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setSelectedEntry(entry)}
                  >
                    <TableCell className="font-medium font-mono" data-testid={`text-rank-${entry.rank}`}>#{entry.rank}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold" data-testid={`text-provider-${entry.rank}`}>{entry.provider}</span>
                        {entry.rank <= 2 && <Badge variant="secondary" className="text-xs">Top Tier</Badge>}
                        <Info className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-muted-foreground" data-testid={`text-region-${entry.rank}`}>
                        {entry.regionLabel || formatSite(entry.siteId)}
                      </Badge>
                    </TableCell>
                    {showAccess && (
                      <TableCell className="text-right font-mono text-xs" data-testid={`text-access-count-${entry.rank}`}>
                        {entry.lastMile?.count ?? 0} / {entry.datacenter?.count ?? 0}
                      </TableCell>
                    )}
                    {groupBy && (
                      <TableCell data-testid={`text-group-${entry.rank}`}>
                        <Badge variant={isEmptyGroup(groupBy, entry.tagValue) ? "outline" : "secondary"} className="font-mono font-normal">
                          {groupLabel(groupBy, entry.tagValue)}
                        </Badge>
                      </TableCell>
                    )}
                    <TableCell className="text-right font-mono" data-testid={`text-response-${entry.rank}`}>
                      <div>{naNum(entry.responseLatency)}</div>
                      <div className="text-xs text-muted-foreground">P95: {naNum(entry.responseLatencyP95)}</div>
                      {showAccess && <AccessSplit lm={entry.lastMile} dc={entry.datacenter} format={(c) => naNum(c.responseLatency)} testId={`text-response-access-${entry.rank}`} />}
                    </TableCell>
                    <TableCell className="text-right font-mono" data-testid={`text-interrupt-${entry.rank}`}>
                      <div>{naNum(entry.interruptLatency)}</div>
                      <div className="text-xs text-muted-foreground">P95: {naNum(entry.interruptLatencyP95)}</div>
                      {showAccess && <AccessSplit lm={entry.lastMile} dc={entry.datacenter} format={(c) => naNum(c.interruptLatency)} testId={`text-interrupt-access-${entry.rank}`} />}
                    </TableCell>
                    <TableCell className="text-right font-mono" data-testid={`text-turn-success-${entry.rank}`}>
                      <div className="font-semibold">{naPct(entry.turnSuccessRate)}</div>
                      {showAccess && <AccessSplit lm={entry.lastMile} dc={entry.datacenter} format={(c) => naPct(c.turnSuccessRate)} testId={`text-turn-success-access-${entry.rank}`} />}
                    </TableCell>
                    <TableCell className="text-right w-[150px]">
                      <div className="flex items-center justify-end gap-2">
                        <span className="font-mono text-xs" data-testid={`text-network-${entry.rank}`}>{naNum(entry.networkResilience, "%")}</span>
                        {entry.networkResilience != null && <Progress value={entry.networkResilience} className="w-[60px] h-2" />}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono" data-testid={`text-naturalness-${entry.rank}`}>{naNum(entry.naturalness, "/5.0")}</TableCell>
                    <TableCell className="text-right w-[150px]">
                      <div className="flex items-center justify-end gap-2">
                        <span className="font-mono text-xs" data-testid={`text-noise-${entry.rank}`}>{naNum(entry.noiseReduction, "%")}</span>
                        {entry.noiseReduction != null && <Progress value={entry.noiseReduction} className="w-[60px] h-2" />}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No data available for {regionLabel}{tagFilters.length > 0 ? ` tagged ${tagFilters.map(formatTag).join(", ")}` : ""}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <h3 className="font-semibold mb-2">Network Resilience</h3>
            <p className="text-sm text-muted-foreground">Measures the engine's ability to maintain conversation quality during packet loss (up to 40%) and jitter.</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <h3 className="font-semibold mb-2">Naturalness Score</h3>
            <p className="text-sm text-muted-foreground">AI-evaluated score based on turn-taking fluidity, tone consistency, and prosody.</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <h3 className="font-semibold mb-2">Noise Reduction</h3>
            <p className="text-sm text-muted-foreground">Percentage of background noise suppressed without affecting speech clarity.</p>
          </CardContent>
        </Card>
      </div>

      {/* Provider Details Dialog */}
      <Dialog open={!!selectedEntry} onOpenChange={(open) => !open && setSelectedEntry(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedEntry?.provider}
              {selectedEntry && selectedEntry.rank <= 2 && (
                <Badge variant="secondary">Top Tier</Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              Performance metrics for {selectedEntry ? selectedEntry.regionLabel || formatSite(selectedEntry.siteId) : ""} region
              {selectedEntry && groupBy && <> · {groupLabel(groupBy, selectedEntry.tagValue)}</>}
            </DialogDescription>
          </DialogHeader>
          {selectedEntry && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Response Latency</p>
                  <p className="text-2xl font-bold font-mono">{naNum(selectedEntry.responseLatency, "ms")}</p>
                  <p className="text-sm font-mono text-muted-foreground">P95: {naNum(selectedEntry.responseLatencyP95, "ms")}</p>
                  <p className="text-xs text-muted-foreground">Time to first audio byte</p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Interrupt Latency</p>
                  <p className="text-2xl font-bold font-mono">{naNum(selectedEntry.interruptLatency, "ms")}</p>
                  <p className="text-sm font-mono text-muted-foreground">P95: {naNum(selectedEntry.interruptLatencyP95, "ms")}</p>
                  <p className="text-xs text-muted-foreground">Time to stop on interrupt</p>
                </div>
              </div>
              <div className="space-y-3 pt-2 border-t">
                <div className="flex items-center justify-between">
                  <span className="text-sm" title="Share of turns handled correctly — responded, stopped on interrupt, no false barge-in. No-response turns count as failures.">Turn Success Rate</span>
                  <span className="font-mono text-sm font-semibold">{naPct(selectedEntry.turnSuccessRate)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Network Resilience</span>
                  <div className="flex items-center gap-2">
                    {selectedEntry.networkResilience != null && <Progress value={selectedEntry.networkResilience} className="w-24 h-2" />}
                    <span className="font-mono text-sm w-12 text-right">{naNum(selectedEntry.networkResilience, "%")}</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Naturalness</span>
                  <span className="font-mono text-sm">{naNum(selectedEntry.naturalness, "/5.0")}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Noise Reduction</span>
                  <div className="flex items-center gap-2">
                    {selectedEntry.noiseReduction != null && <Progress value={selectedEntry.noiseReduction} className="w-24 h-2" />}
                    <span className="font-mono text-sm w-12 text-right">{naNum(selectedEntry.noiseReduction, "%")}</span>
                  </div>
                </div>
              </div>
              <div className="pt-2 border-t space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Composite Score</span>
                  <span className="font-mono text-sm font-bold">{(selectedEntry.compositeScore * 100).toFixed(1)}%</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Rank #{selectedEntry.rank} in {regionLabel} • Data from {timeRangeLabel.toLowerCase()}
                </p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
