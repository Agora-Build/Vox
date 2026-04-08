import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { Swords, Radio, Clock, Trophy, Headphones, Calendar } from "lucide-react";
import { formatSmartTimestamp, formatRegion } from "@/lib/utils";

interface ClashEvent {
  id: number;
  name: string;
  description: string | null;
  region: string;
  status: string;
  visibility: string;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface LeaderboardEntry {
  agentProfileId: number;
  profileName: string;
  providerName: string | null;
  rating: number;
  matchCount: number;
  winCount: number;
  lossCount: number;
  drawCount: number;
}

const statusColors: Record<string, string> = {
  upcoming: "bg-yellow-500/10 text-yellow-500",
  live: "bg-green-500/10 text-green-500",
  completed: "bg-muted text-muted-foreground",
  failed: "bg-red-500/10 text-red-500",
};

export default function Clash() {
  const { data: events, isLoading: loadingEvents } = useQuery<ClashEvent[]>({
    queryKey: ["/api/clash/feed"],
    queryFn: async () => {
      const res = await fetch("/api/clash/feed");
      return res.json();
    },
    refetchInterval: 5000,
  });

  const { data: leaderboard, isLoading: loadingLeaderboard } = useQuery<LeaderboardEntry[]>({
    queryKey: ["/api/clash/leaderboard"],
    queryFn: async () => {
      const res = await fetch("/api/clash/leaderboard");
      return res.json();
    },
  });

  const liveEvents = events?.filter((e) => e.status === "live") ?? [];
  const upcomingEvents = events?.filter((e) => e.status === "upcoming") ?? [];
  const recentEvents = events?.filter((e) => e.status === "completed") ?? [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-3">
          <Swords className="h-8 w-8 text-primary" />
          Clash
        </h1>
        <p className="text-muted-foreground mt-2">
          Head-to-head AI agent voice duels. Two agents debate live — watch, listen, and compare.
        </p>
      </div>

      {/* Live Now */}
      <section>
        <h2 className="text-xl font-semibold flex items-center gap-2 mb-4">
          <Radio className="h-5 w-5 text-green-500" />
          Live Now
        </h2>
        {loadingEvents ? (
          <div className="grid gap-4 md:grid-cols-2">
            {[1, 2].map((i) => <Skeleton key={i} className="h-32" />)}
          </div>
        ) : liveEvents.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2">
            {liveEvents.map((event) => (
              <Link key={event.id} href={`/clash/event/${event.id}`}>
                <Card className="cursor-pointer hover:border-primary/50 transition-colors">
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="inline-block h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                        <Badge className={statusColors.live}>LIVE</Badge>
                      </div>
                      <Badge variant="outline">{formatRegion(event.region)}</Badge>
                    </div>
                    <div className="text-lg font-medium">{event.name}</div>
                    {event.description && (
                      <p className="text-sm text-muted-foreground mt-1 truncate">{event.description}</p>
                    )}
                    <div className="flex items-center gap-1 mt-3 text-xs text-green-500">
                      <Headphones className="h-3 w-3" />
                      Watch Live
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No live events right now. Check back soon.
            </CardContent>
          </Card>
        )}
      </section>

      {/* Upcoming */}
      <section>
        <h2 className="text-xl font-semibold flex items-center gap-2 mb-4">
          <Calendar className="h-5 w-5 text-blue-400" />
          Upcoming
        </h2>
        {loadingEvents ? (
          <div className="space-y-3">
            {[1, 2].map((i) => <Skeleton key={i} className="h-20" />)}
          </div>
        ) : upcomingEvents.length > 0 ? (
          <div className="space-y-3">
            {upcomingEvents.map((event) => (
              <Link key={event.id} href={`/clash/event/${event.id}`}>
                <Card className="cursor-pointer hover:border-primary/50 transition-colors">
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Badge className={statusColors.upcoming}>Upcoming</Badge>
                        <span className="font-medium">{event.name}</span>
                      </div>
                      <div className="flex items-center gap-3 text-sm text-muted-foreground">
                        <Badge variant="outline">{formatRegion(event.region)}</Badge>
                        {event.scheduledAt && (
                          <span>{formatSmartTimestamp(event.scheduledAt)}</span>
                        )}
                      </div>
                    </div>
                    {event.description && (
                      <p className="text-sm text-muted-foreground mt-1 truncate">{event.description}</p>
                    )}
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No upcoming events scheduled.
            </CardContent>
          </Card>
        )}
      </section>

      {/* Elo Leaderboard (compact) */}
      <section>
        <h2 className="text-xl font-semibold flex items-center gap-2 mb-4">
          <Trophy className="h-5 w-5 text-yellow-500" />
          Leaderboard
        </h2>
        {loadingLeaderboard ? (
          <Skeleton className="h-48" />
        ) : leaderboard && leaderboard.length > 0 ? (
          <Card>
            <CardContent className="pt-6">
              <div className="space-y-3">
                {leaderboard.slice(0, 10).map((entry, i) => (
                  <div key={entry.agentProfileId} className="flex items-center gap-3">
                    <span className="text-sm font-mono w-6 text-right text-muted-foreground">{i + 1}</span>
                    <div className="flex-1">
                      <span className="font-medium">{entry.profileName}</span>
                      {entry.providerName && (
                        <span className="text-xs text-muted-foreground ml-2">({entry.providerName})</span>
                      )}
                    </div>
                    <span className="font-mono text-sm">{entry.rating}</span>
                    <span className="text-xs text-muted-foreground">
                      {entry.winCount}W {entry.lossCount}L {entry.drawCount}D
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No rankings yet. Clashes need to complete to build the leaderboard.
            </CardContent>
          </Card>
        )}
      </section>

      {/* Recent Events */}
      <section>
        <h2 className="text-xl font-semibold flex items-center gap-2 mb-4">
          <Clock className="h-5 w-5" />
          Recent
        </h2>
        {loadingEvents ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}
          </div>
        ) : recentEvents.length > 0 ? (
          <div className="space-y-3">
            {recentEvents.slice(0, 20).map((event) => (
              <Link key={event.id} href={`/clash/event/${event.id}`}>
                <Card className="cursor-pointer hover:border-primary/50 transition-colors">
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Badge className={statusColors.completed} variant="outline">
                          Completed
                        </Badge>
                        <span className="font-medium">{event.name}</span>
                      </div>
                      <div className="flex items-center gap-3 text-sm text-muted-foreground">
                        <Badge variant="outline">{formatRegion(event.region)}</Badge>
                        {event.completedAt && (
                          <span>{formatSmartTimestamp(event.completedAt)}</span>
                        )}
                      </div>
                    </div>
                    {event.description && (
                      <p className="text-sm text-muted-foreground mt-1 truncate">{event.description}</p>
                    )}
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No completed events yet.
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}
