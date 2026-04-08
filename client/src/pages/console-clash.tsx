import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Switch } from "@/components/ui/switch";
import { Swords, Plus, Trash2, Play, X, Calendar, Copy, Check, Server } from "lucide-react";
import { useState } from "react";
import { useLocation, useSearch } from "wouter";
import { formatSmartTimestamp, formatRegion, REGIONS } from "@/lib/utils";

interface ClashAgentProfile {
  id: number;
  name: string;
  agentUrl: string;
  providerId: string | null;
  setupSteps: unknown[];
  visibility: string;
  createdAt: string;
}

interface ClashEvent {
  id: number;
  name: string;
  description: string | null;
  region: string;
  status: string;
  scheduledAt: string | null;
  createdAt: string;
}

interface ClashSchedule {
  id: number;
  eventName: string;
  matchups: { agentAProfileId: number; agentBProfileId: number; topic?: string }[];
  region: string;
  maxDurationSeconds: number;
  scheduledAt: string | null;
  cronExpression: string | null;
  isEnabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

interface Provider {
  id: string;
  name: string;
}

interface AuthStatus {
  initialized: boolean;
  user: { plan: string; isAdmin: boolean } | null;
}

interface MatchupRow {
  agentAProfileId: string;
  agentBProfileId: string;
  topic: string;
}

const statusColors: Record<string, string> = {
  pending: "bg-yellow-500/10 text-yellow-500",
  upcoming: "bg-yellow-500/10 text-yellow-500",
  starting: "bg-blue-500/10 text-blue-500",
  live: "bg-green-500/10 text-green-500",
  completed: "bg-muted text-muted-foreground",
  failed: "bg-red-500/10 text-red-500",
  cancelled: "bg-muted text-muted-foreground",
};

const VALID_TABS = ["profiles", "events", "schedules", "runners"];

export default function ConsoleClash() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const search = useSearch();
  const tabParam = new URLSearchParams(search).get("tab");
  const activeTab = tabParam && VALID_TABS.includes(tabParam) ? tabParam : "profiles";

  const setTab = (tab: string) => {
    setLocation(`/console/clash?tab=${tab}`);
  };
  const [createProfileOpen, setCreateProfileOpen] = useState(false);
  const [createEventOpen, setCreateEventOpen] = useState(false);
  const [createScheduleOpen, setCreateScheduleOpen] = useState(false);

  // Profile form state
  const [profileName, setProfileName] = useState("");
  const [profileUrl, setProfileUrl] = useState("");
  const [profileProvider, setProfileProvider] = useState("");
  const [profileSteps, setProfileSteps] = useState("[]");
  const [profileVisibility, setProfileVisibility] = useState("private");

  // Event form state
  const [eventName, setEventName] = useState("");
  const [eventRegion, setEventRegion] = useState("");
  const [eventScheduledAt, setEventScheduledAt] = useState("");
  const [eventMatchups, setEventMatchups] = useState<MatchupRow[]>([
    { agentAProfileId: "", agentBProfileId: "", topic: "" },
  ]);

  // Schedule form state
  const [scheduleName, setScheduleName] = useState("");
  const [scheduleMatchups, setScheduleMatchups] = useState<MatchupRow[]>([
    { agentAProfileId: "", agentBProfileId: "", topic: "" },
  ]);
  const [scheduleRegion, setScheduleRegion] = useState("");
  const [scheduleDuration, setScheduleDuration] = useState("300");
  const [scheduleAt, setScheduleAt] = useState("");
  const [scheduleCron, setScheduleCron] = useState("");

  const { data: profilesData, isLoading: loadingProfiles } = useQuery<{ ownProfiles: ClashAgentProfile[]; publicProfiles: ClashAgentProfile[] }>({
    queryKey: ["/api/clash/profiles"],
  });

  const { data: events, isLoading: loadingEvents } = useQuery<ClashEvent[]>({
    queryKey: ["/api/clash/events"],
  });

  const { data: providers } = useQuery<Provider[]>({
    queryKey: ["/api/providers"],
  });

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const isScout = authStatus?.user?.plan === "principal" || authStatus?.user?.plan === "fellow" || authStatus?.user?.isAdmin;

  const { data: schedules, isLoading: loadingSchedules } = useQuery<ClashSchedule[]>({
    queryKey: ["/api/clash/schedules"],
    enabled: !!isScout,
  });

  const isAdmin = authStatus?.user?.isAdmin === true;

  // Runner token state
  const [createRunnerTokenOpen, setCreateRunnerTokenOpen] = useState(false);
  const [newRunnerToken, setNewRunnerToken] = useState<string | null>(null);
  const [runnerTokenName, setRunnerTokenName] = useState("");
  const [runnerTokenRegion, setRunnerTokenRegion] = useState("");
  const [copiedToken, setCopiedToken] = useState(false);

  const { data: runnerTokens, isLoading: loadingRunnerTokens } = useQuery<
    { id: number; name: string; region: string; isRevoked: boolean; lastUsedAt: string | null; createdAt: string }[]
  >({
    queryKey: ["/api/admin/clash-runner-tokens"],
    enabled: isAdmin,
  });

  const { data: clashRunners, isLoading: loadingClashRunners } = useQuery<
    { id: number; runnerId: string; region: string; state: string; currentMatchId: number | null; lastHeartbeatAt: string | null; createdAt: string }[]
  >({
    queryKey: ["/api/admin/clash-runners"],
    enabled: isScout,
    refetchInterval: 10000,
  });

  const createRunnerTokenMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/clash-runner-tokens", {
        name: runnerTokenName,
        region: runnerTokenRegion,
      });
      return res.json();
    },
    onSuccess: (data) => {
      setNewRunnerToken(data.token);
      setRunnerTokenName("");
      setRunnerTokenRegion("na");
      queryClient.invalidateQueries({ queryKey: ["/api/admin/clash-runner-tokens"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create token", description: error.message, variant: "destructive" });
    },
  });

  const revokeRunnerTokenMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/admin/clash-runner-tokens/${id}/revoke`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/clash-runner-tokens"] });
      toast({ title: "Runner token revoked" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to revoke token", description: error.message, variant: "destructive" });
    },
  });

  const allProfiles = [
    ...(profilesData?.ownProfiles || []),
    ...(profilesData?.publicProfiles || []),
  ];

  // Derive auto-generated event name for quick 1v1
  const getAutoEventName = () => {
    if (eventMatchups.length === 1 && !eventName) {
      const row = eventMatchups[0];
      const agentA = allProfiles.find((p) => String(p.id) === row.agentAProfileId);
      const agentB = allProfiles.find((p) => String(p.id) === row.agentBProfileId);
      if (agentA && agentB) return `${agentA.name} vs ${agentB.name}`;
    }
    return eventName;
  };

  const createProfileMutation = useMutation({
    mutationFn: async () => {
      let steps: unknown[];
      try {
        steps = JSON.parse(profileSteps);
      } catch {
        throw new Error("Setup steps must be valid JSON");
      }
      const res = await apiRequest("POST", "/api/clash/profiles", {
        name: profileName,
        agentUrl: profileUrl,
        providerId: profileProvider || null,
        setupSteps: steps,
        visibility: profileVisibility,
      });
      return res.json();
    },
    onSuccess: () => {
      setProfileName(""); setProfileUrl(""); setProfileProvider(""); setProfileSteps("[]"); setProfileVisibility("private");
      setCreateProfileOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/clash/profiles"] });
      toast({ title: "Agent profile created" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create profile", description: error.message, variant: "destructive" });
    },
  });

  const deleteProfileMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/clash/profiles/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clash/profiles"] });
      toast({ title: "Profile deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete", description: error.message, variant: "destructive" });
    },
  });

  const createEventMutation = useMutation({
    mutationFn: async () => {
      const name = getAutoEventName();
      const res = await apiRequest("POST", "/api/clash/events", {
        name,
        region: eventRegion,
        scheduledAt: eventScheduledAt || undefined,
        matchups: eventMatchups.map((m) => ({
          agentAProfileId: parseInt(m.agentAProfileId),
          agentBProfileId: parseInt(m.agentBProfileId),
          topic: m.topic,
        })),
      });
      return res.json();
    },
    onSuccess: () => {
      setEventName("");
      setEventRegion("na");
      setEventScheduledAt("");
      setEventMatchups([{ agentAProfileId: "", agentBProfileId: "", topic: "" }]);
      setCreateEventOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/clash/events"] });
      toast({ title: "Event created" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create event", description: error.message, variant: "destructive" });
    },
  });

  const cancelEventMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/clash/events/${id}/cancel`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clash/events"] });
      toast({ title: "Event cancelled" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to cancel", description: error.message, variant: "destructive" });
    },
  });

  const startEventMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/clash/events/${id}/start`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clash/events"] });
      toast({ title: "Event started" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to start event", description: error.message, variant: "destructive" });
    },
  });

  const createScheduleMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/clash/schedules", {
        eventName: scheduleName,
        matchups: scheduleMatchups.map((m) => ({
          agentAProfileId: parseInt(m.agentAProfileId),
          agentBProfileId: parseInt(m.agentBProfileId),
          topic: m.topic || undefined,
        })),
        region: scheduleRegion,
        maxDurationSeconds: parseInt(scheduleDuration) || 300,
        scheduledAt: scheduleAt || undefined,
        cronExpression: scheduleCron || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      setScheduleName("");
      setScheduleMatchups([{ agentAProfileId: "", agentBProfileId: "", topic: "" }]);
      setScheduleRegion("na");
      setScheduleDuration("300");
      setScheduleAt("");
      setScheduleCron("");
      setCreateScheduleOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/clash/schedules"] });
      toast({ title: "Schedule created" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create schedule", description: error.message, variant: "destructive" });
    },
  });

  const toggleScheduleMutation = useMutation({
    mutationFn: async ({ id, isEnabled }: { id: number; isEnabled: boolean }) => {
      await apiRequest("PATCH", `/api/clash/schedules/${id}`, { isEnabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clash/schedules"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update schedule", description: error.message, variant: "destructive" });
    },
  });

  const deleteScheduleMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/clash/schedules/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clash/schedules"] });
      toast({ title: "Schedule deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete schedule", description: error.message, variant: "destructive" });
    },
  });

  // Matchup row helpers
  const updateEventMatchup = (index: number, field: keyof MatchupRow, value: string) => {
    setEventMatchups((rows) => rows.map((r, i) => i === index ? { ...r, [field]: value } : r));
  };

  const addEventMatchup = () => {
    setEventMatchups((rows) => [...rows, { agentAProfileId: "", agentBProfileId: "", topic: "" }]);
  };

  const removeEventMatchup = (index: number) => {
    setEventMatchups((rows) => rows.filter((_, i) => i !== index));
  };

  const updateScheduleMatchup = (index: number, field: keyof MatchupRow, value: string) => {
    setScheduleMatchups((rows) => rows.map((r, i) => i === index ? { ...r, [field]: value } : r));
  };

  const addScheduleMatchup = () => {
    setScheduleMatchups((rows) => [...rows, { agentAProfileId: "", agentBProfileId: "", topic: "" }]);
  };

  const removeScheduleMatchup = (index: number) => {
    setScheduleMatchups((rows) => rows.filter((_, i) => i !== index));
  };

  const eventMatchupsValid = eventMatchups.length > 0 && eventMatchups.every(
    (m) => m.agentAProfileId && m.agentBProfileId && m.agentAProfileId !== m.agentBProfileId
  );

  const scheduleMatchupsValid = scheduleMatchups.length > 0 && scheduleMatchups.every(
    (m) => m.agentAProfileId && m.agentBProfileId && m.agentAProfileId !== m.agentBProfileId
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Swords className="h-6 w-6" />
          Clash
        </h1>
        <p className="text-muted-foreground">
          Set up AI agent profiles and create head-to-head voice duels.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="profiles">Agent Profiles</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          {isScout && <TabsTrigger value="schedules">Schedules</TabsTrigger>}
          {isScout && <TabsTrigger value="runners">Runners</TabsTrigger>}
        </TabsList>

        {/* Agent Profiles Tab */}
        <TabsContent value="profiles">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <CardTitle>Agent Profiles</CardTitle>
                  <CardDescription className="mt-1.5">
                    Define AI agents by their web URL and browser setup steps.
                  </CardDescription>
                </div>
                <Dialog open={createProfileOpen} onOpenChange={setCreateProfileOpen}>
                  <DialogTrigger asChild>
                    <Button><Plus className="mr-2 h-4 w-4" />New Profile</Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-lg">
                    <DialogHeader>
                      <DialogTitle>Create Agent Profile</DialogTitle>
                      <DialogDescription>
                        Define an AI agent that can participate in clashes. Any web-accessible voice agent works.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label htmlFor="profile-name">Name</Label>
                        <Input id="profile-name" placeholder="My Voice Agent" value={profileName} onChange={(e) => setProfileName(e.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="profile-url">Agent URL</Label>
                        <Input id="profile-url" placeholder="https://my-agent.example.com" value={profileUrl} onChange={(e) => setProfileUrl(e.target.value)} />
                        <p className="text-xs text-muted-foreground">The web URL the browser visits to start a voice session.</p>
                      </div>
                      <div className="space-y-2">
                        <Label>Provider (optional)</Label>
                        <Select value={profileProvider} onValueChange={setProfileProvider}>
                          <SelectTrigger><SelectValue placeholder="Select provider" /></SelectTrigger>
                          <SelectContent>
                            {providers?.map((p) => (
                              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Visibility</Label>
                        <Select value={profileVisibility} onValueChange={setProfileVisibility}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="private">Private</SelectItem>
                            <SelectItem value="public">Public</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="profile-steps">Setup Steps (JSON)</Label>
                        <Textarea
                          id="profile-steps"
                          className="font-mono text-xs"
                          rows={6}
                          value={profileSteps}
                          onChange={(e) => setProfileSteps(e.target.value)}
                          placeholder={`[
  { "action": "click", "selector": "#start-button" },
  { "action": "fill", "selector": "#email", "value": "\${secrets.AGENT_EMAIL}" }
]`}
                        />
                        <p className="text-xs text-muted-foreground">
                          Browser automation steps. Use <code className="bg-muted px-1 rounded">{"${secrets.KEY}"}</code> for credentials.
                        </p>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button
                        onClick={() => createProfileMutation.mutate()}
                        disabled={createProfileMutation.isPending || !profileName || !profileUrl}
                      >
                        Create Profile
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {loadingProfiles ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
                </div>
              ) : profilesData?.ownProfiles && profilesData.ownProfiles.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>URL</TableHead>
                      <TableHead>Visibility</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {profilesData.ownProfiles.map((profile) => (
                      <TableRow key={profile.id}>
                        <TableCell className="font-medium">{profile.name}</TableCell>
                        <TableCell className="text-muted-foreground max-w-48 truncate">{profile.agentUrl}</TableCell>
                        <TableCell>
                          <Badge variant={profile.visibility === "public" ? "default" : "outline"}>
                            {profile.visibility}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{formatSmartTimestamp(profile.createdAt)}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => deleteProfileMutation.mutate(profile.id)}
                            disabled={deleteProfileMutation.isPending}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  No agent profiles yet. Create one to get started with clashes.
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Events Tab */}
        <TabsContent value="events">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <CardTitle>Events</CardTitle>
                  <CardDescription className="mt-1.5">
                    Clash events you've created. Each event can contain one or more matchups.
                  </CardDescription>
                </div>
                <Dialog open={createEventOpen} onOpenChange={setCreateEventOpen}>
                  <DialogTrigger asChild>
                    <Button disabled={allProfiles.length < 2}>
                      <Plus className="mr-2 h-4 w-4" />
                      New Event
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-xl">
                    <DialogHeader>
                      <DialogTitle>Create Event</DialogTitle>
                      <DialogDescription>
                        Create a clash event with one or more agent matchups.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label>Event Name</Label>
                        <Input
                          placeholder={
                            eventMatchups.length === 1
                              ? (() => {
                                  const agentA = allProfiles.find((p) => String(p.id) === eventMatchups[0].agentAProfileId);
                                  const agentB = allProfiles.find((p) => String(p.id) === eventMatchups[0].agentBProfileId);
                                  return agentA && agentB ? `${agentA.name} vs ${agentB.name}` : "Auto-generated from matchup";
                                })()
                              : "Event name"
                          }
                          value={eventName}
                          onChange={(e) => setEventName(e.target.value)}
                        />
                        {eventMatchups.length === 1 && !eventName && (
                          <p className="text-xs text-muted-foreground">Leave blank to auto-generate from the matchup agents.</p>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Region</Label>
                          <Select value={eventRegion} onValueChange={setEventRegion}>
                            <SelectTrigger><SelectValue placeholder="Select region" /></SelectTrigger>
                            <SelectContent>
                              {REGIONS.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>Scheduled At (optional)</Label>
                          <Input type="datetime-local" value={eventScheduledAt} onChange={(e) => setEventScheduledAt(e.target.value)} />
                        </div>
                      </div>
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label>Matchups</Label>
                          <Button type="button" variant="outline" size="sm" onClick={addEventMatchup}>
                            <Plus className="h-3 w-3 mr-1" />
                            Add matchup
                          </Button>
                        </div>
                        {eventMatchups.map((row, index) => (
                          <div key={index} className="border rounded-md p-3 space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-medium text-muted-foreground">Matchup {index + 1}</span>
                              {eventMatchups.length > 1 && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => removeEventMatchup(index)}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              )}
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div className="space-y-1">
                                <Label className="text-xs">Agent A</Label>
                                <Select value={row.agentAProfileId} onValueChange={(v) => updateEventMatchup(index, "agentAProfileId", v)}>
                                  <SelectTrigger><SelectValue placeholder="Select agent" /></SelectTrigger>
                                  <SelectContent>
                                    {allProfiles.map((p) => (
                                      <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="space-y-1">
                                <Label className="text-xs">Agent B</Label>
                                <Select value={row.agentBProfileId} onValueChange={(v) => updateEventMatchup(index, "agentBProfileId", v)}>
                                  <SelectTrigger><SelectValue placeholder="Select agent" /></SelectTrigger>
                                  <SelectContent>
                                    {allProfiles
                                      .filter((p) => String(p.id) !== row.agentAProfileId)
                                      .map((p) => (
                                        <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                                      ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Topic</Label>
                              <Input
                                placeholder="Debate topic or opening prompt"
                                value={row.topic}
                                onChange={(e) => updateEventMatchup(index, "topic", e.target.value)}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <DialogFooter>
                      <Button
                        onClick={() => createEventMutation.mutate()}
                        disabled={
                          createEventMutation.isPending ||
                          !eventRegion ||
                          !eventMatchupsValid ||
                          (!eventName && !(eventMatchups.length === 1 && eventMatchups[0].agentAProfileId && eventMatchups[0].agentBProfileId))
                        }
                      >
                        Create Event
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {loadingEvents ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
                </div>
              ) : events && events.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Region</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Scheduled</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.map((event) => (
                      <TableRow key={event.id}>
                        <TableCell className="font-medium">{event.name}</TableCell>
                        <TableCell>{formatRegion(event.region)}</TableCell>
                        <TableCell>
                          <Badge className={statusColors[event.status] || ""} variant="outline">
                            {event.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {event.scheduledAt ? formatSmartTimestamp(event.scheduledAt) : "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{formatSmartTimestamp(event.createdAt)}</TableCell>
                        <TableCell className="text-right flex items-center justify-end gap-1">
                          {event.status === "upcoming" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => startEventMutation.mutate(event.id)}
                              disabled={startEventMutation.isPending}
                            >
                              <Play className="h-4 w-4 mr-1" />
                              Start
                            </Button>
                          )}
                          {(event.status === "upcoming" || event.status === "live") && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => cancelEventMutation.mutate(event.id)}
                              disabled={cancelEventMutation.isPending}
                            >
                              <X className="h-4 w-4 mr-1" />
                              Cancel
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  {allProfiles.length < 2
                    ? "Create at least 2 agent profiles to start a clash event."
                    : "No events yet. Create one to get started."}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Schedules Tab (Scout/Principal only) */}
        {isScout && (
          <TabsContent value="schedules">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Calendar className="h-5 w-5" />
                      Schedules
                    </CardTitle>
                    <CardDescription className="mt-1.5">
                      Schedule clashes to run at a specific time or on a recurring basis.
                    </CardDescription>
                  </div>
                  <Dialog open={createScheduleOpen} onOpenChange={setCreateScheduleOpen}>
                    <DialogTrigger asChild>
                      <Button disabled={allProfiles.length < 2}>
                        <Plus className="mr-2 h-4 w-4" />
                        New Schedule
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-xl">
                      <DialogHeader>
                        <DialogTitle>Create Clash Schedule</DialogTitle>
                        <DialogDescription>
                          Schedule a clash for a specific time, or set a recurring cron schedule.
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4 py-4">
                        <div className="space-y-2">
                          <Label>Event Name</Label>
                          <Input placeholder="Weekly AI Showdown" value={scheduleName} onChange={(e) => setScheduleName(e.target.value)} />
                        </div>
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <Label>Matchups</Label>
                            <Button type="button" variant="outline" size="sm" onClick={addScheduleMatchup}>
                              <Plus className="h-3 w-3 mr-1" />
                              Add matchup
                            </Button>
                          </div>
                          {scheduleMatchups.map((row, index) => (
                            <div key={index} className="border rounded-md p-3 space-y-3">
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-medium text-muted-foreground">Matchup {index + 1}</span>
                                {scheduleMatchups.length > 1 && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => removeScheduleMatchup(index)}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                )}
                              </div>
                              <div className="grid grid-cols-2 gap-3">
                                <div className="space-y-1">
                                  <Label className="text-xs">Agent A</Label>
                                  <Select value={row.agentAProfileId} onValueChange={(v) => updateScheduleMatchup(index, "agentAProfileId", v)}>
                                    <SelectTrigger><SelectValue placeholder="Select agent" /></SelectTrigger>
                                    <SelectContent>
                                      {allProfiles.map((p) => (
                                        <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs">Agent B</Label>
                                  <Select value={row.agentBProfileId} onValueChange={(v) => updateScheduleMatchup(index, "agentBProfileId", v)}>
                                    <SelectTrigger><SelectValue placeholder="Select agent" /></SelectTrigger>
                                    <SelectContent>
                                      {allProfiles
                                        .filter((p) => String(p.id) !== row.agentAProfileId)
                                        .map((p) => (
                                          <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                                        ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              </div>
                              <div className="space-y-1">
                                <Label className="text-xs">Topic (optional)</Label>
                                <Input
                                  placeholder="Best approach to customer service"
                                  value={row.topic}
                                  onChange={(e) => updateScheduleMatchup(index, "topic", e.target.value)}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label>Region</Label>
                            <Select value={scheduleRegion} onValueChange={setScheduleRegion}>
                              <SelectTrigger><SelectValue placeholder="Select region" /></SelectTrigger>
                              <SelectContent>
                                {REGIONS.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label>Max Duration (sec)</Label>
                            <Input type="number" value={scheduleDuration} onChange={(e) => setScheduleDuration(e.target.value)} min={60} max={600} />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label>Scheduled Date/Time</Label>
                          <Input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
                          <p className="text-xs text-muted-foreground">When to run the clash. Leave empty if using a cron expression.</p>
                        </div>
                        <div className="space-y-2">
                          <Label>Cron Expression (optional, for recurring)</Label>
                          <Input placeholder="0 18 * * 5" value={scheduleCron} onChange={(e) => setScheduleCron(e.target.value)} />
                          <p className="text-xs text-muted-foreground">e.g. <code className="bg-muted px-1 rounded">0 18 * * 5</code> = every Friday at 6 PM UTC</p>
                        </div>
                      </div>
                      <DialogFooter>
                        <Button
                          onClick={() => createScheduleMutation.mutate()}
                          disabled={createScheduleMutation.isPending || !scheduleName || !scheduleRegion || !scheduleMatchupsValid || (!scheduleAt && !scheduleCron)}
                        >
                          Create Schedule
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
              </CardHeader>
              <CardContent>
                {loadingSchedules ? (
                  <div className="space-y-4">
                    {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
                  </div>
                ) : schedules && schedules.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Region</TableHead>
                        <TableHead>Matchups</TableHead>
                        <TableHead>Schedule</TableHead>
                        <TableHead>Last Run</TableHead>
                        <TableHead>Enabled</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {schedules.map((schedule) => (
                        <TableRow key={schedule.id}>
                          <TableCell className="font-medium">{schedule.eventName}</TableCell>
                          <TableCell>{formatRegion(schedule.region)}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">{schedule.matchups?.length ?? 0}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {schedule.cronExpression ? (
                              <code className="bg-muted px-1 rounded">{schedule.cronExpression}</code>
                            ) : schedule.scheduledAt ? (
                              formatSmartTimestamp(schedule.scheduledAt)
                            ) : "—"}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {schedule.lastRunAt ? formatSmartTimestamp(schedule.lastRunAt) : "Never"}
                          </TableCell>
                          <TableCell>
                            <Switch
                              checked={schedule.isEnabled}
                              onCheckedChange={(checked) =>
                                toggleScheduleMutation.mutate({ id: schedule.id, isEnabled: checked })
                              }
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => deleteScheduleMutation.mutate(schedule.id)}
                              disabled={deleteScheduleMutation.isPending}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    No schedules yet. Create one to automate recurring clashes.
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* Runners Tab (scout/admin) */}
        {isScout && (
          <TabsContent value="runners" className="space-y-4">
            {/* Status summary */}
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Idle</CardTitle>
                  <Server className="h-4 w-4 text-green-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-green-500">
                    {clashRunners?.filter(r => r.state === "idle").length ?? 0}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Running</CardTitle>
                  <Server className="h-4 w-4 text-yellow-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-yellow-500">
                    {clashRunners?.filter(r => r.state === "running" || r.state === "assigned").length ?? 0}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Draining</CardTitle>
                  <Server className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-muted-foreground">
                    {clashRunners?.filter(r => r.state === "draining").length ?? 0}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Connected runners */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Server className="h-4 w-4" />Connected Runners</CardTitle>
                <CardDescription>Runners currently registered in the pool.</CardDescription>
              </CardHeader>
              <CardContent>
                {loadingClashRunners ? (
                  <Skeleton className="h-24 w-full" />
                ) : clashRunners && clashRunners.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Runner ID</TableHead>
                        <TableHead>Region</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>Current Match</TableHead>
                        <TableHead>Last Heartbeat</TableHead>
                        <TableHead>Registered</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {clashRunners.map(r => (
                        <TableRow key={r.id}>
                          <TableCell className="font-mono text-xs">{r.runnerId}</TableCell>
                          <TableCell><Badge variant="outline">{formatRegion(r.region)}</Badge></TableCell>
                          <TableCell>
                            <Badge className={
                              r.state === "idle" ? "bg-green-500/10 text-green-500" :
                              r.state === "assigned" ? "bg-blue-500/10 text-blue-500" :
                              r.state === "running" ? "bg-yellow-500/10 text-yellow-500" :
                              "bg-muted text-muted-foreground"
                            }>
                              {r.state.charAt(0).toUpperCase() + r.state.slice(1)}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">{r.currentMatchId ? `#${r.currentMatchId}` : "—"}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">{r.lastHeartbeatAt ? formatSmartTimestamp(r.lastHeartbeatAt) : "Never"}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">{formatSmartTimestamp(r.createdAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <div className="text-center text-muted-foreground py-8 text-sm">
                    No runners connected. Deploy a runner container with a valid token.
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Runner Tokens (admin only) */}
            {isAdmin && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">Create Runner</CardTitle>
                      <CardDescription>Issue tokens for vox-clash-runner deployments. Each runner needs a token to register.</CardDescription>
                    </div>
                    <Dialog open={createRunnerTokenOpen} onOpenChange={(open) => { setCreateRunnerTokenOpen(open); if (!open) setNewRunnerToken(null); }}>
                      <DialogTrigger asChild>
                        <Button size="sm"><Plus className="h-4 w-4 mr-1" />New Runner</Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Launch the Runner</DialogTitle>
                          <DialogDescription>Create a new token for clash runner registration.</DialogDescription>
                        </DialogHeader>
                        {newRunnerToken ? (
                          <>
                            <div className="space-y-4 py-4">
                              <div className="space-y-2">
                                <Label>Runner Token</Label>
                                <div className="flex gap-2">
                                  <Input value={newRunnerToken} readOnly className="font-mono text-sm" />
                                  <Button size="icon" variant="outline" onClick={() => { navigator.clipboard.writeText(newRunnerToken); setCopiedToken(true); setTimeout(() => setCopiedToken(false), 2000); }}>
                                    {copiedToken ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                                  </Button>
                                </div>
                                <p className="text-xs text-muted-foreground">Copy this token now. It won't be shown again.</p>
                              </div>
                              <div className="p-3 bg-muted rounded-md space-y-3">
                                <div>
                                  <p className="text-sm font-medium mb-1">Single process:</p>
                                  <code className="text-xs break-all">{`RUNNER_TOKEN=${newRunnerToken} VOX_SERVER=${window.location.origin} node clash-runner.js`}</code>
                                </div>
                                <div>
                                  <p className="text-sm font-medium mb-1">Docker:</p>
                                  <code className="text-xs break-all">{`docker run -e RUNNER_TOKEN=${newRunnerToken} -e VOX_SERVER=${window.location.origin} \\\n  ghcr.io/agora-build/vox-clash-runner`}</code>
                                </div>
                              </div>
                            </div>
                            <DialogFooter>
                              <Button variant="outline" onClick={() => { setCreateRunnerTokenOpen(false); setNewRunnerToken(null); }}>Done</Button>
                            </DialogFooter>
                          </>
                        ) : (
                          <div className="space-y-4">
                            <div className="space-y-2">
                              <Label>Name</Label>
                              <Input placeholder="e.g. NA Runner 1" value={runnerTokenName} onChange={(e) => setRunnerTokenName(e.target.value)} />
                            </div>
                            <div className="space-y-2">
                              <Label>Region</Label>
                              <Select value={runnerTokenRegion} onValueChange={setRunnerTokenRegion}>
                                <SelectTrigger><SelectValue placeholder="Select region" /></SelectTrigger>
                                <SelectContent>
                                  {REGIONS.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            </div>
                            <DialogFooter>
                              <Button variant="outline" onClick={() => setCreateRunnerTokenOpen(false)}>Cancel</Button>
                              <Button onClick={() => createRunnerTokenMutation.mutate()} disabled={!runnerTokenName || !runnerTokenRegion || createRunnerTokenMutation.isPending}>
                                {createRunnerTokenMutation.isPending ? "Creating..." : "Create Runner"}
                              </Button>
                            </DialogFooter>
                          </div>
                        )}
                      </DialogContent>
                    </Dialog>
                  </div>
                </CardHeader>
                <CardContent>
                  {loadingRunnerTokens ? (
                    <Skeleton className="h-24 w-full" />
                  ) : runnerTokens && runnerTokens.length > 0 ? (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Region</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Last Used</TableHead>
                          <TableHead>Created</TableHead>
                          <TableHead />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {runnerTokens.map((t) => (
                          <TableRow key={t.id}>
                            <TableCell className="font-medium">{t.name}</TableCell>
                            <TableCell><Badge variant="outline">{formatRegion(t.region)}</Badge></TableCell>
                            <TableCell>
                              <Badge className={t.isRevoked ? "bg-muted text-muted-foreground" : "bg-green-500/10 text-green-500"}>
                                {t.isRevoked ? "Revoked" : "Active"}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-muted-foreground text-sm">{t.lastUsedAt ? formatSmartTimestamp(t.lastUsedAt) : "Never"}</TableCell>
                            <TableCell className="text-muted-foreground text-sm">{formatSmartTimestamp(t.createdAt)}</TableCell>
                            <TableCell>
                              {!t.isRevoked && (
                                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => revokeRunnerTokenMutation.mutate(t.id)} disabled={revokeRunnerTokenMutation.isPending}>
                                  <X className="h-4 w-4 mr-1" />Revoke
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <div className="text-center text-muted-foreground py-8 text-sm">
                      No runner tokens yet. Create one to deploy a clash runner.
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
