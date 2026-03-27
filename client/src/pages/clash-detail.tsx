import { useQuery } from "@tanstack/react-query";
import { useRoute } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Swords, Radio, Clock, BarChart3 } from "lucide-react";
import { formatSmartTimestamp } from "@/lib/utils";
import AgoraSpectator from "@/components/agora-spectator";

interface ClashResult {
  id: number;
  agentProfileId: number;
  responseLatencyMedian: number | null;
  responseLatencySd: number | null;
  interruptLatencyMedian: number | null;
  interruptLatencySd: number | null;
  ttftMedian: number | null;
  turnCount: number | null;
  overlapPercent: number | null;
}

interface ClashDetail {
  id: number;
  agentA: { id: number; name: string; providerId: string | null } | null;
  agentB: { id: number; name: string; providerId: string | null } | null;
  topic: string;
  region: string;
  status: string;
  maxDurationSeconds: number;
  durationSeconds: number | null;
  recordingUrl: string | null;
  broadcastChannelId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  results: ClashResult[];
}

interface StreamInfo {
  appId: string;
  channelId: string;
  token: string;
  uid: number;
}

const statusColors: Record<string, string> = {
  pending: "bg-yellow-500/10 text-yellow-500",
  starting: "bg-blue-500/10 text-blue-500",
  live: "bg-green-500/10 text-green-500",
  completed: "bg-muted text-muted-foreground",
  failed: "bg-red-500/10 text-red-500",
};

function MetricBar({ label, valueA, valueB, unit, lowerIsBetter }: {
  label: string;
  valueA: number | null;
  valueB: number | null;
  unit: string;
  lowerIsBetter?: boolean;
}) {
  if (valueA == null && valueB == null) return null;

  const better = lowerIsBetter
    ? (valueA != null && valueB != null ? (valueA < valueB ? "A" : valueA > valueB ? "B" : null) : null)
    : (valueA != null && valueB != null ? (valueA > valueB ? "A" : valueA < valueB ? "B" : null) : null);

  return (
    <div className="space-y-1">
      <div className="text-sm font-medium">{label}</div>
      <div className="flex items-center gap-4">
        <div className={`flex-1 text-right font-mono text-sm ${better === "A" ? "text-green-500 font-bold" : ""}`}>
          {valueA != null ? `${valueA}${unit}` : "—"}
        </div>
        <div className="w-px h-4 bg-border" />
        <div className={`flex-1 font-mono text-sm ${better === "B" ? "text-green-500 font-bold" : ""}`}>
          {valueB != null ? `${valueB}${unit}` : "—"}
        </div>
      </div>
    </div>
  );
}

export default function ClashDetail() {
  const [, params] = useRoute("/clash/:id");
  const matchId = params?.id;

  const { data: match, isLoading } = useQuery<ClashDetail>({
    queryKey: [`/api/clash/matches/${matchId}`],
    queryFn: async () => {
      const res = await fetch(`/api/clash/matches/${matchId}`);
      return res.json();
    },
    enabled: !!matchId,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.status === "live" || data?.status === "starting" ? 3000 : false;
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!match) {
    return <div className="text-center py-12 text-muted-foreground">Match not found.</div>;
  }

  const { data: streamInfo } = useQuery<StreamInfo>({
    queryKey: [`/api/clash/matches/${matchId}/stream-info`],
    queryFn: async () => {
      const res = await fetch(`/api/clash/matches/${matchId}/stream-info`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!match && match.status === "live",
    staleTime: 5 * 60 * 1000,
  });

  const resultA = match.results.find(r => r.agentProfileId === match.agentA?.id);
  const resultB = match.results.find(r => r.agentProfileId === match.agentB?.id);

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <Badge className={statusColors[match.status] || ""}>
            {match.status === "live" && <Radio className="h-3 w-3 mr-1 animate-pulse" />}
            {match.status.toUpperCase()}
          </Badge>
          <span className="text-sm text-muted-foreground">{match.region.toUpperCase()}</span>
          <span className="text-sm text-muted-foreground">{formatSmartTimestamp(match.createdAt)}</span>
        </div>
        <h1 className="text-2xl font-bold flex items-center gap-3">
          {match.agentA?.name || "Agent A"}
          <Swords className="h-6 w-6 text-muted-foreground" />
          {match.agentB?.name || "Agent B"}
        </h1>
        <p className="text-muted-foreground mt-1">{match.topic}</p>
      </div>

      {/* Live Spectator View */}
      {match.status === "live" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Radio className="h-5 w-5 text-green-500 animate-pulse" />
              Live
            </CardTitle>
          </CardHeader>
          <CardContent>
            {streamInfo ? (
              <AgoraSpectator
                appId={streamInfo.appId}
                channelId={streamInfo.channelId}
                token={streamInfo.token}
                uid={streamInfo.uid}
              />
            ) : (
              <p className="text-muted-foreground">
                This clash is happening right now. Connecting to live audio stream...
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Error */}
      {match.error && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="text-destructive text-sm">{match.error}</p>
          </CardContent>
        </Card>
      )}

      {/* Metrics Comparison */}
      {match.status === "completed" && (resultA || resultB) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              Results
            </CardTitle>
            <div className="flex items-center gap-4 text-sm text-muted-foreground mt-2">
              <span className="flex-1 text-right font-medium">{match.agentA?.name}</span>
              <span className="w-px" />
              <span className="flex-1 font-medium">{match.agentB?.name}</span>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <MetricBar
              label="Response Latency (median)"
              valueA={resultA?.responseLatencyMedian ?? null}
              valueB={resultB?.responseLatencyMedian ?? null}
              unit="ms"
              lowerIsBetter
            />
            <MetricBar
              label="Interrupt Latency (median)"
              valueA={resultA?.interruptLatencyMedian ?? null}
              valueB={resultB?.interruptLatencyMedian ?? null}
              unit="ms"
              lowerIsBetter
            />
            <MetricBar
              label="TTFT (median)"
              valueA={resultA?.ttftMedian ?? null}
              valueB={resultB?.ttftMedian ?? null}
              unit="ms"
              lowerIsBetter
            />
            <MetricBar
              label="Turn Count"
              valueA={resultA?.turnCount ?? null}
              valueB={resultB?.turnCount ?? null}
              unit=""
            />
            <MetricBar
              label="Overlap"
              valueA={resultA?.overlapPercent != null ? Math.round(resultA.overlapPercent * 10) / 10 : null}
              valueB={resultB?.overlapPercent != null ? Math.round(resultB.overlapPercent * 10) / 10 : null}
              unit="%"
              lowerIsBetter
            />
          </CardContent>
        </Card>
      )}

      {/* Match Info */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Match Info
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">Duration</dt>
              <dd className="font-medium">
                {match.durationSeconds
                  ? `${Math.floor(match.durationSeconds / 60)}m ${match.durationSeconds % 60}s`
                  : `${Math.floor(match.maxDurationSeconds / 60)}m max`}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Region</dt>
              <dd className="font-medium">{match.region.toUpperCase()}</dd>
            </div>
            {match.startedAt && (
              <div>
                <dt className="text-muted-foreground">Started</dt>
                <dd className="font-medium">{formatSmartTimestamp(match.startedAt)}</dd>
              </div>
            )}
            {match.completedAt && (
              <div>
                <dt className="text-muted-foreground">Completed</dt>
                <dd className="font-medium">{formatSmartTimestamp(match.completedAt)}</dd>
              </div>
            )}
          </dl>
        </CardContent>
      </Card>

      {/* Recording */}
      {match.recordingUrl && (
        <Card>
          <CardHeader>
            <CardTitle>Recording</CardTitle>
          </CardHeader>
          <CardContent>
            <audio controls className="w-full">
              <source src={match.recordingUrl} type="audio/wav" />
              Your browser does not support the audio element.
            </audio>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
