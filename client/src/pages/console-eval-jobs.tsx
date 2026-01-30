import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClipboardList, CheckCircle, XCircle, Loader2, Clock, RefreshCw } from "lucide-react";
import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import type { EvalJob, Workflow as WorkflowType } from "@shared/schema";

const STATUSES = [
  { value: "all", label: "All Statuses" },
  { value: "pending", label: "Pending" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const REGIONS = [
  { value: "all", label: "All Regions" },
  { value: "na", label: "North America" },
  { value: "apac", label: "Asia Pacific" },
  { value: "eu", label: "Europe" },
];

function buildJobsUrl(filters: { status: string; region: string; workflowId: string }) {
  const params = new URLSearchParams();
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.region !== "all") params.set("region", filters.region);
  if (filters.workflowId !== "all") params.set("workflowId", filters.workflowId);
  params.set("limit", "50");
  const qs = params.toString();
  return `/api/eval-jobs${qs ? `?${qs}` : ""}`;
}

const STATUS_CONFIG: Record<string, { variant: "default" | "destructive" | "secondary" | "outline"; icon: React.ElementType }> = {
  completed: { variant: "default", icon: CheckCircle },
  failed: { variant: "destructive", icon: XCircle },
  running: { variant: "secondary", icon: Loader2 },
  pending: { variant: "outline", icon: Clock },
};

export default function ConsoleEvalJobs() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [regionFilter, setRegionFilter] = useState("all");
  const [workflowFilter, setWorkflowFilter] = useState("all");

  const url = buildJobsUrl({ status: statusFilter, region: regionFilter, workflowId: workflowFilter });

  const { data: jobs, isLoading, refetch } = useQuery<EvalJob[]>({
    queryKey: [url],
    queryFn: async () => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch jobs");
      return res.json();
    },
    refetchInterval: 10000,
  });

  const { data: workflows } = useQuery<WorkflowType[]>({
    queryKey: ["/api/workflows"],
  });

  const workflowMap = new Map(workflows?.map((w) => [w.id, w.name]) ?? []);

  const hasActiveFilters = statusFilter !== "all" || regionFilter !== "all" || workflowFilter !== "all";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Eval Jobs</h1>
          <p className="text-muted-foreground">Monitor evaluation job status across all workflows</p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => refetch()} data-testid="button-refresh-jobs">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px]" data-testid="select-filter-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={regionFilter} onValueChange={setRegionFilter}>
          <SelectTrigger className="w-[160px]" data-testid="select-filter-region">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REGIONS.map((r) => (
              <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={workflowFilter} onValueChange={setWorkflowFilter}>
          <SelectTrigger className="w-[200px]" data-testid="select-filter-workflow">
            <SelectValue placeholder="All Workflows" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Workflows</SelectItem>
            {workflows?.map((w) => (
              <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setStatusFilter("all"); setRegionFilter("all"); setWorkflowFilter("all"); }}
          >
            Clear filters
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5" />
            Jobs
          </CardTitle>
          <CardDescription>
            {jobs ? `${jobs.length} job${jobs.length !== 1 ? "s" : ""}` : "Loading..."}
            {" \u00b7 auto-refreshes every 10s"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : jobs && jobs.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => {
                  const cfg = STATUS_CONFIG[job.status] ?? STATUS_CONFIG.pending;
                  const StatusIcon = cfg.icon;
                  return (
                    <TableRow key={job.id} data-testid={`row-job-${job.id}`}>
                      <TableCell className="font-mono">#{job.id}</TableCell>
                      <TableCell className="font-medium">
                        {workflowMap.get(job.workflowId) ?? `Workflow #${job.workflowId}`}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{job.region.toUpperCase()}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={cfg.variant} className="gap-1">
                          <StatusIcon className={`h-3 w-3${job.status === "running" ? " animate-spin" : ""}`} />
                          {job.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {job.startedAt
                          ? formatDistanceToNow(new Date(job.startedAt), { addSuffix: true })
                          : "-"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {job.completedAt
                          ? formatDistanceToNow(new Date(job.completedAt), { addSuffix: true })
                          : "-"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              {hasActiveFilters
                ? "No jobs match the current filters."
                : "No eval jobs yet. Run an evaluation from a workflow or eval set to create one."}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
