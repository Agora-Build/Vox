import { useQuery } from "@tanstack/react-query";
import { useRoute } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Radio, Clock, Swords, Trophy, Video } from "lucide-react";
import { formatSmartTimestamp, formatRegion } from "@/lib/utils";
import AgoraSpectator from "@/components/agora-spectator";
import ClashTranscript from "@/components/clash-transcript";
import ClashMetricsLive from "@/components/clash-metrics-live";
import { useClashWs } from "@/hooks/use-clash-ws";

interface ClashEventMatch {
  id: number;
  matchOrder: number;
  agentAProfileId: number;
  agentBProfileId: number;
  topic: string;
  status: string;
  winnerId: number | null;
  durationSeconds: number | null;
  recordingUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
  agentA?: { id: number; name: string };
  agentB?: { id: number; name: string };
}

interface ClashEventDetail {
  id: number;
  name: string;
  description: string | null;
  region: string;
  status: string;
  scheduledAt: string | null;
  agoraChannelName: string | null;
  startedAt: string | null;
  completedAt: string | null;
  matches: ClashEventMatch[];
}

interface StreamInfo {
  appId: string;
  channelId: string;
  token: string;
  uid: number;
}

const statusColors: Record<string, string> = {
  scheduled: "bg-yellow-500/10 text-yellow-500",
  upcoming: "bg-yellow-500/10 text-yellow-500",
  live: "bg-green-500/10 text-green-500",
  completed: "bg-muted text-muted-foreground",
  failed: "bg-red-500/10 text-red-500",
};

const matchStatusColors: Record<string, string> = {
  pending: "bg-yellow-500/10 text-yellow-500",
  starting: "bg-blue-500/10 text-blue-500",
  live: "bg-green-500/10 text-green-500",
  completed: "bg-muted text-muted-foreground",
  failed: "bg-red-500/10 text-red-500",
};

function LiveMatchPanel({ match, eventChannelName }: {
  match: ClashEventMatch;
  eventChannelName: string | null;
}) {
  const { connected, spectatorCount, transcripts, latestMetrics, phase } = useClashWs(match.id);

  const { data: streamInfo } = useQuery<StreamInfo>({
    queryKey: [`/api/clash/matches/${match.id}/stream-info`],
    queryFn: async () => {
      const res = await fetch(`/api/clash/matches/${match.id}/stream-info`);
      if (!res.ok) return null;
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radio className="h-5 w-5 text-green-500 animate-pulse" />
          Live Match
          {spectatorCount > 0 && (
            <span className="text-sm font-normal text-muted-foreground ml-2">
              {spectatorCount} watching
            </span>
          )}
        </CardTitle>
        <div className="flex items-center gap-3 mt-2">
          <span className="font-medium">{match.agentA?.name || "Agent A"}</span>
          <Swords className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{match.agentB?.name || "Agent B"}</span>
        </div>
        {match.topic && (
          <p className="text-sm text-muted-foreground mt-1">{match.topic}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {streamInfo ? (
          <AgoraSpectator
            appId={streamInfo.appId}
            channelId={streamInfo.channelId}
            token={streamInfo.token}
            uid={streamInfo.uid}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Connecting to live audio stream...
          </p>
        )}
        <ClashTranscript
          entries={transcripts}
          agentAName={match.agentA?.name}
          agentBName={match.agentB?.name}
        />
        <ClashMetricsLive
          metrics={latestMetrics}
          agentAName={match.agentA?.name}
          agentBName={match.agentB?.name}
        />
        {phase && phase !== "waiting" && (
          <div className="text-xs text-muted-foreground">
            Phase: {phase}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MatchRow({ match }: { match: ClashEventMatch }) {
  const agentAName = match.agentA?.name || "Agent A";
  const agentBName = match.agentB?.name || "Agent B";
  const winnerName = match.winnerId === match.agentAProfileId
    ? agentAName
    : match.winnerId === match.agentBProfileId
      ? agentBName
      : null;

  return (
    <div className="flex items-start gap-3 p-3 rounded-md border">
      <div className="flex-shrink-0 text-sm text-muted-foreground w-6 pt-0.5">
        #{match.matchOrder}
      </div>
      <div className="flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <Badge className={matchStatusColors[match.status] || ""}>
            {match.status === "live" && <Radio className="h-3 w-3 mr-1 animate-pulse" />}
            {match.status.toUpperCase()}
          </Badge>
          {winnerName && (
            <span className="text-sm text-green-500 flex items-center gap-1">
              <Trophy className="h-3 w-3" />
              {winnerName} won
            </span>
          )}
        </div>
        <div className="text-sm font-medium flex items-center gap-2">
          <span>{agentAName}</span>
          <Swords className="h-3 w-3 text-muted-foreground" />
          <span>{agentBName}</span>
        </div>
        {match.topic && (
          <p className="text-xs text-muted-foreground">{match.topic}</p>
        )}
        {match.durationSeconds && (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {Math.floor(match.durationSeconds / 60)}m {match.durationSeconds % 60}s
          </p>
        )}
        {match.recordingUrl && (
          <div className="pt-1">
            <a
              href={match.recordingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
            >
              <Video className="h-3 w-3" />
              Recording
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ClashEvent() {
  const [, params] = useRoute("/clash/event/:id");
  const eventId = params?.id;

  const { data: event, isLoading } = useQuery<ClashEventDetail>({
    queryKey: [`/api/clash/events/${eventId}`],
    queryFn: async () => {
      const res = await fetch(`/api/clash/events/${eventId}`);
      return res.json();
    },
    enabled: !!eventId,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.status === "live" ? 3000 : false;
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-3xl mx-auto">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-64" />
        <Skeleton className="h-32" />
      </div>
    );
  }

  if (!event) {
    return <div className="text-center py-12 text-muted-foreground">Event not found.</div>;
  }

  const liveMatch = event.matches.find(m => m.status === "live" || m.status === "starting");
  const completedMatches = event.matches.filter(m => m.status === "completed");
  const upcomingMatches = event.matches.filter(m => m.status === "pending");

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <Badge className={statusColors[event.status] || ""}>
            {event.status === "live" && <Radio className="h-3 w-3 mr-1 animate-pulse" />}
            {event.status.toUpperCase()}
          </Badge>
          <span className="text-sm text-muted-foreground">{formatRegion(event.region)}</span>
          {event.scheduledAt && (
            <span className="text-sm text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatSmartTimestamp(event.scheduledAt)}
            </span>
          )}
        </div>
        <h1 className="text-2xl font-bold">{event.name}</h1>
        {event.description && (
          <p className="text-muted-foreground mt-1">{event.description}</p>
        )}
      </div>

      {/* Live match panel */}
      {liveMatch && (
        <LiveMatchPanel match={liveMatch} eventChannelName={event.agoraChannelName} />
      )}

      {/* Upcoming: show scheduled time + match lineup */}
      {event.status !== "live" && event.status !== "completed" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Schedule
            </CardTitle>
          </CardHeader>
          <CardContent>
            {event.scheduledAt ? (
              <p className="text-sm text-muted-foreground">
                Scheduled for {formatSmartTimestamp(event.scheduledAt)}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Time TBD</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Match lineup */}
      {event.matches.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Swords className="h-5 w-5" />
              Matches ({event.matches.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {event.matches.map(match => (
              <MatchRow key={match.id} match={match} />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Event timing info */}
      {(event.startedAt || event.completedAt) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Event Info
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground">Region</dt>
                <dd className="font-medium">{formatRegion(event.region)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Matches</dt>
                <dd className="font-medium">{event.matches.length}</dd>
              </div>
              {event.startedAt && (
                <div>
                  <dt className="text-muted-foreground">Started</dt>
                  <dd className="font-medium">{formatSmartTimestamp(event.startedAt)}</dd>
                </div>
              )}
              {event.completedAt && (
                <div>
                  <dt className="text-muted-foreground">Completed</dt>
                  <dd className="font-medium">{formatSmartTimestamp(event.completedAt)}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
