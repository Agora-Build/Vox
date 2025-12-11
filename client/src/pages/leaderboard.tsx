import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { leaderboardData } from "@/lib/mockData";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";

export default function Leaderboard() {
  return (
    <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Global Leaderboard</h1>
        <p className="text-muted-foreground mt-2">Comprehensive benchmarks across 5 key performance metrics.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Performance Rankings</CardTitle>
          <CardDescription>Ranked by weighted average of all metrics</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
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
              {leaderboardData.map((entry) => (
                <TableRow key={`${entry.provider}-${entry.region}`}>
                  <TableCell className="font-medium font-mono">#{entry.rank}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{entry.provider}</span>
                      {entry.rank <= 2 && <Badge variant="secondary" className="text-xs">Top Tier</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{entry.region}</TableCell>
                  <TableCell className="text-right font-mono">{entry.responseLatency}</TableCell>
                  <TableCell className="text-right font-mono">{entry.interruptLatency}</TableCell>
                  <TableCell className="text-right w-[150px]">
                    <div className="flex items-center justify-end gap-2">
                      <span className="font-mono text-xs">{entry.networkResilience}%</span>
                      <Progress value={entry.networkResilience} className="w-[60px] h-2" />
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono">{entry.naturalness}/5.0</TableCell>
                  <TableCell className="text-right w-[150px]">
                    <div className="flex items-center justify-end gap-2">
                      <span className="font-mono text-xs">{entry.noiseReduction}%</span>
                      <Progress value={entry.noiseReduction} className="w-[60px] h-2" />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <div className="bg-card p-6 rounded-lg border border-border">
          <h3 className="font-semibold mb-2">Network Resilience</h3>
          <p className="text-sm text-muted-foreground">Measures the engine's ability to maintain conversation quality during packet loss (up to 40%) and jitter.</p>
        </div>
        <div className="bg-card p-6 rounded-lg border border-border">
          <h3 className="font-semibold mb-2">Naturalness Score</h3>
          <p className="text-sm text-muted-foreground">AI-evaluated score based on turn-taking fluidity, tone consistency, and prosody.</p>
        </div>
        <div className="bg-card p-6 rounded-lg border border-border">
          <h3 className="font-semibold mb-2">Noise Reduction</h3>
          <p className="text-sm text-muted-foreground">Percentage of background noise suppressed without affecting speech clarity.</p>
        </div>
      </div>
    </div>
  );
}
