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
import { useState, useEffect, useMemo } from "react";
import type { Workflow as WorkflowType, Provider, EvalJob, EvalSet } from "@shared/schema";
import { formatSmartTimestamp, formatSite, formatRegion, toYaml } from "@/lib/utils";
import { useRegionLocationOptions } from "@/hooks/use-regions";
import {
  type RunTargetAgents,
  encodePickerValue, decodePickerValue, dedupeSharedAgents, buildRegionGroups, buildUnverifiedAgents, countOnlinePublic,
} from "@/lib/run-picker";

interface AuthStatus {
  user: {
    id: number;
    username: string;
    plan: string;
    isAdmin: boolean;
    organizationId?: number | null;
  } | null;
}

interface RunTargetsResponse {
  agents: RunTargetAgents;
  referencedSecrets: Array<{ name: string; brokerType: string | null; present: boolean; resolvable?: boolean }>;
  tiers: { tier: string; available: boolean; onlineAgents?: number; reason?: string }[];
}

const TIER_LABEL: Record<string, string> = { public: "public", private: "private", team: "team", shared: "shared" };

export default function ConsoleWorkflowDetail() {
  const { toast } = useToast();
  const { options: regionOptions } = useRegionLocationOptions();
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const workflowId = parseInt(params.id || "0");

  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [runEvalSetId, setRunEvalSetId] = useState("");
  const [pickerValue, setPickerValue] = useState("");
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
      // The endpoint returns { data, total } — the Job History table wants the rows.
      const body = await res.json();
      return body.data ?? [];
    },
    enabled: workflowId > 0,
    refetchInterval: 10000, // Auto-refresh every 10s to update running job status
  });

  // No region filter: the two-level tree needs every region's agents at
  // once (it's the region-picking UI now), not one region's worth per
  // round-trip. `tiers[].onlineAgents` becomes a global-across-regions count
  // as a result — an accepted trade-off since it's informational only (see
  // task-12-report.md); tier *eligibility* (`available`/`reason`) never
  // depended on region to begin with.
  const { data: runTargets, isFetching: runTargetsFetching } = useQuery<RunTargetsResponse>({
    queryKey: [`/api/workflows/${workflowId}/run-targets`, runEvalSetId],
    queryFn: async () => (await apiRequest("GET",
      `/api/workflows/${workflowId}/run-targets?evalSetId=${runEvalSetId}`)).json(),
    enabled: runDialogOpen && !!runEvalSetId,
  });

  const tierAvailable = (tier: string) => (runTargets?.tiers ?? []).find((t) => t.tier === tier)?.available ?? false;

  const pickerShared = useMemo(
    () => dedupeSharedAgents(runTargets?.agents.mine ?? [], runTargets?.agents.shared ?? []),
    [runTargets]
  );
  // Everything except the public fleet — private/team/shared rows, each with
  // a real tokenId and a detected (or null/Unverified) siteId+region.
  const nonPublicAgents = useMemo(
    () => [...(runTargets?.agents.mine ?? []), ...pickerShared],
    [runTargets, pickerShared]
  );

  // Two-level tree data: region -> agents in that region, grouped by tier.
  // Only regions with at least one actual row show up — private/team/shared
  // from `nonPublicAgents`, or an informational public row from
  // `agents.public` — never a catalog-only region with no dispatchable agent.
  const regionGroups = useMemo(
    () => buildRegionGroups(
      nonPublicAgents,
      runTargets?.agents.public ?? [],
      (region) => regionOptions.find((r) => r.value === region)?.label ?? formatRegion(region),
    ),
    [nonPublicAgents, runTargets, regionOptions]
  );

  // private/team rows with no detected site (siteId === null → Unverified).
  // Shared-tier Unverified rows never reach the client at all — filtered
  // server-side in run-targets (siteId null shared agents aren't
  // dispatchable, full stop).
  const unverifiedAgents = buildUnverifiedAgents(nonPublicAgents);

  const selection = decodePickerValue(pickerValue);
  const selectedGroup = selection?.kind === "region" ? regionGroups.find((g) => g.region === selection.region) : undefined;

  // If the tree is rebuilt (new run-targets data) and the current selection
  // no longer resolves — a region-pool tier became globally unavailable, the
  // specific region+tier node it pointed at disappeared from the rebuilt
  // tree, or a picked site's agent vanished — clear it and say why, so the
  // default action never silently 403s.
  useEffect(() => {
    if (!runTargets || !selection) return;
    if (selection.kind === "region") {
      const group = regionGroups.find((g) => g.region === selection.region);
      const nodeStillExists = selection.targetTier === "public" ? (group?.public.length ?? 0) > 0
        : selection.targetTier === "private" ? (group?.private.length ?? 0) > 0
        : selection.targetTier === "team" ? (group?.team.length ?? 0) > 0
        : false;
      if (!tierAvailable(selection.targetTier) || !nodeStillExists) {
        setPickerValue("");
        toast({
          title: "Run target adjusted",
          description: `That agent pool isn't available for this workflow anymore — pick another target.`,
        });
      }
    } else {
      if (!nonPublicAgents.some((a) => a.tokenId === selection.tokenId)) {
        setPickerValue("");
        toast({
          title: "Run target adjusted",
          description: "That agent is no longer available — pick another target.",
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runTargets, regionGroups]);

  // Pooled dispatch aimed at a tier the workflow can't use (e.g. every
  // non-shared tier blocked) can only 403 — gate the submit. In practice the
  // tree never renders a region-pool option for an unavailable tier, so this
  // is defense in depth rather than something reachable through the UI.
  const nonSharedTiers = (runTargets?.tiers ?? []).filter((t) => t.tier !== "shared");
  const noPoolAvailable = nonSharedTiers.length > 0 && nonSharedTiers.every((t) => !t.available);

  const selectedAgent = selection?.kind === "site" ? nonPublicAgents.find((a) => a.tokenId === selection.tokenId) ?? null : null;
  const runtimeExposed = (runTargets?.referencedSecrets ?? [])
    .filter((s) => s.brokerType == null && s.present).map((s) => s.name);
  // Referenced but not configured for the workflow owner → the run would fail
  // with an unresolved ${secrets.X} placeholder. The server rejects it too;
  // surfacing it here means the user never spends an agent run to find out.
  const missingSecrets = (runTargets?.referencedSecrets ?? [])
    // `resolvable` mirrors the server gate exactly — a placeholder in a config
    // key the daemon never substitutes must NOT disable the Run button.
    .filter((s) => !s.present && s.resolvable !== false).map((s) => s.name);
  const showRuntimeWarning = selectedAgent?.dispatchTier === "shared" && runtimeExposed.length > 0;

  const runWorkflowMutation = useMutation({
    mutationFn: async () => {
      if (!selection) throw new Error("No run target selected");
      const res = await apiRequest("POST", `/api/workflows/${workflowId}/run`, {
        evalSetId: parseInt(runEvalSetId),
        ...(selection.kind === "site"
          ? { targetTokenId: selection.tokenId }
          : { region: selection.region, targetTier: selection.targetTier }),
        ...(showRuntimeWarning ? { runtimeSecretConsent: ackRuntime } : {}),
      });
      return res.json();
    },
    onSuccess: (data) => {
      setRunDialogOpen(false);
      setRunEvalSetId("");
      setPickerValue("");
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
              setPickerValue("");
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
                <Label htmlFor="run-agent">Run on</Label>
                <Select
                  value={pickerValue}
                  onValueChange={setPickerValue}
                  disabled={!runEvalSetId}
                >
                  <SelectTrigger data-testid="select-run-target">
                    <SelectValue placeholder="Choose a region or agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {regionGroups.map((group) => (
                      <SelectGroup key={group.region}>
                        <SelectLabel>{group.label}</SelectLabel>
                        {tierAvailable("public") && group.public.length > 0 && (
                          <SelectItem value={encodePickerValue({ kind: "region", region: group.region, targetTier: "public" })}>
                            Any public agent ({countOnlinePublic(group)} online)
                          </SelectItem>
                        )}
                        {group.public.map((r) => (
                          <SelectItem key={r.siteId} value={`disabled-public:${r.siteId}`} disabled>
                            {formatSite(r.siteId)} — public (informational only)
                          </SelectItem>
                        ))}
                        {tierAvailable("private") && group.private.length > 0 && (
                          <SelectItem value={encodePickerValue({ kind: "region", region: group.region, targetTier: "private" })}>
                            Any of my agents here
                          </SelectItem>
                        )}
                        {group.private.map((a) => (
                          <SelectItem key={a.tokenId} value={encodePickerValue({ kind: "site", tokenId: a.tokenId })}>
                            {a.name} · {formatSite(a.siteId!)}
                          </SelectItem>
                        ))}
                        {tierAvailable("team") && group.team.length > 0 && (
                          <SelectItem value={encodePickerValue({ kind: "region", region: group.region, targetTier: "team" })}>
                            Any team agent here
                          </SelectItem>
                        )}
                        {group.team.map((a) => (
                          <SelectItem key={a.tokenId} value={encodePickerValue({ kind: "site", tokenId: a.tokenId })}>
                            {a.name} · {formatSite(a.siteId!)} (team)
                          </SelectItem>
                        ))}
                        {group.shared.map((a) => (
                          <SelectItem key={a.tokenId} value={encodePickerValue({ kind: "site", tokenId: a.tokenId })}>
                            {a.name} · {formatSite(a.siteId!)}{a.price != null ? ` ($${a.price})` : ""}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                    {unverifiedAgents.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Unverified</SelectLabel>
                        {unverifiedAgents.map((a) => (
                          <SelectItem key={a.tokenId} value={encodePickerValue({ kind: "site", tokenId: a.tokenId })}>
                            {a.name} ({TIER_LABEL[a.dispatchTier] ?? a.dispatchTier})
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
                {selection?.kind === "region" && selection.targetTier === "public" && selectedGroup &&
                  countOnlinePublic(selectedGroup) === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No matching agent is online right now; the job will wait in the pool (up to 24h).
                  </p>
                )}
                {noPoolAvailable && (
                  <p className="text-xs text-muted-foreground">
                    No agent pool is available for this workflow — pick a specific agent instead.
                  </p>
                )}
              </div>
              {missingSecrets.length > 0 && (
                <Alert variant="destructive">
                  <AlertTitle>Missing secrets — this run would fail</AlertTitle>
                  <AlertDescription>
                    This workflow references {missingSecrets.length > 1 ? "secrets" : "a secret"} that {missingSecrets.length > 1 ? "are" : "is"} not
                    configured for its owner: {missingSecrets.join(", ")}. If the workflow is yours, create
                    {missingSecrets.length > 1 ? "them" : "it"} under Console → Secrets (names must match exactly); otherwise ask its owner to.
                  </AlertDescription>
                </Alert>
              )}
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
                disabled={
                  runWorkflowMutation.isPending || !runEvalSetId || !selection || runTargetsFetching ||
                  (selection?.kind === "region" && noPoolAvailable) ||
                  missingSecrets.length > 0 || (showRuntimeWarning && !ackRuntime)
                }
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
