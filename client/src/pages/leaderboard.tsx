import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";

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

export default function Leaderboard() {
  const { data: leaderboardData, isLoading } = useQuery<LeaderboardEntry[]>({
    queryKey: ['/api/metrics/leaderboard'],
  });

  return (
    <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight" data-testid="text-leaderboard-title">Global Leaderboard</h1>
        <p className="text-sm sm:text-base text-muted-foreground mt-2">Comprehensive benchmarks across 5 key performance metrics.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Performance Rankings</CardTitle>
          <CardDescription>Ranked by weighted average of all metrics</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <Table className="min-w-[800px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[80px]">Rank</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead className="text-right">Response (ms)</TableHead>
                  <TableHead className="text-right">Interrupt (ms)</TableHead>
                  <TableHead className="text-right">Network Resilience</TableHead>
                  <TableHead className="text-right">Naturalness</TableHead>
                  <TableHead className="text-right">Noise Reduction</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leaderboardData?.map((entry) => (
                  <TableRow key={`${entry.provider}-${entry.region}`} data-testid={`row-leaderboard-${entry.rank}`}>
                    <TableCell className="font-medium font-mono" data-testid={`text-rank-${entry.rank}`}>#{entry.rank}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold" data-testid={`text-provider-${entry.rank}`}>{entry.provider}</span>
                        {entry.rank <= 2 && <Badge variant="secondary" className="text-xs">Top Tier</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground" data-testid={`text-region-${entry.rank}`}>{entry.region}</TableCell>
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
