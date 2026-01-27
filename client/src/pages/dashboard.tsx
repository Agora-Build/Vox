import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Clock, Zap, Activity, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";

interface EvalResult {
  id: number;
  provider: string;
  region: string;
  responseLatency: number;
  interruptLatency: number;
  networkResilience: number;
  naturalness: number;
  noiseReduction: number;
  timestamp: string;
}

interface ConfigData {
  test_interval_hours?: string;
  total_tests_24h?: string;
}

function calculateStats(values: number[]) {
  if (values.length === 0) return { median: 0, stdDev: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  const stdDev = Math.sqrt(avgSquaredDiff);

  return { median: Math.round(median), stdDev: Math.round(stdDev) };
}

export default function Dashboard() {
  const [selectedRegion, setSelectedRegion] = useState<string>("all");
  const [refreshInterval, setRefreshInterval] = useState<number>(30000); // 30 seconds
  const [timeRange, setTimeRange] = useState<string>("24"); // hours

  const { data: metrics, isLoading: metricsLoading, refetch, isFetching } = useQuery<EvalResult[]>({
    queryKey: ['/api/metrics/realtime', timeRange],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (timeRange !== "all") {
        params.set("hours", timeRange);
      }
      params.set("limit", "200");
      const res = await fetch(`/api/metrics/realtime?${params}`);
      if (!res.ok) throw new Error("Failed to fetch metrics");
      return res.json();
    },
    refetchInterval: refreshInterval,
  });

  const { data: config } = useQuery<ConfigData>({
    queryKey: ['/api/config'],
  });

  // Filter metrics by selected region
  const filteredMetrics = metrics?.filter(m =>
    selectedRegion === "all" || m.region.toLowerCase() === selectedRegion
  ) || [];

  const combinedData = (() => {
    if (!filteredMetrics || filteredMetrics.length === 0) return [];

    const timeGroups = new Map<string, { agora: EvalResult | null; liveKit: EvalResult | null }>();

    for (const m of filteredMetrics) {
      const timeKey = format(new Date(m.timestamp), "HH:mm");
      if (!timeGroups.has(timeKey)) {
        timeGroups.set(timeKey, { agora: null, liveKit: null });
      }
      const group = timeGroups.get(timeKey)!;
      if (m.provider === "Agora ConvoAI" && !group.agora) {
        group.agora = m;
      } else if (m.provider === "LiveKIT Agent" && !group.liveKit) {
        group.liveKit = m;
      }
    }

    return Array.from(timeGroups.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([timestamp, group]) => ({
        timestamp,
        agoraResponse: group.agora?.responseLatency,
        agoraInterrupt: group.agora?.interruptLatency,
        liveKitResponse: group.liveKit?.responseLatency,
        liveKitInterrupt: group.liveKit?.interruptLatency,
      }));
  })();

  const responseStats = calculateStats(filteredMetrics?.map(m => m.responseLatency) || []);
  const interruptStats = calculateStats(filteredMetrics?.map(m => m.interruptLatency) || []);
  const totalTests = config?.total_tests_24h || "0";
  const testInterval = config?.test_interval_hours || "8";

  const latestTestTime = metrics && metrics.length > 0
    ? Math.round((Date.now() - new Date(metrics[0].timestamp).getTime()) / 60000)
    : 0;

  const regionLabel = selectedRegion === "all" ? "All Regions"
    : selectedRegion === "na" ? "North America"
    : selectedRegion === "apac" ? "Asia Pacific"
    : "Europe";

  const timeRangeLabel = timeRange === "1" ? "Last hour"
    : timeRange === "6" ? "Last 6 hours"
    : timeRange === "24" ? "Last 24 hours"
    : timeRange === "168" ? "Last 7 days"
    : "All time";

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight" data-testid="text-dashboard-title">Real-time</h1>
          <p className="text-xs sm:text-sm text-muted-foreground flex flex-wrap items-center gap-2">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
            </span>
            <span data-testid="text-system-status">System Status: Operational</span>
            <span className="hidden sm:inline">|</span>
            <span data-testid="text-update-interval">Updates every {testInterval} hours</span>
            <span className="hidden sm:inline">|</span>
            <span data-testid="text-latest-test">Latest: {latestTestTime}m ago</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger className="w-[100px]">
              <SelectValue placeholder="Time" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1 hour</SelectItem>
              <SelectItem value="6">6 hours</SelectItem>
              <SelectItem value="24">24 hours</SelectItem>
              <SelectItem value="168">7 days</SelectItem>
              <SelectItem value="all">All time</SelectItem>
            </SelectContent>
          </Select>
          <Select value={selectedRegion} onValueChange={setSelectedRegion}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Region" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Regions</SelectItem>
              <SelectItem value="na">North America</SelectItem>
              <SelectItem value="apac">Asia Pacific</SelectItem>
              <SelectItem value="eu">Europe</SelectItem>
            </SelectContent>
          </Select>
          <Select value={refreshInterval.toString()} onValueChange={(v) => setRefreshInterval(parseInt(v))}>
            <SelectTrigger className="w-[100px]">
              <SelectValue placeholder="Refresh" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="10000">10s</SelectItem>
              <SelectItem value="30000">30s</SelectItem>
              <SelectItem value="60000">1m</SelectItem>
              <SelectItem value="300000">5m</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Response Latency</CardTitle>
            <div className="flex items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Clock className="h-4 w-4 text-muted-foreground cursor-pointer hover:text-foreground transition-colors" />
                </PopoverTrigger>
                <PopoverContent className="w-80">
                  <div className="space-y-2">
                    <h4 className="font-medium leading-none">Latency Metrics</h4>
                    <p className="text-sm text-muted-foreground">
                      <strong>Response Latency:</strong> Time from user speech end to first audio packet received.
                    </p>
                    <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
                      <p><strong>MED (Median):</strong> The middle value separating the higher half from the lower half of data samples.</p>
                      <p><strong>SD (Standard Deviation):</strong> A measure of the amount of variation or dispersion of the latency values.</p>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </CardHeader>
          <CardContent className="space-y-1">
            {metricsLoading ? (
              <>
                <Skeleton className="h-8 w-24" />
                <Skeleton className="h-6 w-16" />
              </>
            ) : (
              <>
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-muted-foreground font-mono">MED</span>
                  <span className="text-2xl font-bold font-mono" data-testid="text-response-median">{responseStats.median.toLocaleString()}ms</span>
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-muted-foreground font-mono">SD</span>
                  <span className="text-lg font-mono text-muted-foreground" data-testid="text-response-stddev">{responseStats.stdDev}ms</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Interrupt Latency</CardTitle>
            <div className="flex items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Zap className="h-4 w-4 text-muted-foreground cursor-pointer hover:text-foreground transition-colors" />
                </PopoverTrigger>
                <PopoverContent className="w-80">
                  <div className="space-y-2">
                    <h4 className="font-medium leading-none">Latency Metrics</h4>
                    <p className="text-sm text-muted-foreground">
                      <strong>Interrupt Latency:</strong> Time to stop generation after user speech.
                    </p>
                    <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
                      <p><strong>MED (Median):</strong> The middle value separating the higher half from the lower half of data samples.</p>
                      <p><strong>SD (Standard Deviation):</strong> A measure of the amount of variation or dispersion of the latency values.</p>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </CardHeader>
          <CardContent className="space-y-1">
            {metricsLoading ? (
              <>
                <Skeleton className="h-8 w-24" />
                <Skeleton className="h-6 w-16" />
              </>
            ) : (
              <>
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-muted-foreground font-mono">MED</span>
                  <span className="text-2xl font-bold font-mono" data-testid="text-interrupt-median">{interruptStats.median.toLocaleString()}ms</span>
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-muted-foreground font-mono">SD</span>
                  <span className="text-lg font-mono text-muted-foreground" data-testid="text-interrupt-stddev">{interruptStats.stdDev}ms</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Data Points</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {metricsLoading ? (
              <Skeleton className="h-8 w-20 mt-2" />
            ) : (
              <div className="text-2xl font-bold font-mono mt-2" data-testid="text-total-tests">{filteredMetrics.length.toLocaleString()}</div>
            )}
            <p className="text-xs text-muted-foreground">{timeRangeLabel}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Region Filter</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold mt-2">{regionLabel}</div>
            <p className="text-xs text-muted-foreground">{filteredMetrics.length} data points</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Response Latency (ms)</CardTitle>
            <CardDescription>Time to First Audio (TTFA) - {regionLabel}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              {metricsLoading ? (
                <Skeleton className="h-full w-full" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={combinedData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis
                      dataKey="timestamp"
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(value) => `${value}ms`}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                      itemStyle={{ color: 'hsl(var(--popover-foreground))' }}
                    />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="agoraResponse"
                      name="Agora ConvoAI"
                      stroke="hsl(var(--chart-1))"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 6 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="liveKitResponse"
                      name="LiveKIT Agent"
                      stroke="hsl(var(--chart-2))"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 6 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Interrupt Latency (ms)</CardTitle>
            <CardDescription>Time to Interrupt (TTI) - {regionLabel}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              {metricsLoading ? (
                <Skeleton className="h-full w-full" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={combinedData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis
                      dataKey="timestamp"
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(value) => `${value}ms`}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                      itemStyle={{ color: 'hsl(var(--popover-foreground))' }}
                    />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="agoraInterrupt"
                      name="Agora ConvoAI"
                      stroke="hsl(var(--chart-1))"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 6 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="liveKitInterrupt"
                      name="LiveKIT Agent"
                      stroke="hsl(var(--chart-2))"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 6 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
