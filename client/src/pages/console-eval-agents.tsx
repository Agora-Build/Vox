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
import { Server, MapPin, Activity, Clock, Eye, EyeOff, Plus, Key, Copy, Check, Ban, Lock, Phone, AudioLines, Pencil } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { formatSmartTimestamp } from "@/lib/utils";
import { useRegionLocationOptions } from "@/hooks/use-regions";
import { TagInput } from "@/components/tag-input";
import { formatTag, explainSystemReason, type Tag } from "@shared/tags";
import { ACCESS_TEXT, UNKNOWN_ACCESS_TEXT } from "@/lib/access-text";

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
  siteId: string | null;
  siteLabel: string | null;
  state: "idle" | "offline" | "occupied";
  dispatchTier: "private" | "team" | "public" | "shared";
  metadata: Record<string, string> | null;
  lastSeenAt: string | null;
  createdAt: string;
  region?: string | null;
  locationTrust?: string;
  /** What the agent last reported on its heartbeat: "phone" (its DialF check passes), "analyze" (aeval runs there). */
  capabilities?: string[];
  /** Hand-set network tags (its operator's). */
  tags?: Tag[];
  /** The link type the agent detected on its host (wifi/ethernet/cellular/satellite), or null. */
  linkType?: string | null;
  /** Server-decided: this user is the agent's operator and may edit its tags. */
  canEditTags?: boolean;
  /** System-only: lastmile | datacenter | unknown (null = not checked yet), and the classifier's reason. */
  accessClass?: string | null;
  accessReason?: string | null;
  /** Phone agents: our SIM's carrier slug, when the SIM and a lookup of its number agree. */
  simCarrier?: string | null;
}

/**
 * An agent's network tags: the link type it detected (marked "detected") and
 * the tags its operator set by hand. A hand-set link that differs from the
 * detected one shows both — results on Mainline use the detected one. Only the
 * operator gets the edit button (the server's canEditTags), so it never 403s.
 */
function AgentTagsCell({ agent }: { agent: EvalAgent }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Tag[]>([]);
  const tags = agent.tags ?? [];
  const save = useMutation({
    mutationFn: async () => (await apiRequest("PATCH", `/api/eval-agents/${agent.id}/tags`, { tags: draft })).json(),
    onSuccess: () => {
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/eval-agents"] });
      toast({ title: "Tags saved", description: "New jobs this agent takes carry them; past results keep theirs." });
    },
    onError: (error: Error) => toast({ title: "Couldn't save the tags", description: error.message, variant: "destructive" }),
  });
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid={`agent-tags-${agent.id}`}>
      {agent.linkType && (
        <Badge variant="outline" className="gap-1 font-mono font-normal" title="Detected by the agent on its host">
          link:{agent.linkType}
          <span className="font-sans text-[10px] uppercase tracking-wide text-muted-foreground">detected</span>
        </Badge>
      )}
      {tags.map((t) => (
        <Badge key={t.key} variant="secondary" className="font-mono font-normal" title="Set by hand">{formatTag(t)}</Badge>
      ))}
      {!agent.linkType && tags.length === 0 && <span className="text-xs text-muted-foreground">None</span>}
      {agent.canEditTags && (
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) setDraft(tags); }}>
          <DialogTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6" aria-label={`Edit tags of ${agent.name}`} data-testid={`button-edit-agent-tags-${agent.id}`}>
              <Pencil className="h-3 w-3" />
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Tags for {agent.name}</DialogTitle>
              <DialogDescription>
                Describe this agent's network, e.g. isp:starlink or link:wifi. Each job also records the link type and internet provider detected at the time. For isp and link, Mainline uses the detected values; a hand-set one counts on Community and My Evals.
              </DialogDescription>
            </DialogHeader>
            <TagInput value={draft} onChange={setDraft} end="agent" preferredKeys={["isp", "link"]} testId="agent-tags-input" aria-label="Agent tags" />
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-agent-tags">Save tags</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

interface EvalAgentToken {
  id: number;
  name: string;
  token: string;
  siteId: string | null;
  siteLabel: string | null;
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

/** A badge with its explanation in a tooltip. */
function HintBadge({ className, hint, testId, children }: { className: string; hint: string; testId: string; children: ReactNode }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className={`cursor-default whitespace-nowrap ${className}`} data-testid={testId}>{children}</Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs text-xs">{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The location badge (design "Agent badge follows access"): Verified ·
 * last mile / Verified · datacenter / Verified (access unknown) / Unverified.
 * The first word is location trust, the second the access class; the tooltip
 * says why in plain words. Public agents are configured by an admin, so they
 * carry no location badge — only an access chip when it's known.
 */
function getTrustBadge(agent: Pick<EvalAgent, "id" | "locationTrust" | "dispatchTier" | "accessClass" | "accessReason">) {
  const trust = agent.locationTrust;
  // A stored trust of `datacenter` is derived from access = datacenter.
  const access = agent.accessClass ?? (trust === "datacenter" ? "datacenter" : null);
  const text = access === "lastmile" || access === "datacenter" ? ACCESS_TEXT[access] : undefined;
  const why = explainSystemReason("access", agent.accessReason);
  const accessHint = text ? `${text.hint}${why ? ` (${why})` : ""}.` : `${UNKNOWN_ACCESS_TEXT}${why ? ` (${why})` : ""}.`;
  const testId = `agent-location-badge-${agent.id}`;
  if (agent.dispatchTier === "public") {
    if (!text) return null;
    return <HintBadge className="text-muted-foreground" hint={accessHint} testId={testId}>{text.label.charAt(0).toUpperCase() + text.label.slice(1)}</HintBadge>;
  }
  if (trust === "trusted" || trust === "datacenter") {
    return (
      <HintBadge className="text-green-600 border-green-600" hint={`Location confirmed from its network address. ${accessHint}`} testId={testId}>
        {text ? `Verified · ${text.label}` : "Verified"}
      </HintBadge>
    );
  }
  return (
    <HintBadge className="text-yellow-600 border-yellow-600" hint="Its location couldn't be confirmed from its network address." testId={testId}>
      Unverified
    </HintBadge>
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
      const body: Record<string, unknown> = { name, dispatchTier };
      if (dispatchTier === "public") body.regionLocationBaseId = region;
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
                  <TableHead>Capabilities</TableHead>
                  <TableHead>Tags</TableHead>
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
                        {agent.siteLabel ?? (agent.siteId ?? "auto")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        {getTierBadge(agent.dispatchTier)}
                        {getTrustBadge(agent)}
                      </div>
                    </TableCell>
                    <TableCell>
                      {getStateBadge(agent.state)}
                    </TableCell>
                    <TableCell data-testid={`agent-capabilities-${agent.id}`}>
                      {/* Phone jobs go only to an agent reporting "phone" — missing
                          here is why a phone job would wait. */}
                      {agent.capabilities?.length ? (
                        <div className="flex items-center gap-1">
                          {agent.capabilities.includes("phone") && (
                            <Badge variant="outline" className="gap-1" title={`Its DialF check passes: it can take phone jobs${agent.simCarrier ? `. SIM network: ${agent.simCarrier}` : ""}`}><Phone className="h-3 w-3" /> Phone</Badge>
                          )}
                          {agent.capabilities.includes("analyze") && (
                            <Badge variant="outline" className="gap-1" title="aeval runs on its host: it can analyze uploaded recordings"><AudioLines className="h-3 w-3" /> Analyze</Badge>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground" title="It reports none: no phone jobs, no analyses">None</span>
                      )}
                    </TableCell>
                    <TableCell className="min-w-[200px]">
                      <AgentTagsCell agent={agent} />
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
                        {dispatchTier === "public" ? (
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
                        ) : (
                          <p className="text-xs text-muted-foreground" data-testid="text-region-auto">
                            Region is detected automatically when the agent connects — it cannot be set manually.
                          </p>
                        )}
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
                            createMutation.isPending || !name ||
                            (dispatchTier === "public" && (regionsLoading || !region)) ||
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
                        {token.siteLabel ?? (token.siteId ?? "auto")}
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
