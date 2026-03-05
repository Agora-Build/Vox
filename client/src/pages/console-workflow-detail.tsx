import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ArrowLeft, Play, Settings, History, Clock, CheckCircle, XCircle, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { Workflow as WorkflowType, Provider, EvalJob, EvalSet } from "@shared/schema";
import { formatSmartTimestamp } from "@/lib/utils";

interface AuthStatus {
  user: {
    id: number;
    username: string;
    plan: string;
    isAdmin: boolean;
  } | null;
}

function toYaml(obj: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "string") return obj.includes("\n") ? `|\n${obj.split("\n").map(l => pad + "  " + l).join("\n")}` : `"${obj}"`;
  if (typeof obj !== "object") return String(obj);
  if (Array.isArray(obj)) {
    return obj.map(item => {
      const val = toYaml(item, indent + 1);
      const isComplex = typeof item === "object" && item !== null;
      return isComplex ? `${pad}- ${val.trimStart()}` : `${pad}- ${val}`;
    }).join("\n");
  }
  const entries = Object.entries(obj as Record<string, unknown>);
  return entries.map(([key, val]) => {
    if (typeof val === "object" && val !== null) {
      return `${pad}${key}:\n${toYaml(val, indent + 1)}`;
    }
    return `${pad}${key}: ${toYaml(val, indent)}`;
  }).join("\n");
}

const REGIONS = [
  { value: "na", label: "North America" },
  { value: "apac", label: "Asia Pacific" },
  { value: "eu", label: "Europe" },
  { value: "sa", label: "South America" },
];

export default function ConsoleWorkflowDetail() {
  const { toast } = useToast();
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const workflowId = parseInt(params.id || "0");

  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [runRegion, setRunRegion] = useState("");
  const [runEvalSetId, setRunEvalSetId] = useState("");

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
    queryKey: ["/api/eval-sets"],
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

  const runWorkflowMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/workflows/${workflowId}/run`, {
        region: runRegion,
        evalSetId: parseInt(runEvalSetId),
      });
      return res.json();
    },
    onSuccess: (data) => {
      setRunDialogOpen(false);
      setRunRegion("");
      setRunEvalSetId("");
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
        <Dialog open={runDialogOpen} onOpenChange={setRunDialogOpen}>
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
                    {REGIONS.map((region) => (
                      <SelectItem key={region.value} value={region.value}>
                        {region.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
            </div>
            <DialogFooter>
              <Button
                onClick={() => runWorkflowMutation.mutate()}
                disabled={runWorkflowMutation.isPending || !runRegion || !runEvalSetId}
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
                      <Badge variant="outline">{job.region.toUpperCase()}</Badge>
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
