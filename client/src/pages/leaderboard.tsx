import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";

interface LeaderboardEntry {
  rank: number;
  provider: string;
  region: string;
  responseLatency: number;
  interruptLatency: number;
  networkResilience: number;
  naturalness: number;
  noiseReduction: number;
}

type SortField = "rank" | "responseLatency" | "interruptLatency" | "networkResilience" | "naturalness" | "noiseReduction";
type SortDirection = "asc" | "desc";

export default function Leaderboard() {
  const [selectedRegion, setSelectedRegion] = useState<string>("all");
  const [sortField, setSortField] = useState<SortField>("rank");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  const { data: leaderboardData, isLoading } = useQuery<LeaderboardEntry[]>({
    queryKey: ['/api/metrics/leaderboard'],
  });

  const filteredAndSortedData = useMemo(() => {
    if (!leaderboardData) return [];

    // Filter by region
    let filtered = selectedRegion === "all"
      ? leaderboardData
      : leaderboardData.filter(e => e.region.toLowerCase() === selectedRegion);

    // Sort data
    const sorted = [...filtered].sort((a, b) => {
      let comparison = 0;

      switch (sortField) {
        case "rank":
          comparison = a.rank - b.rank;
          break;
        case "responseLatency":
          comparison = a.responseLatency - b.responseLatency;
          break;
        case "interruptLatency":
          comparison = a.interruptLatency - b.interruptLatency;
          break;
        case "networkResilience":
          comparison = b.networkResilience - a.networkResilience; // Higher is better
          break;
        case "naturalness":
          comparison = b.naturalness - a.naturalness; // Higher is better
          break;
        case "noiseReduction":
          comparison = b.noiseReduction - a.noiseReduction; // Higher is better
          break;
      }

      return sortDirection === "asc" ? comparison : -comparison;
    });

    return sorted;
  }, [leaderboardData, selectedRegion, sortField, sortDirection]);

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

  const regionLabel = selectedRegion === "all" ? "All Regions"
    : selectedRegion === "na" ? "North America"
    : selectedRegion === "apac" ? "Asia Pacific"
    : "Europe";

  return (
    <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight" data-testid="text-leaderboard-title">Global Leaderboard</h1>
          <p className="text-sm sm:text-base text-muted-foreground mt-2">
            Comprehensive benchmarks across 5 key performance metrics.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedRegion} onValueChange={setSelectedRegion}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Select region" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Regions</SelectItem>
              <SelectItem value="na">North America</SelectItem>
              <SelectItem value="apac">Asia Pacific</SelectItem>
              <SelectItem value="eu">Europe</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Performance Rankings</CardTitle>
          <CardDescription>
            {regionLabel} - Ranked by weighted average of all metrics (mainline data only)
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
                  <TableRow key={`${entry.provider}-${entry.region}`} data-testid={`row-leaderboard-${entry.rank}`}>
                    <TableCell className="font-medium font-mono" data-testid={`text-rank-${entry.rank}`}>#{entry.rank}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold" data-testid={`text-provider-${entry.rank}`}>{entry.provider}</span>
                        {entry.rank <= 2 && <Badge variant="secondary" className="text-xs">Top Tier</Badge>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-muted-foreground" data-testid={`text-region-${entry.rank}`}>
                        {entry.region}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono" data-testid={`text-response-${entry.rank}`}>{entry.responseLatency}</TableCell>
                    <TableCell className="text-right font-mono" data-testid={`text-interrupt-${entry.rank}`}>{entry.interruptLatency}</TableCell>
                    <TableCell className="text-right w-[150px]">
                      <div className="flex items-center justify-end gap-2">
                        <span className="font-mono text-xs" data-testid={`text-network-${entry.rank}`}>{entry.networkResilience}%</span>
                        <Progress value={entry.networkResilience} className="w-[60px] h-2" />
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono" data-testid={`text-naturalness-${entry.rank}`}>{entry.naturalness}/5.0</TableCell>
                    <TableCell className="text-right w-[150px]">
                      <div className="flex items-center justify-end gap-2">
                        <span className="font-mono text-xs" data-testid={`text-noise-${entry.rank}`}>{entry.noiseReduction}%</span>
                        <Progress value={entry.noiseReduction} className="w-[60px] h-2" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No data available for {regionLabel}
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
    </div>
  );
}
