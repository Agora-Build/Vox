import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Server, MapPin, Activity, Clock, Eye, EyeOff, Plus, Key, Copy, Check, Ban, Lock } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { formatSmartTimestamp, formatSite } from "@/lib/utils";
import { useRegionLocationOptions } from "@/hooks/use-regions";

interface AuthStatus {
  initialized: boolean;
  user: {
    id: string;
    username: string;
    email: string;
    plan: string;
    isAdmin: boolean;
    organizationId: number | null;
  } | null;
}

interface EvalAgent {
  id: number;
  name: string;
  siteId: string;
  state: "idle" | "offline" | "occupied";
  dispatchTier: "private" | "team" | "public" | "shared";
  metadata: Record<string, string> | null;
  lastSeenAt: string | null;
  createdAt: string;
}

interface EvalAgentToken {
  id: number;
  name: string;
  token: string;
  siteId: string;
  dispatchTier: "private" | "team" | "public" | "shared";
  isRevoked: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}


function getTierBadge(tier: string) {
  const map: Record<string, { label: string; icon: ReactNode }> = {
    public: { label: "Public", icon: <Eye className="h-3 w-3" /> },
    private: { label: "Private", icon: <EyeOff className="h-3 w-3" /> },
    team: { label: "Team", icon: <Server className="h-3 w-3" /> },
    shared: { label: "Shared", icon: <Key className="h-3 w-3" /> },
  };
  const m = map[tier] ?? map.private;
  return (
    <Badge variant={tier === "public" ? "outline" : "secondary"} className="gap-1">
      {m.icon}
      {m.label}
    </Badge>
  );
}

function getStateBadge(state: string) {
  switch (state) {
    case "idle":
      return <Badge className="bg-green-500">Idle</Badge>;
    case "occupied":
      return <Badge className="bg-yellow-500">Occupied</Badge>;
    case "offline":
    default:
      return <Badge variant="secondary">Offline</Badge>;
  }
}

function formatLastSeen(lastSeen: string | null) {
  if (!lastSeen) return "Never";
  return formatSmartTimestamp(lastSeen);
}

export default function ConsoleEvalAgents() {
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [region, setRegion] = useState("");
  const [dispatchTier, setDispatchTier] = useState<string>("private");
  const [pricePerUnit, setPricePerUnit] = useState<string>("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [newRegion, setNewRegion] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { options: regionLocations, isLoading: regionsLoading } = useRegionLocationOptions();

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const user = authStatus?.user;
  const isAdmin = user?.isAdmin || false;
  const isBasic = !isAdmin && user?.plan === "basic";
  const canCreateTokens = !isBasic;
  const hasOrg = !!user?.organizationId;

  // Admins default to public (today's behavior); everyone else to private.
  useEffect(() => {
    setDispatchTier(isAdmin ? "public" : "private");
  }, [isAdmin]);

  const { data: agents, isLoading: agentsLoading } = useQuery<EvalAgent[]>({
    queryKey: ["/api/eval-agents"],
    refetchInterval: 30000,
  });

  const { data: tokens, isLoading: tokensLoading } = useQuery<EvalAgentToken[]>({
    queryKey: ["/api/eval-agent-tokens"],
    enabled: canCreateTokens,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { name, regionLocationBaseId: region, dispatchTier };
      if (dispatchTier === "shared") {
        body.pricePerUnit = Number(pricePerUnit);
      }
      const res = await apiRequest("POST", "/api/eval-agent-tokens", body);
      return res.json();
    },
    onSuccess: (data) => {
      setNewToken(data.token);
      setNewRegion(data.siteId);
      setName("");
      setRegion("");
      setDispatchTier(isAdmin ? "public" : "private");
      setPricePerUnit("");
      queryClient.invalidateQueries({ queryKey: ["/api/eval-agent-tokens"] });
      queryClient.invalidateQueries({ queryKey: ["/api/region-locations"] });
      toast({ title: "Eval agent token created" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create token", description: error.message, variant: "destructive" });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (tokenId: number) => {
      const res = await apiRequest("POST", `/api/eval-agent-tokens/${tokenId}/revoke`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/eval-agent-tokens"] });
      toast({ title: "Token revoked" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to revoke token", description: error.message, variant: "destructive" });
    },
  });

  const handleCopyToken = () => {
    if (newToken) {
      navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleCloseDialog = () => {
    setCreateOpen(false);
    setNewToken(null);
    setNewRegion(null);
    setCopied(false);
  };

  const idleCount = agents?.filter(a => a.state === "idle").length || 0;
  const occupiedCount = agents?.filter(a => a.state === "occupied").length || 0;
  const offlineCount = agents?.filter(a => a.state === "offline").length || 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Eval Agents</h1>
        <p className="text-muted-foreground">View registered evaluation agents and manage your own agent tokens</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Idle</CardTitle>
            <Activity className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-500">{idleCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Occupied</CardTitle>
            <Activity className="h-4 w-4 text-yellow-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-500">{occupiedCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Offline</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-muted-foreground">{offlineCount}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            Registered Eval Agents
          </CardTitle>
          <CardDescription>
            Eval agents that have registered with the system. Agents fetch and execute evaluation jobs for their assigned region.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {agentsLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : agents && agents.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Build</TableHead>
                  <TableHead>Last Seen</TableHead>
                  <TableHead>Registered</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((agent) => (
                  <TableRow key={agent.id}>
                    <TableCell className="font-medium">{agent.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="gap-1">
                        <MapPin className="h-3 w-3" />
                        {formatSite(agent.siteId)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {getTierBadge(agent.dispatchTier)}
                    </TableCell>
                    <TableCell>
                      {getStateBadge(agent.state)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs font-mono">
                      {agent.metadata?.buildTag ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-default underline decoration-dotted underline-offset-4 decoration-muted-foreground/40">
                                {agent.metadata.buildDate && agent.metadata.buildDate !== 'unknown'
                                  ? agent.metadata.buildDate.split('T')[0]
                                  : agent.metadata.buildTag}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" className="text-xs font-mono space-y-1">
                              <div>Build: {agent.metadata.buildTag}</div>
                              {agent.metadata.buildDate && agent.metadata.buildDate !== 'unknown' && (
                                <div>Date: {agent.metadata.buildDate}</div>
                              )}
                              {agent.metadata.framework && (
                                <div>Framework: {agent.metadata.framework}</div>
                              )}
                              {agent.metadata.frameworkVersion && (
                                <div>Version: {agent.metadata.frameworkVersion}</div>
                              )}
                              {agent.metadata.aevalDataCommit && (
                                <div>Data: {agent.metadata.aevalDataCommit}{agent.metadata.aevalDataDate ? ` (${agent.metadata.aevalDataDate})` : ''}</div>
                              )}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : '-'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatLastSeen(agent.lastSeenAt)}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(agent.createdAt).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No eval agents registered yet. Agents will appear here once they connect using a valid token.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Manage Agents section */}
      <Card className={isBasic ? "opacity-60" : undefined}>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Key className="h-5 w-5" />
                Manage Agents
                <Badge variant="secondary" className="gap-1 text-xs font-normal">
                  <Lock className="h-3 w-3" />
                  Premium+
                </Badge>
              </CardTitle>
              <CardDescription className="mt-1.5">
                {isBasic
                  ? "Upgrade to Premium or above to create your own eval agent tokens and run private evaluations."
                  : isAdmin
                    ? "Create and manage eval agent tokens. Tokens allow agents to register and fetch jobs."
                    : "Create eval agent tokens to run your own evaluations. Pick a dispatch tier — private, team, or shared — when you create one. Private-token results appear in your My Evals dashboard."}
              </CardDescription>
            </div>
            {canCreateTokens && (
              <Dialog open={createOpen} onOpenChange={(open) => {
                if (!open) handleCloseDialog();
                else setCreateOpen(true);
              }}>
                <DialogTrigger asChild>
                  <Button>
                    <Plus className="mr-2 h-4 w-4" />
                    Create Agent
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Create Agent</DialogTitle>
                    <DialogDescription>
                      {isAdmin
                        ? "Create a new token for eval agent registration."
                        : "Create a token for your eval agent and choose its dispatch tier below."}
                    </DialogDescription>
                  </DialogHeader>
                  {!newToken ? (
                    <>
                      <div className="space-y-4 py-4">
                        <div className="space-y-2">
                          <Label htmlFor="token-name">Name</Label>
                          <Input
                            id="token-name"
                            placeholder="NA Agent 1"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="token-region">City</Label>
                          <Select value={region} onValueChange={setRegion}>
                            <SelectTrigger>
                              <SelectValue placeholder="Select city" />
                            </SelectTrigger>
                            <SelectContent>
                              {regionLocations.map((r) => (
                                <SelectItem key={r.value} value={r.value}>
                                  {r.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="token-tier">Dispatch tier</Label>
                          <Select value={dispatchTier} onValueChange={setDispatchTier}>
                            <SelectTrigger>
                              <SelectValue placeholder="Select tier" />
                            </SelectTrigger>
                            <SelectContent>
                              {isAdmin && <SelectItem value="public">Public</SelectItem>}
                              <SelectItem value="private">Private</SelectItem>
                              {hasOrg && <SelectItem value="team">Team</SelectItem>}
                              <SelectItem value="shared">Shared</SelectItem>
                            </SelectContent>
                          </Select>
                          {dispatchTier === "team" && !hasOrg && (
                            <p className="text-xs text-destructive">Team tier requires organization membership.</p>
                          )}
                        </div>
                        {dispatchTier === "shared" && (
                          <div className="space-y-2">
                            <Label htmlFor="token-price">Price per eval (credits)</Label>
                            <Input
                              id="token-price"
                              type="number"
                              min={1}
                              placeholder="e.g. 5"
                              value={pricePerUnit}
                              onChange={(e) => setPricePerUnit(e.target.value)}
                            />
                          </div>
                        )}
                      </div>
                      <DialogFooter>
                        <Button
                          onClick={() => createMutation.mutate()}
                          disabled={
                            createMutation.isPending || regionsLoading || !name || !region ||
                            (dispatchTier === "shared" && !(Number(pricePerUnit) > 0))
                          }
                        >
                          Create Agent
                        </Button>
                      </DialogFooter>
                    </>
                  ) : (
                    <>
                      <div className="space-y-4 py-4">
                        {newRegion && (
                          <div className="flex items-center justify-between border px-3 py-2">
                            <span className="text-sm text-muted-foreground">Assigned site</span>
                            <Badge variant="secondary" className="font-mono">{newRegion}</Badge>
                          </div>
                        )}
                        <div className="space-y-2">
                          <Label>Agent Token</Label>
                          <div className="flex gap-2">
                            <Input
                              value={newToken}
                              readOnly
                              className="font-mono text-sm"
                            />
                            <Button
                              size="icon"
                              variant="outline"
                              onClick={handleCopyToken}
                            >
                              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                            </Button>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Copy this token now. It won't be shown again.
                          </p>
                        </div>
                        <div className="p-3 bg-muted rounded-md space-y-3">
                          <div>
                            <p className="text-sm font-medium mb-1">Single process:</p>
                            <code className="text-xs break-all">./vox_eval_agentd --up --token={newToken}</code>
                          </div>
                          <div>
                            <p className="text-sm font-medium mb-1">Docker:</p>
                            <code className="text-xs break-all">docker run -e AGENT_TOKEN={newToken} -e VOX_SERVER={window.location.origin} ghcr.io/agora-build/vox-eval-agentd</code>
                          </div>
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant="outline" onClick={handleCloseDialog}>
                          Done
                        </Button>
                      </DialogFooter>
                    </>
                  )}
                </DialogContent>
              </Dialog>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isBasic ? (
            <div className="text-center py-8 text-muted-foreground">
              This feature is available for Premium, Principal, and Fellow users.
            </div>
          ) : tokensLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : tokens && tokens.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Used</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((token) => (
                  <TableRow key={token.id}>
                    <TableCell className="font-medium">{token.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="gap-1">
                        <MapPin className="h-3 w-3" />
                        {formatSite(token.siteId)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {getTierBadge(token.dispatchTier)}
                    </TableCell>
                    <TableCell>
                      {token.isRevoked ? (
                        <Badge variant="destructive">Revoked</Badge>
                      ) : (
                        <Badge className="bg-blue-500">Active</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {token.lastUsedAt
                        ? new Date(token.lastUsedAt).toLocaleDateString()
                        : "Never"
                      }
                    </TableCell>
                    <TableCell className="text-right">
                      {!token.isRevoked && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => revokeMutation.mutate(token.id)}
                          disabled={revokeMutation.isPending}
                        >
                          <Ban className="h-4 w-4 mr-1" />
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No eval agent tokens yet. Create a token to register your own eval agent.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
