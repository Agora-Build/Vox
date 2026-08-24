import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ArrowLeft, Play, Settings, History, Clock, CheckCircle, XCircle, Loader2, RefreshCw } from "lucide-react";
import { useState, useEffect } from "react";
import type { Workflow as WorkflowType, Provider, EvalJob, EvalSet } from "@shared/schema";
import { formatSmartTimestamp, formatSite, formatRegion, toYaml } from "@/lib/utils";
import { useRegionLocationOptions } from "@/hooks/use-regions";

interface AuthStatus {
  user: {
    id: number;
    username: string;
    plan: string;
    isAdmin: boolean;
    organizationId?: number | null;
  } | null;
}

interface RunTargetAgent {
  tokenId: number;
  name: string;
  siteId: string;
  dispatchTier: string;
  price: number | null;
}

interface RunTargetsResponse {
  agents: { mine: RunTargetAgent[]; shared: RunTargetAgent[] };
  referencedSecrets: Array<{ name: string; class: "runtime" | "protected"; present: boolean }>;
  tiers: { tier: string; available: boolean; onlineAgents?: number; reason?: string }[];
}

export default function ConsoleWorkflowDetail() {
  const { toast } = useToast();
  const { options: regionOptions } = useRegionLocationOptions();
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const workflowId = parseInt(params.id || "0");

  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [runRegion, setRunRegion] = useState("");
  const [runEvalSetId, setRunEvalSetId] = useState("");
  const [targetTier, setTargetTier] = useState<string>("public");
  const [targetTokenId, setTargetTokenId] = useState<string>("any");
  const [ackRuntime, setAckRuntime] = useState(false);

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const { data: workflow, isLoading: workflowLoading } = useQuery<WorkflowType>({
    queryKey: [`/api/workflows/${workflowId}`],
    enabled: workflowId > 0,
  });

  const { data: providers } = useQuery<Provider[]>({
    queryKey: ["/api/providers"],
  });

  const { data: evalSets } = useQuery<EvalSet[]>({
    queryKey: ["/api/eval-sets?includePublic=true"],
  });

  const { data: jobs, isLoading: jobsLoading, refetch: refetchJobs } = useQuery<EvalJob[]>({
    queryKey: [`/api/eval-jobs`, { workflowId }],
    queryFn: async () => {
      const res = await fetch(`/api/eval-jobs?workflowId=${workflowId}&limit=20`);
      if (!res.ok) throw new Error("Failed to fetch jobs");
      return res.json();
    },
    enabled: workflowId > 0,
    refetchInterval: 10000, // Auto-refresh every 10s to update running job status
  });

  const { data: runTargets } = useQuery<RunTargetsResponse>({
    queryKey: [`/api/workflows/${workflowId}/run-targets`, runRegion, runEvalSetId],
    queryFn: async () => (await apiRequest("GET",
      `/api/workflows/${workflowId}/run-targets?region=${encodeURIComponent(runRegion)}&evalSetId=${runEvalSetId}`)).json(),
    enabled: runDialogOpen && !!runRegion && !!runEvalSetId,
  });

  // Fallback tier list (no online counts yet) so the "Run on" selector is
  // populated immediately, before a region/eval set is chosen and the
  // run-targets query has loaded.
  const tierOptions = runTargets?.tiers ?? [
    { tier: "private", available: true },
    { tier: "team", available: !!authStatus?.user?.organizationId, reason: authStatus?.user?.organizationId ? undefined : "no-org" },
    { tier: "public", available: true },
  ];

  // When live tier data arrives and the currently-selected tier is
  // unavailable (e.g. "public" on a credential-injected workflow), hop to the
  // first available tier so the default action never 403s.
  useEffect(() => {
    if (!runTargets?.tiers) return;
    const current = runTargets.tiers.find((t) => t.tier === targetTier);
    if (current && !current.available) {
      const firstAvailable = runTargets.tiers.find((t) => t.tier !== "shared" && t.available);
      if (firstAvailable) setTargetTier(firstAvailable.tier);
    }
  }, [runTargets, targetTier]);


  const pickerShared = (runTargets?.agents.shared ?? []).filter(
    (s) => !(runTargets?.agents.mine ?? []).some((m) => m.tokenId === s.tokenId)
  );
  // Pooled dispatch with every tier unavailable can only 403 — gate the submit.
  const noPoolAvailable = targetTokenId === "any" &&
    (runTargets?.tiers ?? []).length > 0 && (runTargets?.tiers ?? []).every((t) => !t.available);

  const selectedAgent = targetTokenId === "any" ? null :
    [...(runTargets?.agents.mine ?? []), ...pickerShared].find((a) => String(a.tokenId) === targetTokenId);
  const runtimeExposed = (runTargets?.referencedSecrets ?? [])
    .filter((s) => s.class === "runtime" && s.present).map((s) => s.name);
  const showRuntimeWarning = selectedAgent?.dispatchTier === "shared" && runtimeExposed.length > 0;

  const runWorkflowMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/workflows/${workflowId}/run`, {
        evalSetId: parseInt(runEvalSetId),
        ...(targetTokenId !== "any" ? { targetTokenId: Number(targetTokenId) } : { region: runRegion, targetTier }),
        ...(showRuntimeWarning ? { runtimeSecretConsent: ackRuntime } : {}),
      });
      return res.json();
    },
    onSuccess: (data) => {
      setRunDialogOpen(false);
      setRunRegion("");
      setRunEvalSetId("");
      setTargetTier("public");
      setTargetTokenId("any");
      setAckRuntime(false);
      refetchJobs();
      toast({ title: "Workflow started", description: `Job created: ${data.job?.id}` });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to run workflow", description: error.message, variant: "destructive" });
    },
  });

  const isOwner = workflow?.ownerId === authStatus?.user?.id;
  const canModify = isOwner || authStatus?.user?.isAdmin;
  const provider = providers?.find(p => p.id === workflow?.providerId);

  if (workflowLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!workflow) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" onClick={() => setLocation("/console/workflows")}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Workflows
        </Button>
        <div className="text-center py-8 text-muted-foreground">
          Workflow not found
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => setLocation("/console/workflows")}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
          <div>
            <h1 className="text-2xl font-bold">{workflow.name}</h1>
            {workflow.description && (
              <p className="text-muted-foreground">{workflow.description}</p>
            )}
          </div>
        </div>
        <Dialog
          open={runDialogOpen}
          onOpenChange={(open) => {
            setRunDialogOpen(open);
            if (!open) {
              setTargetTier("public");
              setTargetTokenId("any");
              setAckRuntime(false);
            }
          }}
        >
          <DialogTrigger asChild>
            <Button>
              <Play className="mr-2 h-4 w-4" />
              Run Workflow
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Run Workflow</DialogTitle>
              <DialogDescription>
                Select a region to run this workflow evaluation.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="run-region">Region</Label>
                <Select value={runRegion} onValueChange={setRunRegion}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select region" />
                  </SelectTrigger>
                  <SelectContent>
                    {regionOptions.map((region) => (
                      <SelectItem key={region.value} value={region.value}>
                        {region.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Run on</Label>
                <Select value={targetTier} onValueChange={setTargetTier}>
                  <SelectTrigger data-testid="select-target-tier">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {tierOptions.filter((t) => t.tier !== "shared").map((t) => (
                      <SelectItem key={t.tier} value={t.tier} disabled={!t.available}>
                        {t.tier === "public" ? "Any public agent" : t.tier === "private" ? "My agents" : "Team agents"}
                        {t.available ? (typeof t.onlineAgents === "number" ? ` (${t.onlineAgents} online)` : "") : t.reason === "no-org" ? " — join an organization" : t.reason === "session-injected" ? " — not allowed for credential-injected workflows" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {tierOptions.find((t) => t.tier === targetTier)?.onlineAgents === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No matching agent is online right now; the job will wait in the pool (up to 24h).
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="run-eval-set">Eval Set</Label>
                <Select value={runEvalSetId} onValueChange={setRunEvalSetId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select eval set" />
                  </SelectTrigger>
                  <SelectContent>
                    {evalSets?.map((es) => (
                      <SelectItem key={es.id} value={String(es.id)}>
                        {es.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="run-agent">Agent</Label>
                <Select value={targetTokenId} onValueChange={setTargetTokenId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Any available in region" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any available in region</SelectItem>
                    {(runTargets?.agents.mine ?? []).length > 0 && (
                      <SelectGroup>
                        <SelectLabel>My agents</SelectLabel>
                        {runTargets!.agents.mine.map((agent) => (
                          <SelectItem key={agent.tokenId} value={String(agent.tokenId)}>
                            {agent.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                    {pickerShared.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Shared marketplace</SelectLabel>
                        {pickerShared.map((agent) => (
                          <SelectItem key={agent.tokenId} value={String(agent.tokenId)}>
                            {agent.name}{agent.price != null ? ` ($${agent.price})` : ""}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
              </div>
              {showRuntimeWarning && (
                <Alert variant="destructive">
                  <AlertTitle>This workflow uses runtime secrets</AlertTitle>
                  <AlertDescription>
                    The selected shared agent will receive the raw values of these secrets: {runtimeExposed.join(", ")}.
                    <label className="mt-2 flex items-center gap-2">
                      <Checkbox checked={ackRuntime} onCheckedChange={(v) => setAckRuntime(v === true)} />
                      I understand
                    </label>
                  </AlertDescription>
                </Alert>
              )}
            </div>
            <DialogFooter>
              <Button
                onClick={() => runWorkflowMutation.mutate()}
                disabled={runWorkflowMutation.isPending || !runRegion || !runEvalSetId || noPoolAvailable || (showRuntimeWarning && !ackRuntime)}
              >
                Run Evaluation
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Workflow Details
          </CardTitle>
          <CardDescription>
            Configuration and settings for this workflow
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-muted-foreground">Visibility</Label>
              <div className="mt-1">
                <Badge variant="outline">
                  {workflow.visibility === "public" ? "Public" : "Private"}
                </Badge>
              </div>
            </div>
            <div>
              <Label className="text-muted-foreground">Mainline</Label>
              <div className="mt-1">
                <Badge variant={workflow.isMainline ? "default" : "secondary"}>
                  {workflow.isMainline ? "Yes" : "No"}
                </Badge>
              </div>
            </div>
            <div>
              <Label className="text-muted-foreground">Provider</Label>
              <div className="mt-1">
                {provider ? (
                  <Badge variant="outline">{provider.name}</Badge>
                ) : (
                  <span className="text-muted-foreground">Not set</span>
                )}
              </div>
            </div>
            <div>
              <Label className="text-muted-foreground">Created</Label>
              <div className="mt-1 text-sm">
                {new Date(workflow.createdAt).toLocaleDateString()}
              </div>
            </div>
            <div>
              <Label className="text-muted-foreground">Framework</Label>
              <div className="mt-1">
                <Badge variant="outline">
                  {(workflow.config as Record<string, unknown> | null)?.framework as string || "aeval"}
                </Badge>
              </div>
            </div>
          </div>

          {(() => {
            const config = workflow.config as Record<string, unknown> | null;
            if (config?.app && typeof config.app === 'object') {
              return (
                <div>
                  <Label className="text-muted-foreground">App Config</Label>
                  <pre className="mt-1 p-3 bg-muted rounded-md text-sm font-mono overflow-auto">
                    {toYaml(config.app as Record<string, unknown>)}
                  </pre>
                </div>
              );
            }
            return null;
          })()}
        </CardContent>
      </Card>

      {/* Job History */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <History className="h-5 w-5" />
              <CardTitle>Job History</CardTitle>
            </div>
            <Button variant="ghost" size="icon" onClick={() => refetchJobs()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
          <CardDescription>
            Recent evaluation jobs for this workflow
          </CardDescription>
        </CardHeader>
        <CardContent>
          {jobsLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : jobs && jobs.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="font-mono">#{job.id}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Badge variant="outline">
                          {job.siteId ? formatSite(job.siteId) : formatRegion(job.targetRegion ?? "")}
                        </Badge>
                        {!job.siteId && job.targetTier && (
                          <Badge variant="secondary" className="text-xs">{job.targetTier}</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          job.status === "completed" ? "default" :
                          job.status === "failed" ? "destructive" :
                          job.status === "running" ? "secondary" :
                          "outline"
                        }
                        className="gap-1"
                      >
                        {job.status === "completed" && <CheckCircle className="h-3 w-3" />}
                        {job.status === "failed" && <XCircle className="h-3 w-3" />}
                        {job.status === "running" && <Loader2 className="h-3 w-3 animate-spin" />}
                        {job.status === "pending" && <Clock className="h-3 w-3" />}
                        {job.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {job.startedAt ? formatSmartTimestamp(job.startedAt) : "-"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {job.completedAt ? formatSmartTimestamp(job.completedAt) : "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No jobs have been run yet. Click "Run Workflow" to start an evaluation.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
