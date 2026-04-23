import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Clock, Activity, RefreshCw, Lock } from "lucide-react";
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
  responseLatencySd: number;
  responseLatencyP95: number;
  interruptLatency: number;
  interruptLatencySd: number;
  interruptLatencyP95: number;
  networkResilience: number;
  naturalness: number;
  noiseReduction: number;
  timestamp: string;
}

interface AuthStatus {
  initialized: boolean;
  user: {
    id: string;
    username: string;
    plan: string;
    isAdmin: boolean;
  } | null;
}

interface ConfigData {
  test_interval_hours?: string;
  total_tests_24h?: string;
}

interface HealthData {
  status: "operational" | "degraded" | "down";
  agents: { total: number; online: number; offline: number };
}



function buildCombinedData(filteredMetrics: EvalResult[]) {
  if (!filteredMetrics || filteredMetrics.length === 0) return [];

  const timeGroups = new Map<string, { agora: EvalResult | null; liveKit: EvalResult | null }>();

  for (const m of filteredMetrics) {
    const date = new Date(m.timestamp);
    if (isNaN(date.getTime())) continue;
    const timeKey = format(date, "MM/dd HH:mm");
    if (!timeGroups.has(timeKey)) {
      timeGroups.set(timeKey, { agora: null, liveKit: null });
    }
    const group = timeGroups.get(timeKey)!;
    const providerLower = m.provider.toLowerCase();
    if (providerLower.includes("agora") && !group.agora) {
      group.agora = m;
    } else if (providerLower.includes("livekit") && !group.liveKit) {
      group.liveKit = m;
    }
  }

  const sorted = Array.from(timeGroups.entries())
    .sort((a, b) => a[0].localeCompare(b[0]));

  const GAP_MS = 60 * 60 * 1000; // 1 hour
  const result: Array<{
    timestamp: string;
    agoraResponse?: number;
    agoraInterrupt?: number;
    liveKitResponse?: number;
    liveKitInterrupt?: number;
  }> = [];

  for (let i = 0; i < sorted.length; i++) {
    const [timestamp, group] = sorted[i];

    // Insert a null-gap marker if consecutive points are more than 1 hour apart
    if (i > 0) {
      const prev = new Date(sorted[i - 1][0]).getTime();
      const curr = new Date(timestamp).getTime();
      if (!isNaN(prev) && !isNaN(curr) && curr - prev > GAP_MS) {
        result.push({ timestamp: "" });
      }
    }

    result.push({
      timestamp,
      agoraResponse: group.agora?.responseLatency,
      agoraInterrupt: group.agora?.interruptLatency,
      liveKitResponse: group.liveKit?.responseLatency,
      liveKitInterrupt: group.liveKit?.interruptLatency,
    });
  }

  return result;
}

interface MetricsSectionProps {
  metrics: EvalResult[] | undefined;
  isLoading: boolean;
  selectedRegion: string;
  timeRangeLabel: string;
  regionLabel: string;
  testIdPrefix?: string;
}

function MetricsSection({ metrics, isLoading, selectedRegion, timeRangeLabel, regionLabel, testIdPrefix = "" }: MetricsSectionProps) {
  const filteredMetrics = metrics?.filter(m =>
    selectedRegion === "all" || m.region.toLowerCase() === selectedRegion
  ) || [];

  const combinedData = buildCombinedData(filteredMetrics);

  // Show latest single test result (metrics are ordered by createdAt DESC)
  const latest = filteredMetrics[0] ?? null;

  return (
    <>
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
                      <p><strong>P95 (95th Percentile):</strong> 95% of latency samples fall below this value.</p>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </CardHeader>
          <CardContent className="space-y-1">
            {isLoading ? (
              <>
                <Skeleton className="h-8 w-24" />
                <Skeleton className="h-6 w-16" />
                <Skeleton className="h-6 w-16" />
              </>
            ) : (
              <>
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-muted-foreground font-mono">MED</span>
                  <span className="text-2xl font-bold font-mono" data-testid={`${testIdPrefix}text-response-median`}>{(latest?.responseLatency ?? 0).toLocaleString()}ms</span>
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-muted-foreground font-mono">SD</span>
                  <span className="text-lg font-mono text-muted-foreground" data-testid={`${testIdPrefix}text-response-stddev`}>{Math.round(latest?.responseLatencySd ?? 0)}ms</span>
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-muted-foreground font-mono">P95</span>
                  <span className="text-lg font-mono text-muted-foreground" data-testid={`${testIdPrefix}text-response-p95`}>{(latest?.responseLatencyP95 ?? 0).toLocaleString()}ms</span>
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
                  <Clock className="h-4 w-4 text-muted-foreground cursor-pointer hover:text-foreground transition-colors" />
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
                      <p><strong>P95 (95th Percentile):</strong> 95% of latency samples fall below this value.</p>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </CardHeader>
          <CardContent className="space-y-1">
            {isLoading ? (
              <>
                <Skeleton className="h-8 w-24" />
                <Skeleton className="h-6 w-16" />
                <Skeleton className="h-6 w-16" />
              </>
            ) : (
              <>
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-muted-foreground font-mono">MED</span>
                  <span className="text-2xl font-bold font-mono" data-testid={`${testIdPrefix}text-interrupt-median`}>{(latest?.interruptLatency ?? 0).toLocaleString()}ms</span>
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-muted-foreground font-mono">SD</span>
                  <span className="text-lg font-mono text-muted-foreground" data-testid={`${testIdPrefix}text-interrupt-stddev`}>{Math.round(latest?.interruptLatencySd ?? 0)}ms</span>
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-muted-foreground font-mono">P95</span>
                  <span className="text-lg font-mono text-muted-foreground" data-testid={`${testIdPrefix}text-interrupt-p95`}>{(latest?.interruptLatencyP95 ?? 0).toLocaleString()}ms</span>
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
            {isLoading ? (
              <Skeleton className="h-8 w-20 mt-2" />
            ) : (
              <div className="text-2xl font-bold font-mono mt-2" data-testid={`${testIdPrefix}text-total-tests`}>{filteredMetrics.length.toLocaleString()}</div>
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
              {isLoading ? (
                <Skeleton className="h-full w-full" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={combinedData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="timestamp" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => `${value}ms`} />
                    <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }} itemStyle={{ color: 'hsl(var(--popover-foreground))' }} />
                    <Legend />
                    <Line type="monotone" dataKey="agoraResponse" name="Agora ConvoAI Engine" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 6 }} />
                    <Line type="monotone" dataKey="liveKitResponse" name="LiveKit Agents" stroke="hsl(var(--chart-2))" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 6 }} />
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
              {isLoading ? (
                <Skeleton className="h-full w-full" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={combinedData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="timestamp" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => `${value}ms`} />
                    <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }} itemStyle={{ color: 'hsl(var(--popover-foreground))' }} />
                    <Legend />
                    <Line type="monotone" dataKey="agoraInterrupt" name="Agora ConvoAI Engine" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 6 }} />
                    <Line type="monotone" dataKey="liveKitInterrupt" name="LiveKit Agents" stroke="hsl(var(--chart-2))" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 6 }} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export default function Dashboard() {
  const [selectedRegion, setSelectedRegion] = useState<string>("all");
  const [refreshInterval, setRefreshInterval] = useState<number>(30000);
  const [timeRange, setTimeRange] = useState<string>("24");
  const initialTab = new URLSearchParams(window.location.search).get("tab");
  const [activeTab, setActiveTab] = useState<string>(
    initialTab && ["mainline", "community", "my-evals"].includes(initialTab) ? initialTab : "mainline"
  );

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const isLoggedIn = !!authStatus?.user;

  const { data: mainlineMetrics, isLoading: mainlineLoading, refetch: refetchMainline, isFetching: mainlineFetching } = useQuery<EvalResult[]>({
    queryKey: ['/api/metrics/realtime', timeRange],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (timeRange !== "all") params.set("hours", timeRange);
      params.set("limit", timeRange === "all" ? "500" : "200");
      const res = await fetch(`/api/metrics/realtime?${params}`);
      if (!res.ok) throw new Error("Failed to fetch metrics");
      return res.json();
    },
    refetchInterval: refreshInterval,
    enabled: activeTab === "mainline",
  });

  const { data: communityMetrics, isLoading: communityLoading, refetch: refetchCommunity, isFetching: communityFetching } = useQuery<EvalResult[]>({
    queryKey: ['/api/metrics/community', timeRange],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (timeRange !== "all") params.set("hours", timeRange);
      params.set("limit", timeRange === "all" ? "500" : "200");
      const res = await fetch(`/api/metrics/community?${params}`);
      if (!res.ok) throw new Error("Failed to fetch community metrics");
      return res.json();
    },
    refetchInterval: refreshInterval,
    enabled: activeTab === "community",
  });

  const { data: myEvalsMetrics, isLoading: myEvalsLoading, refetch: refetchMyEvals, isFetching: myEvalsFetching } = useQuery<EvalResult[]>({
    queryKey: ['/api/metrics/my-evals', timeRange],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (timeRange !== "all") params.set("hours", timeRange);
      params.set("limit", timeRange === "all" ? "500" : "200");
      const res = await fetch(`/api/metrics/my-evals?${params}`);
      if (!res.ok) throw new Error("Failed to fetch my eval metrics");
      return res.json();
    },
    refetchInterval: refreshInterval,
    enabled: activeTab === "my-evals" && isLoggedIn,
  });

  const { data: config } = useQuery<ConfigData>({
    queryKey: ['/api/config'],
  });

  const { data: health } = useQuery<HealthData>({
    queryKey: ['/api/health'],
    refetchInterval: 30000,
  });

  const testInterval = config?.test_interval_hours || "8";

  const currentMetrics = activeTab === "mainline" ? mainlineMetrics
    : activeTab === "community" ? communityMetrics
    : myEvalsMetrics;

  const isFetching = activeTab === "mainline" ? mainlineFetching
    : activeTab === "community" ? communityFetching
    : myEvalsFetching;

  const refetch = activeTab === "mainline" ? refetchMainline
    : activeTab === "community" ? refetchCommunity
    : refetchMyEvals;

  const latestTestTime = (() => {
    if (!currentMetrics || currentMetrics.length === 0) return 0;
    const date = new Date(currentMetrics[0].timestamp);
    if (isNaN(date.getTime())) return 0;
    return Math.round((Date.now() - date.getTime()) / 60000);
  })();

  const regionLabel = selectedRegion === "all" ? "All Regions"
    : selectedRegion === "na" ? "North America"
    : selectedRegion === "apac" ? "Asia Pacific"
    : selectedRegion === "sa" ? "South America"
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
              {health?.status === "operational" ? (
                <>
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                </>
              ) : health?.status === "degraded" ? (
                <span className="relative inline-flex rounded-full h-2 w-2 bg-yellow-500"></span>
              ) : health?.status === "down" ? (
                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
              ) : (
                <span className="relative inline-flex rounded-full h-2 w-2 bg-gray-400"></span>
              )}
            </span>
            <span data-testid="text-system-status">
              {health?.status === "operational" ? "System Status: Operational"
                : health?.status === "degraded" ? "System Status: Degraded"
                : health?.status === "down" ? "System Status: Down"
                : "System Status: Checking..."}
              {health?.agents && ` (${health.agents.online}/${health.agents.total} agents online)`}
            </span>
            <span className="text-muted-foreground/50">|</span>
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
              <SelectItem value="sa">South America</SelectItem>
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

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="mainline">Mainline</TabsTrigger>
          <TabsTrigger value="community">Community</TabsTrigger>
          <TabsTrigger value="my-evals" className="gap-1">
            <Lock className="h-3 w-3" />
            My Evals
          </TabsTrigger>
        </TabsList>

        <TabsContent value="mainline" className="space-y-4 mt-4">
          <MetricsSection
            metrics={mainlineMetrics}
            isLoading={mainlineLoading}
            selectedRegion={selectedRegion}
            timeRangeLabel={timeRangeLabel}
            regionLabel={regionLabel}
            testIdPrefix=""
          />
        </TabsContent>

        <TabsContent value="community" className="space-y-4 mt-4">
          <MetricsSection
            metrics={communityMetrics}
            isLoading={communityLoading}
            selectedRegion={selectedRegion}
            timeRangeLabel={timeRangeLabel}
            regionLabel={regionLabel}
            testIdPrefix="community-"
          />
        </TabsContent>

        <TabsContent value="my-evals" className="space-y-4 mt-4">
          {isLoggedIn ? (
            <MetricsSection
              metrics={myEvalsMetrics}
              isLoading={myEvalsLoading}
              selectedRegion={selectedRegion}
              timeRangeLabel={timeRangeLabel}
              regionLabel={regionLabel}
              testIdPrefix="my-evals-"
            />
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <Lock className="h-8 w-8 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">Sign in required</h3>
                <p className="text-sm text-muted-foreground max-w-md">
                  Sign in to view your private evaluation results. Results from private workflows or eval sets you own will appear here.
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
