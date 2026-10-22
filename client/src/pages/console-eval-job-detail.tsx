import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowLeft, Download, CheckCircle, XCircle, Loader2, Clock, RefreshCw, FileText, AlertTriangle, Phone, Ban } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatSmartTimestamp, formatSite, formatRegion, toYaml } from "@/lib/utils";
import type { EvalJob, EvalResult } from "@shared/schema";
import { EvalResultView } from "@/components/eval-result-view";
import { formatTag, type JobTag } from "@shared/tags";

const TAG_SOURCE_TEXT: Record<JobTag["source"], { label: string; title: string }> = {
  flow: { label: "flow", title: "Set on the eval flow" },
  agent: { label: "agent", title: "Set by the agent's operator" },
  detected: { label: "detected", title: "Detected when the agent took the job" },
};

interface AuthStatus {
  user: { id: number; isAdmin: boolean } | null;
}

interface JobDetailResponse {
  job: EvalJob;
  result: EvalResult | null;
  evalFlowName: string;
  creatorName: string | null;
  /** Pending only: why it's still waiting — the claim rule run over the agents online now. */
  waiting?: { canTake: number; busy: number; message: string } | null;
  /** Server-decided: pending, and this user may cancel it. */
  canCancel?: boolean;
  /** Who cancelled it, when it was cancelled while pending. */
  cancelledByName?: string | null;
}

const STATUS_CONFIG: Record<string, { variant: "default" | "destructive" | "secondary" | "outline"; icon: React.ElementType; label: string }> = {
  completed: { variant: "default", icon: CheckCircle, label: "Completed" },
  failed: { variant: "destructive", icon: XCircle, label: "Failed" },
  running: { variant: "secondary", icon: Loader2, label: "Running" },
  pending: { variant: "outline", icon: Clock, label: "Pending" },
  // Not a status of its own: a job cancelled while pending is stored as
  // failed with cancelled_at set, and shown as this instead of a red Failed.
  cancelled: { variant: "secondary", icon: Ban, label: "Cancelled" },
};

export default function ConsoleEvalJobDetail({ jobId }: { jobId: number }) {
  const { toast } = useToast();
  const { data: auth } = useQuery<AuthStatus>({ queryKey: ["/api/auth/status"] });
  const { data, isLoading } = useQuery<JobDetailResponse>({
    queryKey: [`/api/eval-jobs/${jobId}/detail`],
    refetchInterval: (query) => {
      const job = query.state.data?.job;
      const artStatus = query.state.data?.result?.artifactStatus;
      if (job?.status === "pending" || job?.status === "running") return 20000;
      if (artStatus === "uploading") return 10000;
      return false;
    },
  });

  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const cancelMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/eval-jobs/${jobId}`);
    },
    onSuccess: () => {
      setCancelOpen(false);
      queryClient.invalidateQueries({ queryKey: [`/api/eval-jobs/${jobId}/detail`] });
      // Every eval-jobs list query (filters live in the key).
      queryClient.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/eval-jobs") });
      toast({ title: "Job cancelled" });
    },
    onError: (error: Error) => {
      setCancelOpen(false);
      // Most likely an agent claimed it a moment ago: refresh so the page shows that.
      queryClient.invalidateQueries({ queryKey: [`/api/eval-jobs/${jobId}/detail`] });
      toast({ title: "Couldn't cancel the job", description: error.message, variant: "destructive" });
    },
  });

  const reuploadMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/eval-jobs/${jobId}/reupload`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/eval-jobs/${jobId}/detail`] });
      toast({ title: "Re-upload requested", description: "The eval agent will retry if output files are still on disk. If the agent was restarted, the files may no longer be available." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to request re-upload", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <Link href="/console/eval-jobs?tab=jobs">
          <Button variant="ghost" size="sm" className="gap-2"><ArrowLeft className="h-4 w-4" /> Back to Jobs</Button>
        </Link>
        <p className="text-muted-foreground">Job not found.</p>
      </div>
    );
  }

  const { job, result, evalFlowName, creatorName } = data;
  const statusCfg = job.cancelledAt ? STATUS_CONFIG.cancelled : (STATUS_CONFIG[job.status] ?? STATUS_CONFIG.pending);
  const StatusIcon = statusCfg.icon;

  // Provenance from the job's immutable snapshot — correct even after the
  // evalFlow/eval-set is edited or deleted.
  const snap = job.snapshot;
  const providerName = snap?.provider?.name ?? null;
  const jobEvalSetName = snap?.evalSet?.name ?? `#${job.evalSetId ?? "?"}`;

  const artifactUrl = result?.artifactUrl as string | null;
  const artifactStatus = (result?.artifactStatus as string) ?? "pending";
  // Fewer than all prompts answered (0% included) → a partial/no-response run.
  const pct = (v: number | null | undefined) => v == null ? "-" : `${Math.round(v * 100)}%`;
  const partialResponse = result?.responseRate != null && result.responseRate < 1;

  // Can this user trigger re-upload?
  const userId = auth?.user?.id;
  const isAdmin = auth?.user?.isAdmin ?? false;
  const canReupload = isAdmin || job.createdBy === userId;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link href="/console/eval-jobs?tab=jobs">
            <Button variant="ghost" size="sm" className="gap-2"><ArrowLeft className="h-4 w-4" /> Back</Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-3">
              Job #{job.id}
              <Badge variant={statusCfg.variant} className="gap-1">
                <StatusIcon className={`h-3 w-3${job.status === "running" ? " animate-spin" : ""}`} />
                {statusCfg.label}
              </Badge>
              {job.transport === "phone" && (
                <Badge variant="outline" className="gap-1" data-testid="badge-phone-job">
                  <Phone className="h-3 w-3" /> Phone vs Agent
                </Badge>
              )}
              {partialResponse && (
                <Badge
                  className="gap-1 bg-amber-500 text-white hover:bg-amber-500"
                  title={`Agent responded to ${pct(result?.responseRate)} of prompts`}
                  data-testid="badge-partial-response"
                >
                  <AlertTriangle className="h-3 w-3" /> Partial response
                </Badge>
              )}
            </h1>
            <p className="text-muted-foreground text-sm">
              {job.evalFlowId != null ? (
                <Link href={`/console/eval-flows/${job.evalFlowId}`}>
                  <span className="text-primary hover:underline cursor-pointer">{evalFlowName}</span>
                </Link>
              ) : (
                <span title="Eval Flow deleted">{evalFlowName}</span>
              )}
              {providerName && <> · {providerName}</>}
              {" · "}
              {job.evalSetId != null ? (
                <Link href="/console/eval-sets">
                  <span className="text-primary hover:underline cursor-pointer">{jobEvalSetName}</span>
                </Link>
              ) : (
                <span title="Eval set deleted">{jobEvalSetName}</span>
              )}
              {" · "}
              {job.siteId ? formatSite(job.siteId) : `${formatRegion(job.targetRegion ?? "")}${job.targetTier ? ` · ${job.targetTier} pool` : ""}`}
              {creatorName && ` · by ${creatorName}`}
            </p>
            {/* Network tags, frozen when an agent took the job — a pending job has none yet. */}
            {job.tags != null && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="job-tags">
                <span className="text-xs text-muted-foreground">Tags:</span>
                {job.tags.length === 0 ? (
                  <span className="text-xs text-muted-foreground">none</span>
                ) : job.tags.map((t, i) => (
                  <Badge key={`${t.key}-${t.source}-${i}`} variant={t.source === "detected" ? "outline" : "secondary"} className="gap-1 font-mono font-normal" title={TAG_SOURCE_TEXT[t.source]?.title}>
                    {formatTag(t)}
                    <span className="font-sans text-[10px] uppercase tracking-wide text-muted-foreground">{TAG_SOURCE_TEXT[t.source]?.label ?? t.source}</span>
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {job.status === "pending" && data.canCancel && (
            <Button variant="outline" className="gap-2" onClick={() => setCancelOpen(true)} data-testid="button-cancel-job">
              <Ban className="h-4 w-4" /> Cancel job
            </Button>
          )}
          {snap && (
            <Button variant="outline" className="gap-2" onClick={() => setSnapshotOpen(true)} data-testid="button-view-snapshot">
              <FileText className="h-4 w-4" /> View Eval Flow &amp; eval set
            </Button>
          )}
          {/* Artifact status + actions */}
          {result && artifactStatus === "uploaded" && artifactUrl && (
            <a href={artifactUrl} download>
              <Button variant="outline" className="gap-2">
                <Download className="h-4 w-4" /> Download
              </Button>
            </a>
          )}
          {result && artifactStatus === "uploading" && (
            <Badge variant="secondary" className="gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Uploading
            </Badge>
          )}
          {result && artifactStatus === "failed" && (
            <div className="flex items-center gap-2">
              <Badge variant="destructive" className="gap-1">
                <XCircle className="h-3 w-3" /> Upload Failed
              </Badge>
              {canReupload && (
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => reuploadMutation.mutate()} disabled={reuploadMutation.isPending}>
                  {reuploadMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  Re-Upload
                </Button>
              )}
            </div>
          )}
          {result && artifactStatus === "pending" && job.status === "completed" && (
            <Badge variant="outline" className="gap-1">
              <Clock className="h-3 w-3" /> Upload Pending
            </Badge>
          )}
        </div>
      </div>

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel job #{job.id}?</AlertDialogTitle>
            <AlertDialogDescription>
              It hasn't started, so nothing runs and no agent is charged; a paid job's held credits go back right away.
              This can't be undone — run the Eval Flow again to queue a new job.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelMutation.isPending}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); cancelMutation.mutate(); }}
              disabled={cancelMutation.isPending}
              data-testid="button-confirm-cancel-job"
            >
              {cancelMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Cancel job"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Pending: why it's still waiting. An agent only ever sees the jobs it
          may claim, so a job nobody online may take otherwise just sits here
          while every agent looks healthy. */}
      {job.status === "pending" && data.waiting && (
        <Alert data-testid="job-waiting" className={data.waiting.canTake === 0 ? "border-amber-500" : undefined}>
          <Clock className="h-4 w-4" />
          <AlertTitle>{data.waiting.canTake === 0 ? "No online agent can take this job" : "Waiting for an agent"}</AlertTitle>
          <AlertDescription>{data.waiting.message}</AlertDescription>
        </Alert>
      )}

      {/* Cancelled (a cancellation, not an error) / Error */}
      {job.cancelledAt ? (
        <Card data-testid="job-cancelled">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Cancelled{data.cancelledByName ? ` by ${data.cancelledByName}` : ""} · {formatSmartTimestamp(job.cancelledAt)}
            </p>
          </CardContent>
        </Card>
      ) : job.error && (
        <Card className="border-destructive/50">
          <CardContent className="pt-6">
            <p className="text-sm text-destructive font-mono">{job.error}</p>
          </CardContent>
        </Card>
      )}

      {/* Timestamps */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div>
          <p className="text-xs text-muted-foreground">Created</p>
          <p className="text-sm font-mono">{formatSmartTimestamp(job.createdAt)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Started</p>
          <p className="text-sm font-mono">{job.startedAt ? formatSmartTimestamp(job.startedAt) : "-"}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Completed</p>
          <p className="text-sm font-mono">{job.completedAt ? formatSmartTimestamp(job.completedAt) : "-"}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Duration</p>
          <p className="text-sm font-mono">
            {job.startedAt && job.completedAt
              ? `${Math.round((new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()) / 1000)}s`
              : "-"}
          </p>
        </div>
      </div>

      {result && <EvalResultView result={result} />}

      {/* Immutable evalFlow + eval-set snapshot (as run) */}
      <Dialog open={snapshotOpen} onOpenChange={setSnapshotOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Eval Flow &amp; eval set — as run</DialogTitle>
            <DialogDescription>
              Immutable snapshot captured when this job ran. It does not change if the
              evalFlow or eval set is later edited or deleted.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <div className="text-sm font-semibold mb-1">
                Provider: <span className="font-normal">{snap?.provider?.name ?? "—"}</span>
                {snap?.provider?.platformId && (
                  <span className="text-muted-foreground font-normal"> · platform_id: {snap.provider.platformId}</span>
                )}
              </div>
            </div>
            <div>
              <div className="text-sm font-semibold mb-1">Eval Flow: {snap?.evalFlow?.name ?? "—"}</div>
              <pre className="p-3 bg-muted rounded-md text-xs font-mono overflow-auto max-h-72">
                {snap?.evalFlow?.config ? toYaml(snap.evalFlow.config) : "(no config)"}
              </pre>
            </div>
            <div>
              <div className="text-sm font-semibold mb-1">Eval set: {snap?.evalSet?.name ?? "—"}</div>
              <pre className="p-3 bg-muted rounded-md text-xs font-mono overflow-auto max-h-72">
                {snap?.evalSet?.config ? toYaml(snap.evalSet.config) : "(no config)"}
              </pre>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
