import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Clock, Activity, RefreshCw, Lock, ChevronDown, Phone, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { appendRegionScopes, formatRegionScopeSelection } from "@/lib/utils";
import {
  chartDomainTicks,
  chartRangeDomain,
  clampChartRange,
  defaultChartRange,
  overscanChartRange,
  panChartRange,
  stableYAxisMax,
  wheelZoomScale,
  zoomChartRange,
  type ChartRange,
} from "@/lib/chart-zoom";
import { useRegionLocations } from "@/hooks/use-regions";
import { RegionScopeSelector } from "@/components/region-scope-selector";

interface EvalResult {
  id: number;
  providerId: string;
  provider: string;
  siteId: string;
  regionLabel?: string;
  countryCode?: string | null;
  countryName?: string | null;
  macroRegionCode?: string | null;
  macroRegionName?: string | null;
  // Latency is null (NA) when the agent didn't respond — never plotted/counted as 0.
  responseLatency: number | null;
  responseLatencySd: number | null;
  responseLatencyP95: number | null;
  interruptLatency: number | null;
  interruptLatencySd: number | null;
  interruptLatencyP95: number | null;
  // Turn Success Rate (0..1), or null. Includes no-response turns as failures —
  // the quality/resilience signal that stays meaningful when latency is NA.
  turnSuccessRate: number | null;
  networkResilience: number | null;
  naturalness: number | null;
  noiseReduction: number | null;
  timestamp: string;
  // Present on Community / My Evals (raw) points; null on aggregated buckets.
  evalFlowId?: number | null;
  evalFlowName?: string | null;
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

// Latency of null = NA (agent didn't respond). Render NA, never "0ms".
const fmtMs = (v: number | null | undefined) => v == null ? "N/A" : `${Math.round(v).toLocaleString()}ms`;
// Turn Success Rate is 0..1; null = no evaluable turns. Render as a percentage.
const fmtPct = (v: number | null | undefined) => v == null ? "N/A" : `${Math.round(v * 100)}%`;

interface HealthData {
  status: "operational" | "degraded" | "down";
  agents: { total: number; online: number; offline: number };
}



interface CombinedRow {
  chartIndex: number;
  timestamp: string;
  rawTime: number;
  [key: string]: string | number | undefined;
}

// Fallback palette for providers without brandColor
const PALETTE = [
  "#f97316", // orange
  "#22c55e", // green
  "#a855f7", // purple
  "#ef4444", // red
  "#eab308", // yellow
];

function fallbackColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
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

function buildCombinedData(filteredMetrics: EvalResult[], colorMap: Map<string, string>): ChartProviders {
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
      stroke: colorMap.get(id) || fallbackColor(id),
    }));

  const nameToKey = new Map(providers.map(p => [p.name, p.key]));

  // Group by timestamp, one slot per provider
  const timeGroups = new Map<number, { rawTime: number; values: Map<string, EvalResult> }>();

  for (const m of filteredMetrics) {
    const date = new Date(m.timestamp);
    if (isNaN(date.getTime())) continue;
    // Group to the minute without using the display label as identity. Labels
    // repeat across years and sort incorrectly around New Year.
    const timeKey = Math.floor(date.getTime() / 60000) * 60000;
    if (!timeGroups.has(timeKey)) {
      timeGroups.set(timeKey, { rawTime: timeKey, values: new Map() });
    }
    const group = timeGroups.get(timeKey)!;
    const pk = nameToKey.get(m.provider);
    if (pk && !group.values.has(pk)) {
      group.values.set(pk, m);
    }
  }

  const data = Array.from(timeGroups.values())
    .sort((a, b) => a.rawTime - b.rawTime)
    .map((group, chartIndex) => {
      const row: CombinedRow = {
        chartIndex,
        timestamp: format(new Date(group.rawTime), "MM/dd/yy HH:mm"),
        rawTime: group.rawTime,
      };
      for (const p of providers) {
        const m = group.values.get(p.key);
        // null latency (NA) → undefined so the chart's connectNulls skips the
        // point (a gap) rather than plotting it as 0.
        row[`${p.key}_response`] = m?.responseLatency ?? undefined;
        row[`${p.key}_interrupt`] = m?.interruptLatency ?? undefined;
        // Turn Success Rate as a percentage (0..100); undefined when no data so
        // connectNulls skips it.
        row[`${p.key}_tsr`] = m?.turnSuccessRate != null ? Math.round(m.turnSuccessRate * 100) : undefined;
        // Carry the evalFlow behind this point so the tooltip can name/link it.
        row[`${p.key}_wfname`] = m?.evalFlowName ?? undefined;
        row[`${p.key}_wfid`] = m?.evalFlowId ?? undefined;
      }
      return row;
    });

  return { data, providers };
}

// Connect consecutive points into one line when they're within this window;
// break into a separate segment only when the gap is longer (a real outage).
const GAP_MS = 6 * 60 * 60 * 1000; // 6 hours

interface SegmentLineInfo {
  segKey: string;
  name: string;
  stroke: string;
  showLegend: boolean;
  /** Indices of data points that have values in this segment */
  dataIndices: number[];
}

/**
 * Pre-compute segmented data: splits each provider's series at gaps longer than GAP_MS.
 * Returns a new data array with segment keys baked in, plus line descriptors.
 */
function buildSegmentedData(
  data: CombinedRow[],
  providers: Array<{ dataKey: string; name: string; stroke: string }>,
  gapMs = GAP_MS,
): { rows: CombinedRow[]; lines: SegmentLineInfo[] } {
  const rows = data.map(r => ({ ...r }));
  const lines: SegmentLineInfo[] = [];

  for (const { dataKey, name, stroke } of providers) {
    let segment: SegmentLineInfo | null = null;
    let segmentIndex = -1;
    let lastTime = -1;

    for (let i = 0; i < rows.length; i++) {
      const value = rows[i][dataKey];
      if (value == null) continue;

      if (!segment || rows[i].rawTime - lastTime > gapMs) {
        segmentIndex += 1;
        segment = {
          segKey: `${dataKey}_s${segmentIndex}`,
          name,
          stroke,
          showLegend: segmentIndex === 0,
          dataIndices: [],
        };
        lines.push(segment);
      }

      rows[i][segment.segKey] = value;
      segment.dataIndices.push(rows[i].chartIndex);
      lastTime = rows[i].rawTime;
    }
  }

  return { rows, lines };
}

const NAVIGATION_IDLE_MS = 100;
const NAVIGATION_ANIMATION_MS = 220;

function rangesAreEqual(a: ChartRange, b: ChartRange): boolean {
  return Math.abs(a.start - b.start) < 0.001 && Math.abs(a.end - b.end) < 0.001;
}

function useChartZoom(totalLength: number) {
  const [range, setRange] = useState<ChartRange>(() => defaultChartRange(totalLength));
  const [isNavigating, setIsNavigating] = useState(false);
  const currentRange = clampChartRange(range, totalLength);
  const displayedRangeRef = useRef(currentRange);
  const targetRangeRef = useRef(currentRange);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const cancelAnimation = useCallback(() => {
    if (animationFrameRef.current != null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current != null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const animateToTarget = useCallback(() => {
    cancelAnimation();
    const from = clampChartRange(displayedRangeRef.current, totalLength);
    const to = clampChartRange(targetRangeRef.current, totalLength);
    if (rangesAreEqual(from, to)) {
      displayedRangeRef.current = to;
      setRange(to);
      setIsNavigating(false);
      return;
    }
    const startedAt = performance.now();

    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / NAVIGATION_ANIMATION_MS);
      const eased = progress < 0.5
        ? 4 * progress ** 3
        : 1 - ((-2 * progress + 2) ** 3) / 2;
      const next = {
        start: from.start + (to.start - from.start) * eased,
        end: from.end + (to.end - from.end) * eased,
      };
      displayedRangeRef.current = next;
      setRange(next);

      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(step);
      } else {
        animationFrameRef.current = null;
        setIsNavigating(false);
      }
    };

    animationFrameRef.current = requestAnimationFrame(step);
  }, [cancelAnimation, totalLength]);

  const zoom = useCallback((scale: number, anchorRatio: number) => {
    cancelAnimation();
    const base = clampChartRange(targetRangeRef.current, totalLength);
    targetRangeRef.current = zoomChartRange(base, totalLength, scale, anchorRatio);
    setIsNavigating(true);
    clearIdleTimer();
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      animateToTarget();
    }, NAVIGATION_IDLE_MS);
  }, [animateToTarget, cancelAnimation, clearIdleTimer, totalLength]);

  // Dragging updates the displayed range once per frame so content tracks the pointer.
  const pan = useCallback((deltaRatio: number) => {
    cancelAnimation();
    clearIdleTimer();
    const displayed = clampChartRange(displayedRangeRef.current, totalLength);
    const target = clampChartRange(targetRangeRef.current, totalLength);
    const nextDisplayed = panChartRange(
      displayed,
      totalLength,
      deltaRatio * (displayed.end - displayed.start),
    );
    const nextTarget = panChartRange(
      target,
      totalLength,
      deltaRatio * (target.end - target.start),
    );
    displayedRangeRef.current = nextDisplayed;
    targetRangeRef.current = nextTarget;
    setRange(nextDisplayed);
    setIsNavigating(true);
  }, [cancelAnimation, clearIdleTimer, totalLength]);

  // Pinching stays under the user's fingers while wheel zoom remains buffered.
  const zoomDirect = useCallback((scale: number, anchorRatio: number) => {
    cancelAnimation();
    clearIdleTimer();
    const nextDisplayed = zoomChartRange(
      displayedRangeRef.current,
      totalLength,
      scale,
      anchorRatio,
    );
    const nextTarget = zoomChartRange(
      targetRangeRef.current,
      totalLength,
      scale,
      anchorRatio,
    );
    displayedRangeRef.current = nextDisplayed;
    targetRangeRef.current = nextTarget;
    setRange(nextDisplayed);
    setIsNavigating(true);
  }, [cancelAnimation, clearIdleTimer, totalLength]);

  const finishNavigation = useCallback(() => {
    clearIdleTimer();
    if (rangesAreEqual(displayedRangeRef.current, targetRangeRef.current)) {
      setIsNavigating(false);
      return;
    }
    animateToTarget();
  }, [animateToTarget, clearIdleTimer]);

  const prevLenRef = useRef(totalLength);
  useEffect(() => {
    const shouldReset = Math.abs(totalLength - prevLenRef.current) > 5;
    prevLenRef.current = totalLength;
    if (shouldReset) {
      cancelAnimation();
      clearIdleTimer();
      const next = defaultChartRange(totalLength);
      displayedRangeRef.current = next;
      targetRangeRef.current = next;
      setRange(next);
      setIsNavigating(false);
      return;
    }

    const nextDisplayed = clampChartRange(displayedRangeRef.current, totalLength);
    displayedRangeRef.current = nextDisplayed;
    targetRangeRef.current = clampChartRange(targetRangeRef.current, totalLength);
    setRange(nextDisplayed);
  }, [cancelAnimation, clearIdleTimer, totalLength]);

  useEffect(() => () => {
    cancelAnimation();
    clearIdleTimer();
  }, [cancelAnimation, clearIdleTimer]);

  const start = currentRange.start;
  const end = currentRange.end;
  const windowSize = end - start;
  const isShowingAll = start <= 0 && end >= totalLength;
  return {
    start,
    end,
    windowSize,
    isShowingAll,
    isNavigating,
    zoom,
    zoomDirect,
    pan,
    finishNavigation,
  };
}

function ZoomableChart({ children, totalLength, zoomState }: {
  children: React.ReactNode;
  totalLength: number;
  zoomState: ReturnType<typeof useChartZoom>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ lastX: 0, active: false, isDragging: false });
  const pinchRef = useRef<{ dist: number } | null>(null);
  const touchStartRef = useRef<{ x: number } | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const pendingZoomRef = useRef({ scale: 1, anchorRatio: 0.5, direct: false });
  const panFrameRef = useRef<number | null>(null);
  const pendingPanRef = useRef(0);
  const { zoom, zoomDirect, pan, finishNavigation } = zoomState;

  const getTouchDist = useCallback((touches: React.TouchList) => {
    if (touches.length < 2) return 0;
    const dx = touches[1].clientX - touches[0].clientX;
    const dy = touches[1].clientY - touches[0].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }, []);

  const getAnchorRatio = useCallback((clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return 0.5;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const flushZoom = useCallback(() => {
    const pending = pendingZoomRef.current;
    pendingZoomRef.current = {
      scale: 1,
      anchorRatio: pending.anchorRatio,
      direct: pending.direct,
    };
    if (pending.scale === 1) return;
    if (pending.direct) zoomDirect(pending.scale, pending.anchorRatio);
    else zoom(pending.scale, pending.anchorRatio);
  }, [zoom, zoomDirect]);

  const scheduleZoom = useCallback((scale: number, anchorRatio: number, direct = false) => {
    pendingZoomRef.current.scale *= scale;
    pendingZoomRef.current.anchorRatio = anchorRatio;
    pendingZoomRef.current.direct = direct;
    if (zoomFrameRef.current != null) return;

    zoomFrameRef.current = requestAnimationFrame(() => {
      zoomFrameRef.current = null;
      flushZoom();
    });
  }, [flushZoom]);

  const flushPan = useCallback(() => {
    const pending = pendingPanRef.current;
    pendingPanRef.current = 0;
    if (pending !== 0) pan(pending);
  }, [pan]);

  const schedulePan = useCallback((deltaRatio: number) => {
    pendingPanRef.current += deltaRatio;
    if (panFrameRef.current != null) return;

    panFrameRef.current = requestAnimationFrame(() => {
      panFrameRef.current = null;
      flushPan();
    });
  }, [flushPan]);

  useEffect(() => () => {
    if (zoomFrameRef.current != null) cancelAnimationFrame(zoomFrameRef.current);
    if (panFrameRef.current != null) cancelAnimationFrame(panFrameRef.current);
  }, []);

  // Wheel events can arrive much faster than React can redraw three charts.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const anchor = getAnchorRatio(e.clientX);
      const pageHeight = containerRef.current?.clientHeight ?? window.innerHeight;
      scheduleZoom(wheelZoomScale(e.deltaY, e.deltaMode, pageHeight), anchor);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [getAnchorRatio, scheduleZoom]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    dragRef.current = { lastX: e.clientX, active: true, isDragging: false };
    containerRef.current?.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "touch" || !dragRef.current.active) return;
    const dx = e.clientX - dragRef.current.lastX;
    if (Math.abs(dx) > 3) dragRef.current.isDragging = true;
    if (!dragRef.current.isDragging) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    schedulePan(-dx / rect.width);
    dragRef.current.lastX = e.clientX;
  }, [schedulePan]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "touch") return;
    const wasDragging = dragRef.current.isDragging;
    dragRef.current = { lastX: 0, active: false, isDragging: false };
    if (panFrameRef.current != null) {
      cancelAnimationFrame(panFrameRef.current);
      panFrameRef.current = null;
    }
    if (wasDragging) {
      flushPan();
      finishNavigation();
    }
    if (containerRef.current?.hasPointerCapture(e.pointerId)) {
      containerRef.current.releasePointerCapture(e.pointerId);
    }
  }, [finishNavigation, flushPan]);

  // Touch: single-finger drag = pan, two-finger pinch = zoom.
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      pinchRef.current = { dist: getTouchDist(e.touches) };
      touchStartRef.current = null;
    } else if (e.touches.length === 1) {
      touchStartRef.current = { x: e.touches[0].clientX };
    }
  }, [getTouchDist]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchRef.current) {
      e.preventDefault();
      const newDist = getTouchDist(e.touches);
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      if (newDist > 0 && Math.abs(newDist - pinchRef.current.dist) > 1) {
        scheduleZoom(pinchRef.current.dist / newDist, getAnchorRatio(midX), true);
        pinchRef.current.dist = newDist;
      }
    } else if (e.touches.length === 1 && touchStartRef.current) {
      const dx = e.touches[0].clientX - touchStartRef.current.x;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      schedulePan(-dx / rect.width);
      touchStartRef.current.x = e.touches[0].clientX;
    }
  }, [getAnchorRatio, getTouchDist, schedulePan, scheduleZoom]);

  const handleTouchEnd = useCallback(() => {
    const wasNavigating = pinchRef.current != null || touchStartRef.current != null;
    if (zoomFrameRef.current != null) {
      cancelAnimationFrame(zoomFrameRef.current);
      zoomFrameRef.current = null;
    }
    if (panFrameRef.current != null) {
      cancelAnimationFrame(panFrameRef.current);
      panFrameRef.current = null;
    }
    flushZoom();
    flushPan();
    if (wasNavigating) finishNavigation();
    pinchRef.current = null;
    touchStartRef.current = null;
  }, [finishNavigation, flushPan, flushZoom]);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="cursor-grab active:cursor-grabbing"
        style={{ touchAction: "none", userSelect: "none" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
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
          {Math.round(zoomState.windowSize)} of {totalLength} points — scroll to zoom, drag to pan
        </div>
      )}
    </div>
  );
}

/** Render dot only at start/end of segment or isolated single points */
function makeEndpointDot(dataIndices: number[], stroke: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (props: any) => {
    const { cx, cy, payload } = props;
    const index = payload?.chartIndex;
    const key = `${stroke}-${index ?? props.index ?? "empty"}`;
    if (cx == null || cy == null) return <g key={key} />;
    const first = dataIndices[0];
    const last = dataIndices[dataIndices.length - 1];
    const isSingle = dataIndices.length === 1;
    const isEndpoint = index === first || index === last;
    if (!isEndpoint && !isSingle) return <g key={key} />;
    return (
      <g key={key}>
        <circle cx={cx} cy={cy} r={6} fill={stroke} opacity={0.3} />
        <circle cx={cx} cy={cy} r={4} fill={stroke} />
        <circle cx={cx} cy={cy} r={2} fill="white" />
      </g>
    );
  };
}

// Derive a provider's row-key prefix from a segment dataKey:
// "agora_convoai_engine_response_s0" → "agora_convoai_engine"
function providerPrefixFromDataKey(dataKey: string): string {
  return dataKey.replace(/_s\d+$/, "").replace(/_(response|interrupt)$/, "");
}

/**
 * Chart tooltip that adds the evalFlow name (as a link to its detail page) under
 * each provider line. `showEvalFlow` gates the evalFlow row so the mainline tab —
 * where a point is a daily average of many evalFlows — keeps the plain tooltip.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function EvalFlowTooltip({ active, payload, label, showEvalFlow, unit = "ms" }: any) {
  if (!active || !Array.isArray(payload) || payload.length === 0) return null;
  const row = (payload[0]?.payload ?? {}) as CombinedRow;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items = payload.filter((e: any) => e.value != null);
  if (items.length === 0) return null;
  return (
    <div className="rounded-lg border bg-popover text-popover-foreground shadow-md px-3 py-2 text-sm">
      <div className="font-medium mb-1">{row.timestamp ?? label}</div>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      {items.map((e: any) => {
        const prefix = providerPrefixFromDataKey(String(e.dataKey));
        const wfName = showEvalFlow ? (row[`${prefix}_wfname`] as string | undefined) : undefined;
        const wfId = showEvalFlow ? (row[`${prefix}_wfid`] as number | undefined) : undefined;
        return (
          <div key={e.dataKey} className="flex flex-col gap-0.5 py-0.5">
            <span style={{ color: e.color }}>{e.name}: {e.value}{unit}</span>
            {wfName && (wfId != null ? (
              <Link
                href={`/console/eval-flows/${wfId}`}
                className="text-xs text-muted-foreground hover:text-primary hover:underline underline-offset-2 w-fit"
                data-testid="link-tooltip-eval-flow"
              >
                {wfName}
              </Link>
            ) : (
              <span className="text-xs text-muted-foreground">{wfName}</span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function useSettledYAxisMax(
  rows: CombinedRow[],
  dataKeys: string[],
  isNavigating: boolean,
): number {
  const nextMaximum = useMemo(
    () => stableYAxisMax(rows, dataKeys),
    [dataKeys, rows],
  );
  const [maximum, setMaximum] = useState(nextMaximum);

  useEffect(() => {
    if (!isNavigating) setMaximum(nextMaximum);
  }, [isNavigating, nextMaximum]);

  return maximum;
}

interface MetricsSectionProps {
  metrics: EvalResult[] | undefined;
  isLoading: boolean;
  timeRangeLabel: string;
  timeRange: string;
  regionLabel: string;
  testIdPrefix?: string;
  /** Show the evalFlow name/link in the tooltip (Community / My Evals only). */
  showEvalFlow?: boolean;
  /** Provider ids to hide from the charts (multi-select filter). */
  hiddenProviders?: Set<string>;
}

function MetricsSection({ metrics, isLoading, timeRangeLabel, timeRange, regionLabel, testIdPrefix = "", showEvalFlow = false, hiddenProviders }: MetricsSectionProps) {
  const { data: providerList } = useQuery<Array<{ id: string; brandColor: string | null }>>({
    queryKey: ["/api/providers"],
    staleTime: 60000,
  });

  const colorMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of providerList ?? []) {
      if (p.brandColor) map.set(p.id, p.brandColor);
    }
    return map;
  }, [providerList]);

  const filteredMetrics = useMemo(
    () => metrics?.filter(m => !(hiddenProviders?.has(m.providerId))) ?? [],
    [hiddenProviders, metrics],
  );

  const { data: combinedData, providers } = useMemo(() => buildCombinedData(filteredMetrics, colorMap), [filteredMetrics, colorMap]);

  // Show latest single test result (metrics are ordered by createdAt DESC)
  const latest = filteredMetrics[0] ?? null;

  // Zoom/pan state — shared across both charts so they stay in sync
  const chartZoom = useChartZoom(combinedData.length);
  const chartDomain = useMemo(
    () => chartRangeDomain({ start: chartZoom.start, end: chartZoom.end }, combinedData.length),
    [chartZoom.start, chartZoom.end, combinedData.length],
  );
  const chartTicks = useMemo(() => chartDomainTicks(chartDomain), [chartDomain]);
  const formatChartTick = useCallback((value: number) => {
    if (combinedData.length === 0) return "";
    const index = Math.max(0, Math.min(combinedData.length - 1, Math.round(value)));
    return format(new Date(combinedData[index].rawTime), "MM/dd HH:mm");
  }, [combinedData]);
  const visibleBounds = useMemo(
    () => overscanChartRange({ start: chartZoom.start, end: chartZoom.end }, combinedData.length),
    [chartZoom.start, chartZoom.end, combinedData.length],
  );
  const segmentGapMs = timeRange === "all" ? 36 * 60 * 60 * 1000 : GAP_MS;

  // Segment the complete selected range once so line identities stay stable.
  const responseProviders = useMemo(() => providers.map(p => ({ dataKey: `${p.key}_response`, name: p.name, stroke: p.stroke })), [providers]);
  const interruptProviders = useMemo(() => providers.map(p => ({ dataKey: `${p.key}_interrupt`, name: p.name, stroke: p.stroke })), [providers]);
  const tsrProviders = useMemo(() => providers.map(p => ({ dataKey: `${p.key}_tsr`, name: p.name, stroke: p.stroke })), [providers]);

  const responseChart = useMemo(() => buildSegmentedData(combinedData, responseProviders, segmentGapMs), [combinedData, responseProviders, segmentGapMs]);
  const interruptChart = useMemo(() => buildSegmentedData(combinedData, interruptProviders, segmentGapMs), [combinedData, interruptProviders, segmentGapMs]);
  const tsrChart = useMemo(() => buildSegmentedData(combinedData, tsrProviders, segmentGapMs), [combinedData, segmentGapMs, tsrProviders]);
  const responseRows = useMemo(() => responseChart.rows.slice(visibleBounds.start, visibleBounds.end), [responseChart.rows, visibleBounds]);
  const interruptRows = useMemo(() => interruptChart.rows.slice(visibleBounds.start, visibleBounds.end), [interruptChart.rows, visibleBounds]);
  const tsrRows = useMemo(() => tsrChart.rows.slice(visibleBounds.start, visibleBounds.end), [tsrChart.rows, visibleBounds]);
  const responseDataKeys = useMemo(
    () => responseProviders.map(provider => provider.dataKey),
    [responseProviders],
  );
  const interruptDataKeys = useMemo(
    () => interruptProviders.map(provider => provider.dataKey),
    [interruptProviders],
  );
  const responseYMax = useSettledYAxisMax(
    responseRows,
    responseDataKeys,
    chartZoom.isNavigating,
  );
  const interruptYMax = useSettledYAxisMax(
    interruptRows,
    interruptDataKeys,
    chartZoom.isNavigating,
  );

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
                  <span className="text-2xl font-bold font-mono" data-testid={`${testIdPrefix}text-response-median`}>{fmtMs(latest?.responseLatency)}</span>
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-muted-foreground font-mono">SD</span>
                  <span className="text-lg font-mono text-muted-foreground" data-testid={`${testIdPrefix}text-response-stddev`}>{fmtMs(latest?.responseLatencySd)}</span>
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-muted-foreground font-mono">P95</span>
                  <span className="text-lg font-mono text-muted-foreground" data-testid={`${testIdPrefix}text-response-p95`}>{fmtMs(latest?.responseLatencyP95)}</span>
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
                  <span className="text-2xl font-bold font-mono" data-testid={`${testIdPrefix}text-interrupt-median`}>{fmtMs(latest?.interruptLatency)}</span>
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-muted-foreground font-mono">SD</span>
                  <span className="text-lg font-mono text-muted-foreground" data-testid={`${testIdPrefix}text-interrupt-stddev`}>{fmtMs(latest?.interruptLatencySd)}</span>
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-muted-foreground font-mono">P95</span>
                  <span className="text-lg font-mono text-muted-foreground" data-testid={`${testIdPrefix}text-interrupt-p95`}>{fmtMs(latest?.interruptLatencyP95)}</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Turn Success Rate</CardTitle>
            <div className="flex items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Clock className="h-4 w-4 text-muted-foreground cursor-pointer hover:text-foreground transition-colors" />
                </PopoverTrigger>
                <PopoverContent className="w-80">
                  <div className="space-y-2">
                    <h4 className="font-medium leading-none">Turn Success Rate</h4>
                    <p className="text-sm text-muted-foreground">
                      Share of turns the agent handled correctly — responded when expected, stopped promptly on interrupt, and avoided false barge-in.
                    </p>
                    <p className="text-xs text-muted-foreground pt-2 border-t">
                      A no-response turn counts as a failure, so this stays meaningful under network impairment where latency is N/A.
                    </p>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-20 mt-2" />
            ) : (
              <div className="text-2xl font-bold font-mono mt-2" data-testid={`${testIdPrefix}text-turn-success-rate`}>{fmtPct(latest?.turnSuccessRate)}</div>
            )}
            <p className="text-xs text-muted-foreground">Responds · stops · no false barge-in</p>
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
            <p className="text-xs text-muted-foreground truncate">{regionLabel} · {timeRangeLabel}</p>
            <p className="text-xs text-muted-foreground truncate pt-1" title={latest?.provider ?? undefined} data-testid={`${testIdPrefix}text-latest-provider`}>Latest: {latest?.provider ?? "—"}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="col-span-1 md:col-span-2">
          <CardHeader>
            <CardTitle>Turn Success Rate (%)</CardTitle>
            <CardDescription>Responds · stops on interrupt · no false barge-in - {regionLabel}</CardDescription>
          </CardHeader>
          <CardContent>
            <ZoomableChart totalLength={combinedData.length} zoomState={chartZoom}>
              <div className="h-[300px] w-full">
                {isLoading ? (
                  <Skeleton className="h-full w-full" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={tsrRows}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis
                        dataKey="chartIndex"
                        type="number"
                        domain={chartDomain}
                        ticks={chartTicks}
                        allowDataOverflow
                        minTickGap={24}
                        interval="preserveStartEnd"
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={12}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={formatChartTick}
                      />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} domain={[0, 100]} tickFormatter={(value) => `${value}%`} />
                      {!chartZoom.isNavigating && <Tooltip content={<EvalFlowTooltip showEvalFlow={showEvalFlow} unit="%" />} wrapperStyle={{ pointerEvents: 'auto' }} />}
                      <Legend />
                      {tsrChart.lines.map(l => (
                        <Line key={l.segKey} type="monotone" dataKey={l.segKey} name={l.name} stroke={l.stroke} strokeWidth={2} dot={makeEndpointDot(l.dataIndices, l.stroke)} activeDot={{ r: 6 }} connectNulls isAnimationActive={false} legendType={l.showLegend ? "line" : "none"} />
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
                    <LineChart data={responseRows}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis
                        dataKey="chartIndex"
                        type="number"
                        domain={chartDomain}
                        ticks={chartTicks}
                        allowDataOverflow
                        minTickGap={24}
                        interval="preserveStartEnd"
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={12}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={formatChartTick}
                      />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} domain={[0, responseYMax]} tickFormatter={(value) => `${value}ms`} />
                      {!chartZoom.isNavigating && <Tooltip content={<EvalFlowTooltip showEvalFlow={showEvalFlow} />} wrapperStyle={{ pointerEvents: 'auto' }} />}
                      <Legend />
                      {responseChart.lines.map(l => (
                        <Line key={l.segKey} type="monotone" dataKey={l.segKey} name={l.name} stroke={l.stroke} strokeWidth={2} dot={makeEndpointDot(l.dataIndices, l.stroke)} activeDot={{ r: 6 }} connectNulls isAnimationActive={false} legendType={l.showLegend ? "line" : "none"} />
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
                    <LineChart data={interruptRows}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis
                        dataKey="chartIndex"
                        type="number"
                        domain={chartDomain}
                        ticks={chartTicks}
                        allowDataOverflow
                        minTickGap={24}
                        interval="preserveStartEnd"
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={12}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={formatChartTick}
                      />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} domain={[0, interruptYMax]} tickFormatter={(value) => `${value}ms`} />
                      {!chartZoom.isNavigating && <Tooltip content={<EvalFlowTooltip showEvalFlow={showEvalFlow} />} wrapperStyle={{ pointerEvents: 'auto' }} />}
                      <Legend />
                      {interruptChart.lines.map(l => (
                        <Line key={l.segKey} type="monotone" dataKey={l.segKey} name={l.name} stroke={l.stroke} strokeWidth={2} dot={makeEndpointDot(l.dataIndices, l.stroke)} activeDot={{ r: 6 }} connectNulls isAnimationActive={false} legendType={l.showLegend ? "line" : "none"} />
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
  const [regionScopes, setRegionScopes] = useState<string[]>(["all"]);
  const [refreshInterval, setRefreshInterval] = useState<number>(30000);
  const [timeRange, setTimeRange] = useState<string>("168");
  // Evaluation Mode (design §11): web and phone are separate measurement
  // categories, never mixed — the switch scopes the whole page; switching
  // refetches with the transport param.
  const [evalMode, setEvalMode] = useState<"web" | "phone">("web");
  // Provider multi-select: hidden set (default empty = all shown).
  const [hiddenProviders, setHiddenProviders] = useState<Set<string>>(new Set());
  const { data: regionLocations } = useRegionLocations();
  const { data: providerList } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ["/api/providers"],
    staleTime: 60000,
  });
  const initialTab = new URLSearchParams(window.location.search).get("tab");
  const [activeTab, setActiveTab] = useState<string>(
    initialTab && ["mainline", "community", "my-evals"].includes(initialTab) ? initialTab : "mainline"
  );

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const isLoggedIn = !!authStatus?.user;

  const availabilityTier = activeTab === "mainline" ? "realtime" : activeTab === "community" ? "community" : "my-evals";
  const { data: regionAvailability } = useQuery<{ availableRegions: string[]; hasUnverified: boolean }>({
    queryKey: ["/api/metrics/available-regions", availabilityTier, timeRange],
    queryFn: async () => {
      const params = new URLSearchParams({ tier: availabilityTier });
      if (timeRange !== "all") params.set("hours", timeRange);
      const res = await fetch(`/api/metrics/available-regions?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("available-regions failed");
      return res.json();
    },
    enabled: activeTab !== "my-evals" || isLoggedIn,
  });

  const visibleLocations = useMemo(() => {
    const all = regionLocations ?? [];
    // Mainline: the fixed admin-curated set — shown even with no data (the gap
    // IS the signal). Community/My Evals: only cities that actually have data.
    if (activeTab === "mainline") return all.filter((l) => l.isMainline);
    const avail = new Set(regionAvailability?.availableRegions ?? []);
    return all.filter((l) => avail.has(l.baseId));
  }, [regionLocations, activeTab, regionAvailability]);

  // Region scopes are tab-specific (each tab has a different tree); reset on tab switch.
  useEffect(() => {
    setRegionScopes(["all"]);
  }, [activeTab]);

  const regionScopeKey = [...regionScopes].sort().join(",");
  const { data: mainlineMetrics, isLoading: mainlineLoading, refetch: refetchMainline, isFetching: mainlineFetching } = useQuery<EvalResult[]>({
    queryKey: ['/api/metrics/realtime', timeRange, regionScopeKey, evalMode],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (timeRange !== "all") params.set("hours", timeRange);
      if (evalMode !== "web") params.set("transport", evalMode);
      appendRegionScopes(params, regionScopes);
      // No limit param: the server owns row counts + raw-vs-bucket per window.
      const res = await fetch(`/api/metrics/realtime?${params}`);
      if (!res.ok) throw new Error("Failed to fetch metrics");
      return res.json();
    },
    refetchInterval: refreshInterval,
    enabled: activeTab === "mainline",
  });

  const { data: communityMetrics, isLoading: communityLoading, refetch: refetchCommunity, isFetching: communityFetching } = useQuery<EvalResult[]>({
    queryKey: ['/api/metrics/community', timeRange, regionScopeKey, evalMode],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (timeRange !== "all") params.set("hours", timeRange);
      if (evalMode !== "web") params.set("transport", evalMode);
      appendRegionScopes(params, regionScopes);
      const res = await fetch(`/api/metrics/community?${params}`);
      if (!res.ok) throw new Error("Failed to fetch community metrics");
      return res.json();
    },
    refetchInterval: refreshInterval,
    enabled: activeTab === "community",
  });

  const { data: myEvalsMetrics, isLoading: myEvalsLoading, refetch: refetchMyEvals, isFetching: myEvalsFetching } = useQuery<EvalResult[]>({
    queryKey: ['/api/metrics/my-evals', timeRange, regionScopeKey, evalMode],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (timeRange !== "all") params.set("hours", timeRange);
      if (evalMode !== "web") params.set("transport", evalMode);
      appendRegionScopes(params, regionScopes);
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

  // Provider filter options = union of the active provider list and any provider
  // actually present in the loaded metrics, so historical/inactive providers on
  // the charts still get a checkbox (and "None" can hide them).
  const providerOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of providerList ?? []) map.set(p.id, p.name);
    for (const rows of [mainlineMetrics, communityMetrics, myEvalsMetrics]) {
      for (const m of rows ?? []) if (!map.has(m.providerId)) map.set(m.providerId, m.provider);
    }
    let opts = Array.from(map, ([id, name]) => ({ id, name }));
    // "Custom" is the catch-all provider for user-defined platforms — never a
    // Mainline entrant, so hide it from the Mainline filter. Community and My
    // Evals still show it (those tiers include custom-platform evals).
    if (activeTab === "mainline") opts = opts.filter(o => o.name !== "Custom");
    return opts.sort((a, b) => a.name.localeCompare(b.name));
  }, [providerList, mainlineMetrics, communityMetrics, myEvalsMetrics, activeTab]);

  const regionLabel = formatRegionScopeSelection(regionLocations ?? [], regionScopes);

  const timeRangeLabel = timeRange === "1" ? "Last hour"
    : timeRange === "6" ? "Last 6 hours"
    : timeRange === "24" ? "Last 24 hours"
    : timeRange === "168" ? "Last 7 days"
    : timeRange === "720" ? "Last 30 days"
    : "All time";

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-4">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight" data-testid="text-dashboard-title">Real-time</h1>
            {/* Evaluation Mode (design §11): a page-identity switch, not a tab
                group — bordered segmented control, visually distinct from the
                tier pills below. Web and phone are never mixed in one view. */}
            <div className="inline-flex overflow-hidden rounded-lg border border-border" data-testid="tabs-eval-mode" role="tablist" aria-label="Evaluation Mode">
              <button
                type="button"
                role="tab"
                data-testid="tab-mode-web"
                data-state={evalMode === "web" ? "active" : "inactive"}
                aria-selected={evalMode === "web"}
                onClick={() => setEvalMode("web")}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 text-sm transition-colors ${
                  evalMode === "web"
                    ? "bg-primary/10 text-foreground shadow-[inset_0_-2px_0_hsl(var(--primary))]"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Globe className="h-3.5 w-3.5" />
                Web
              </button>
              <button
                type="button"
                role="tab"
                data-testid="tab-mode-phone"
                data-state={evalMode === "phone" ? "active" : "inactive"}
                aria-selected={evalMode === "phone"}
                onClick={() => setEvalMode("phone")}
                className={`flex items-center gap-1.5 border-l border-border px-3.5 py-1.5 text-sm transition-colors ${
                  evalMode === "phone"
                    ? "bg-primary/10 text-foreground shadow-[inset_0_-2px_0_hsl(var(--primary))]"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Phone className="h-3.5 w-3.5" />
                Phone
              </button>
            </div>
          </div>
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
              <SelectItem value="720">30 days</SelectItem>
              <SelectItem value="all">All time</SelectItem>
            </SelectContent>
          </Select>
          <RegionScopeSelector
            locations={visibleLocations}
            value={regionScopes}
            onChange={setRegionScopes}
            showUnverified={activeTab === "my-evals" && !!regionAvailability?.hasUnverified}
          />
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="w-[150px] justify-between font-normal" data-testid="button-provider-filter">
                <span className="truncate">
                  {(() => {
                    // Count only providers in the current tab's list — the hidden
                    // set may carry ids absent here (e.g. Custom, hidden on
                    // another tab), which would skew a raw size subtraction.
                    const visible = providerOptions.filter(p => !hiddenProviders.has(p.id)).length;
                    return visible === providerOptions.length
                      ? "All providers"
                      : `Providers ${visible}/${providerOptions.length}`;
                  })()}
                </span>
                <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-2">
              <div className="flex items-center justify-between px-1 pb-2 mb-1 border-b">
                <span className="text-xs font-medium text-muted-foreground">Providers</span>
                <div className="flex gap-2">
                  <button className="text-xs hover:text-primary" onClick={() => setHiddenProviders(new Set())} data-testid="button-providers-all">All</button>
                  <button className="text-xs hover:text-primary" onClick={() => setHiddenProviders(new Set(providerOptions.map(p => p.id)))} data-testid="button-providers-none">None</button>
                </div>
              </div>
              <div className="max-h-64 overflow-auto space-y-0.5">
                {providerOptions.map(p => (
                  <label key={p.id} className="flex items-center gap-2 px-1 py-1 rounded hover:bg-accent cursor-pointer text-sm" data-testid={`provider-filter-${p.id}`}>
                    <Checkbox
                      checked={!hiddenProviders.has(p.id)}
                      onCheckedChange={() => setHiddenProviders(prev => {
                        const next = new Set(prev);
                        if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                        return next;
                      })}
                    />
                    <span className="truncate">{p.name}</span>
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
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
            timeRangeLabel={timeRangeLabel}
            timeRange={timeRange}
            regionLabel={regionLabel}
            testIdPrefix=""
            hiddenProviders={hiddenProviders}
          />
        </TabsContent>

        <TabsContent value="community" className="space-y-4 mt-4">
          <MetricsSection
            metrics={communityMetrics}
            isLoading={communityLoading}
            timeRangeLabel={timeRangeLabel}
            timeRange={timeRange}
            regionLabel={regionLabel}
            testIdPrefix="community-"
            showEvalFlow
            hiddenProviders={hiddenProviders}
          />
        </TabsContent>

        <TabsContent value="my-evals" className="space-y-4 mt-4">
          {isLoggedIn ? (
            <MetricsSection
              metrics={myEvalsMetrics}
              isLoading={myEvalsLoading}
              timeRangeLabel={timeRangeLabel}
              timeRange={timeRange}
              regionLabel={regionLabel}
              testIdPrefix="my-evals-"
              showEvalFlow
              hiddenProviders={hiddenProviders}
            />
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <Lock className="h-8 w-8 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">Sign in required</h3>
                <p className="text-sm text-muted-foreground max-w-md">
                  Sign in to view your private evaluation results. Results from private evalFlows or eval sets you own will appear here.
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
