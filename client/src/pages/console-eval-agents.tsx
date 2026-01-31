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
import { Server, MapPin, Activity, Clock, Eye, EyeOff, Plus, Key, Copy, Check, Ban, Lock } from "lucide-react";
import { useState } from "react";

interface AuthStatus {
  initialized: boolean;
  user: {
    id: string;
    username: string;
    email: string;
    plan: string;
    isAdmin: boolean;
  } | null;
}

interface EvalAgent {
  id: number;
  name: string;
  region: string;
  state: "idle" | "offline" | "occupied";
  visibility: "public" | "private";
  lastHeartbeat: string | null;
  createdAt: string;
}

interface EvalAgentToken {
  id: number;
  name: string;
  token: string;
  region: string;
  visibility: "public" | "private";
  isRevoked: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

const REGIONS = [
  { value: "na", label: "North America" },
  { value: "apac", label: "Asia Pacific" },
  { value: "eu", label: "Europe" },
];

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

function formatLastSeen(lastHeartbeat: string | null) {
  if (!lastHeartbeat) return "Never";

  const date = new Date(lastHeartbeat);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  return date.toLocaleDateString();
}

export default function ConsoleEvalAgents() {
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [region, setRegion] = useState("");
  const [visibility, setVisibility] = useState<string>("public");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const user = authStatus?.user;
  const isAdmin = user?.isAdmin || false;
  const isBasic = !isAdmin && user?.plan === "basic";
  const canCreateTokens = !isBasic;

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
      const body: Record<string, string> = { name, region };
      if (isAdmin) {
        body.visibility = visibility;
      }
      const res = await apiRequest("POST", "/api/eval-agent-tokens", body);
      return res.json();
    },
    onSuccess: (data) => {
      setNewToken(data.token);
      setName("");
      setRegion("");
      setVisibility("public");
      queryClient.invalidateQueries({ queryKey: ["/api/eval-agent-tokens"] });
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
                  <TableHead>Visibility</TableHead>
                  <TableHead>State</TableHead>
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
                        {REGIONS.find(r => r.value === agent.region)?.label || agent.region}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={agent.visibility === "public" ? "outline" : "secondary"} className="gap-1">
                        {agent.visibility === "public" ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                        {agent.visibility === "public" ? "Public" : "Private"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {getStateBadge(agent.state)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatLastSeen(agent.lastHeartbeat)}
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

      {/* Create Your Own Agents section */}
      <Card className={isBasic ? "opacity-60" : undefined}>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Key className="h-5 w-5" />
                Create Your Own Agents
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
                    : "Create private eval agent tokens to run your own evaluations. Results from private tokens appear in your My Evals dashboard."}
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
                        : "Create a private token for your eval agent. Private tokens produce results visible only in your evals."}
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
                          <Label htmlFor="token-region">Region</Label>
                          <Select value={region} onValueChange={setRegion}>
                            <SelectTrigger>
                              <SelectValue placeholder="Select region" />
                            </SelectTrigger>
                            <SelectContent>
                              {REGIONS.map((r) => (
                                <SelectItem key={r.value} value={r.value}>
                                  {r.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        {isAdmin && (
                          <div className="space-y-2">
                            <Label htmlFor="token-visibility">Visibility</Label>
                            <Select value={visibility} onValueChange={setVisibility}>
                              <SelectTrigger>
                                <SelectValue placeholder="Select visibility" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="public">Public</SelectItem>
                                <SelectItem value="private">Private</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                        {!isAdmin && (
                          <p className="text-xs text-muted-foreground">
                            Non-admin created agents are always private.
                          </p>
                        )}
                      </div>
                      <DialogFooter>
                        <Button
                          onClick={() => createMutation.mutate()}
                          disabled={createMutation.isPending || !name || !region}
                        >
                          Create Agent
                        </Button>
                      </DialogFooter>
                    </>
                  ) : (
                    <>
                      <div className="space-y-4 py-4">
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
                            <code className="text-xs break-all">docker run -e VOX_TOKEN={newToken} -e VOX_SERVER=http://localhost:5000 ghcr.io/agora-build/vox-eval-agentd</code>
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
                  <TableHead>Visibility</TableHead>
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
                        {REGIONS.find(r => r.value === token.region)?.label || token.region}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={token.visibility === "public" ? "outline" : "secondary"} className="gap-1">
                        {token.visibility === "public" ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                        {token.visibility === "public" ? "Public" : "Private"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {token.isRevoked ? (
                        <Badge variant="destructive">Revoked</Badge>
                      ) : (
                        <Badge variant="outline">Active</Badge>
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
