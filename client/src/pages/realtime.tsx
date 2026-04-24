import { useState, useMemo, useRef, useCallback, useEffect } from "react";
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
  providerId: string;
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



interface CombinedRow {
  timestamp: string;
  rawTime: number;
  [key: string]: string | number | undefined;
}

// Curated palette — easy on the eyes, distinct from each other
const PALETTE = [
  "#3b82f6", // blue
  "#f97316", // orange
  "#22c55e", // green
  "#a855f7", // purple (softer)
  "#ef4444", // red
];

// Hash providerId to a stable palette index
function providerColor(providerId: string): string {
  let hash = 0;
  for (let i = 0; i < providerId.length; i++) {
    hash = ((hash << 5) - hash + providerId.charCodeAt(i)) | 0;
  }
  return PALETTE[((hash % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

/** Convert provider name to a safe key prefix: "Agora ConvoAI Engine" → "agora_convoai_engine" */
function providerKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

interface ChartProviders {
  data: CombinedRow[];
  providers: Array<{ key: string; name: string; stroke: string }>;
}

function buildCombinedData(filteredMetrics: EvalResult[]): ChartProviders {
  if (!filteredMetrics || filteredMetrics.length === 0) return { data: [], providers: [] };

  // Discover providers — keyed by providerId for stable color
  const providerInfo = new Map<string, { id: string; name: string }>();
  for (const m of filteredMetrics) {
    if (!providerInfo.has(m.providerId)) {
      providerInfo.set(m.providerId, { id: m.providerId, name: m.provider });
    }
  }

  const providers = Array.from(providerInfo.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ id, name }) => ({
      key: providerKey(name),
      name,
      stroke: providerColor(id),
    }));

  const nameToKey = new Map(providers.map(p => [p.name, p.key]));

  // Group by timestamp, one slot per provider
  const timeGroups = new Map<string, { rawTime: number; values: Map<string, EvalResult> }>();

  for (const m of filteredMetrics) {
    const date = new Date(m.timestamp);
    if (isNaN(date.getTime())) continue;
    const timeKey = format(date, "MM/dd HH:mm");
    if (!timeGroups.has(timeKey)) {
      timeGroups.set(timeKey, { rawTime: date.getTime(), values: new Map() });
    }
    const group = timeGroups.get(timeKey)!;
    const pk = nameToKey.get(m.provider);
    if (pk && !group.values.has(pk)) {
      group.values.set(pk, m);
    }
  }

  const data = Array.from(timeGroups.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([timestamp, group]) => {
      const row: CombinedRow = { timestamp, rawTime: group.rawTime };
      for (const p of providers) {
        const m = group.values.get(p.key);
        row[`${p.key}_response`] = m?.responseLatency;
        row[`${p.key}_interrupt`] = m?.interruptLatency;
      }
      return row;
    });

  return { data, providers };
}

const GAP_MS = 2 * 60 * 60 * 1000; // 2 hours

interface SegmentLineInfo {
  segKey: string;
  name: string;
  stroke: string;
  showLegend: boolean;
  /** Indices of data points that have values in this segment */
  dataIndices: number[];
}

/**
 * Pre-compute segmented data: splits each provider's series at 2h gaps.
 * Returns a new data array with segment keys baked in, plus line descriptors.
 */
function buildSegmentedData(
  data: CombinedRow[],
  providers: Array<{ dataKey: string; name: string; stroke: string }>,
): { rows: CombinedRow[]; lines: SegmentLineInfo[] } {
  // Deep-copy rows so we don't mutate the original
  const rows = data.map(r => ({ ...r }));
  const lines: SegmentLineInfo[] = [];

  for (const { dataKey, name, stroke } of providers) {
    // Find segments: groups of consecutive points within GAP_MS
    const segments: Array<{ start: number; end: number }> = [];
    let segStart = -1;
    let lastIdx = -1;

    for (let i = 0; i < rows.length; i++) {
      if (rows[i][dataKey] != null) {
        if (segStart === -1) {
          segStart = i;
        } else if (lastIdx >= 0 && rows[i].rawTime - rows[lastIdx].rawTime > GAP_MS) {
          segments.push({ start: segStart, end: lastIdx });
          segStart = i;
        }
        lastIdx = i;
      }
    }
    if (segStart >= 0 && lastIdx >= 0) {
      segments.push({ start: segStart, end: lastIdx });
    }

    // Bake segment keys into rows
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      const segKey = `${dataKey}_s${si}`;
      const dataIndices: number[] = [];
      for (let i = 0; i < rows.length; i++) {
        const val = (i >= seg.start && i <= seg.end) ? rows[i][dataKey] : undefined;
        rows[i][segKey] = val;
        if (val != null) dataIndices.push(i);
      }
      lines.push({ segKey, name, stroke, showLegend: si === 0, dataIndices });
    }
  }

  return { rows, lines };
}

const DEFAULT_WINDOW = 100;
const MIN_WINDOW = 10;

function useChartZoom(totalLength: number) {
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);

  // Default: show last DEFAULT_WINDOW points
  const start = range?.start ?? Math.max(0, totalLength - DEFAULT_WINDOW);
  const end = range?.end ?? totalLength;
  const windowSize = end - start;
  const isShowingAll = start === 0 && end >= totalLength;

  const zoom = useCallback((delta: number, anchorRatio: number) => {
    setRange(prev => {
      const s = prev?.start ?? Math.max(0, totalLength - DEFAULT_WINDOW);
      const e = prev?.end ?? totalLength;
      const ws = e - s;

      // delta > 0 = zoom out, delta < 0 = zoom in
      const factor = delta > 0 ? 1.2 : 0.8;
      let newWs = Math.round(ws * factor);
      newWs = Math.max(MIN_WINDOW, Math.min(totalLength, newWs));

      const anchor = s + ws * anchorRatio;
      let newStart = Math.round(anchor - newWs * anchorRatio);
      let newEnd = newStart + newWs;

      if (newStart < 0) { newStart = 0; newEnd = newWs; }
      if (newEnd > totalLength) { newEnd = totalLength; newStart = Math.max(0, newEnd - newWs); }

      return { start: newStart, end: newEnd };
    });
  }, [totalLength]);

  const pan = useCallback((deltaPoints: number) => {
    setRange(prev => {
      const s = prev?.start ?? Math.max(0, totalLength - DEFAULT_WINDOW);
      const e = prev?.end ?? totalLength;
      const ws = e - s;

      let newStart = s + deltaPoints;
      let newEnd = e + deltaPoints;

      if (newStart < 0) { newStart = 0; newEnd = ws; }
      if (newEnd > totalLength) { newEnd = totalLength; newStart = Math.max(0, newEnd - ws); }

      return { start: newStart, end: newEnd };
    });
  }, [totalLength]);

  // Reset when data changes significantly (e.g., new time range selected)
  const prevLenRef = useRef(totalLength);
  if (Math.abs(totalLength - prevLenRef.current) > 5) {
    prevLenRef.current = totalLength;
    if (range) setRange(null); // reset to default
  }
  prevLenRef.current = totalLength;

  return { start, end, windowSize, isShowingAll, zoom, pan };
}

function ZoomableChart({ children, totalLength, zoomState }: {
  children: React.ReactNode;
  totalLength: number;
  zoomState: ReturnType<typeof useChartZoom>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; isDragging: boolean }>({ startX: 0, startY: 0, isDragging: false });
  const pinchRef = useRef<{ dist: number } | null>(null);

  const getTouchDist = (touches: React.TouchList) => {
    if (touches.length < 2) return 0;
    const dx = touches[1].clientX - touches[0].clientX;
    const dy = touches[1].clientY - touches[0].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const getAnchorRatio = (clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return 0.5;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  // Attach wheel listener as non-passive so preventDefault() works
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const anchor = getAnchorRatio(e.clientX);
      zoomState.zoom(e.deltaY, anchor);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomState]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "touch") return; // handled by touch events
    dragRef.current = { startX: e.clientX, startY: e.clientY, isDragging: false };
    containerRef.current?.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "touch") return;
    if (!dragRef.current.startX && !dragRef.current.isDragging) return;
    const dx = e.clientX - dragRef.current.startX;
    if (Math.abs(dx) > 3) dragRef.current.isDragging = true;
    if (!dragRef.current.isDragging) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pointsPerPx = zoomState.windowSize / rect.width;
    const deltaPoints = Math.round(-dx * pointsPerPx);
    if (deltaPoints !== 0) {
      zoomState.pan(deltaPoints);
      dragRef.current.startX = e.clientX;
    }
  }, [zoomState]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "touch") return;
    dragRef.current = { startX: 0, startY: 0, isDragging: false };
  }, []);

  // Touch: single-finger drag = pan, two-finger pinch = zoom
  const touchStartRef = useRef<{ x: number } | null>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      pinchRef.current = { dist: getTouchDist(e.touches) };
    } else if (e.touches.length === 1) {
      touchStartRef.current = { x: e.touches[0].clientX };
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchRef.current) {
      e.preventDefault();
      const newDist = getTouchDist(e.touches);
      const delta = pinchRef.current.dist - newDist; // pinch in = zoom in (negative delta)
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const anchor = getAnchorRatio(midX);
      if (Math.abs(delta) > 5) {
        zoomState.zoom(delta, anchor);
        pinchRef.current.dist = newDist;
      }
    } else if (e.touches.length === 1 && touchStartRef.current) {
      const dx = e.touches[0].clientX - touchStartRef.current.x;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pointsPerPx = zoomState.windowSize / rect.width;
      const deltaPoints = Math.round(-dx * pointsPerPx);
      if (deltaPoints !== 0) {
        zoomState.pan(deltaPoints);
        touchStartRef.current.x = e.touches[0].clientX;
      }
    }
  }, [zoomState]);

  const handleTouchEnd = useCallback(() => {
    pinchRef.current = null;
    touchStartRef.current = null;
  }, []);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        style={{ touchAction: "none", cursor: "grab", userSelect: "none" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {children}
      </div>
      {zoomState.isShowingAll && totalLength > 0 && (
        <div className="text-center text-xs text-muted-foreground mt-1">
          Showing all {totalLength} data points
        </div>
      )}
      {!zoomState.isShowingAll && totalLength > 0 && (
        <div className="text-center text-xs text-muted-foreground mt-1">
          {zoomState.windowSize} of {totalLength} points — scroll to zoom, drag to pan
        </div>
      )}
    </div>
  );
}

/** Render dot only at start/end of segment or isolated single points */
function makeEndpointDot(dataIndices: number[], stroke: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (props: any) => {
    const { cx, cy, index } = props;
    if (cx == null || cy == null) return <g />;
    const first = dataIndices[0];
    const last = dataIndices[dataIndices.length - 1];
    const isSingle = dataIndices.length === 1;
    const isEndpoint = index === first || index === last;
    if (!isEndpoint && !isSingle) return <g />;
    return (
      <g>
        <circle cx={cx} cy={cy} r={6} fill={stroke} opacity={0.3} />
        <circle cx={cx} cy={cy} r={4} fill={stroke} />
        <circle cx={cx} cy={cy} r={2} fill="white" />
      </g>
    );
  };
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

  const { data: combinedData, providers } = useMemo(() => buildCombinedData(filteredMetrics), [filteredMetrics]);

  // Show latest single test result (metrics are ordered by createdAt DESC)
  const latest = filteredMetrics[0] ?? null;

  // Zoom/pan state — shared across both charts so they stay in sync
  const chartZoom = useChartZoom(combinedData.length);
  const visibleData = useMemo(() => combinedData.slice(chartZoom.start, chartZoom.end), [combinedData, chartZoom.start, chartZoom.end]);

  // Pre-compute segmented chart data (breaks lines at 2h gaps)
  const responseProviders = useMemo(() => providers.map(p => ({ dataKey: `${p.key}_response`, name: p.name, stroke: p.stroke })), [providers]);
  const interruptProviders = useMemo(() => providers.map(p => ({ dataKey: `${p.key}_interrupt`, name: p.name, stroke: p.stroke })), [providers]);

  const responseChart = useMemo(() => buildSegmentedData(visibleData, responseProviders), [visibleData, responseProviders]);
  const interruptChart = useMemo(() => buildSegmentedData(visibleData, interruptProviders), [visibleData, interruptProviders]);

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
            <ZoomableChart totalLength={combinedData.length} zoomState={chartZoom}>
              <div className="h-[300px] w-full">
                {isLoading ? (
                  <Skeleton className="h-full w-full" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={responseChart.rows}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis dataKey="timestamp" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => `${value}ms`} />
                      <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }} itemStyle={{ color: 'hsl(var(--popover-foreground))' }} />
                      <Legend />
                      {responseChart.lines.map(l => (
                        <Line key={l.segKey} type="monotone" dataKey={l.segKey} name={l.name} stroke={l.stroke} strokeWidth={2} dot={makeEndpointDot(l.dataIndices, l.stroke)} activeDot={{ r: 6 }} connectNulls legendType={l.showLegend ? "line" : "none"} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </ZoomableChart>
          </CardContent>
        </Card>

        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Interrupt Latency (ms)</CardTitle>
            <CardDescription>Time to Interrupt (TTI) - {regionLabel}</CardDescription>
          </CardHeader>
          <CardContent>
            <ZoomableChart totalLength={combinedData.length} zoomState={chartZoom}>
              <div className="h-[300px] w-full">
                {isLoading ? (
                  <Skeleton className="h-full w-full" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={interruptChart.rows}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis dataKey="timestamp" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => `${value}ms`} />
                      <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }} itemStyle={{ color: 'hsl(var(--popover-foreground))' }} />
                      <Legend />
                      {interruptChart.lines.map(l => (
                        <Line key={l.segKey} type="monotone" dataKey={l.segKey} name={l.name} stroke={l.stroke} strokeWidth={2} dot={makeEndpointDot(l.dataIndices, l.stroke)} activeDot={{ r: 6 }} connectNulls legendType={l.showLegend ? "line" : "none"} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </ZoomableChart>
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
      params.set("limit", timeRange === "all" ? "2000" : "200");
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
      params.set("limit", timeRange === "all" ? "2000" : "200");
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
      params.set("limit", timeRange === "all" ? "2000" : "200");
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
