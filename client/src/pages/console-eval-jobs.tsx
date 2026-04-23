import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ClipboardList, CheckCircle, XCircle, Loader2, Clock, RefreshCw, CalendarClock, MousePointerClick, MoreHorizontal, Pause, Play, Pencil, Trash2, Zap } from "lucide-react";
import { useState } from "react";
import { formatSmartTimestamp, formatRegion, REGIONS } from "@/lib/utils";
import type { EvalJob, EvalSchedule, Workflow as WorkflowType } from "@shared/schema";

type EnrichedSchedule = EvalSchedule & { workflowName: string; creatorName: string };

interface AuthStatus {
  user: { id: number; isAdmin: boolean } | null;
}

type EnrichedEvalJob = EvalJob & { creatorName?: string | null; type?: "manual" | "scheduled" };

const STATUSES = [
  { value: "all", label: "All Statuses" },
  { value: "pending", label: "Pending" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
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

function ScheduledJobsBlock() {
  const queryClient = useQueryClient();
  const { data: auth } = useQuery<AuthStatus>({ queryKey: ["/api/auth/status"] });
  const userId = auth?.user?.id;
  const isAdmin = auth?.user?.isAdmin ?? false;

  const { data: schedules, isLoading } = useQuery<EnrichedSchedule[]>({
    queryKey: ["/api/eval-schedules"],
    refetchInterval: 30000,
  });

  const [editSchedule, setEditSchedule] = useState<EnrichedSchedule | null>(null);
  const [editName, setEditName] = useState("");
  const [editCron, setEditCron] = useState("");
  const [editMaxRuns, setEditMaxRuns] = useState("");
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  const canManage = (s: EnrichedSchedule) => s.createdBy === userId || isAdmin;

  const refetchAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/eval-schedules"] });
  };

  const toggleEnabled = async (s: EnrichedSchedule) => {
    setActionLoading(s.id);
    await fetch(`/api/eval-schedules/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ isEnabled: !s.isEnabled }),
    });
    refetchAll();
    setActionLoading(null);
  };

  const runNow = async (id: number) => {
    setActionLoading(id);
    await fetch(`/api/eval-schedules/${id}/run-now`, {
      method: "POST",
      credentials: "include",
    });
    refetchAll();
    queryClient.invalidateQueries({ queryKey: ["/api/eval-jobs"] });
    setActionLoading(null);
  };

  const openEdit = (s: EnrichedSchedule) => {
    setEditSchedule(s);
    setEditName(s.name);
    setEditCron(s.cronExpression ?? "");
    setEditMaxRuns(s.maxRuns != null ? String(s.maxRuns) : "");
  };

  const submitEdit = async () => {
    if (!editSchedule) return;
    const body: Record<string, unknown> = { name: editName };
    if (editSchedule.scheduleType === "recurring") {
      body.cronExpression = editCron;
      body.maxRuns = editMaxRuns ? parseInt(editMaxRuns) : null;
    }
    await fetch(`/api/eval-schedules/${editSchedule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    setEditSchedule(null);
    refetchAll();
  };

  const confirmDelete = async () => {
    if (deleteId == null) return;
    await fetch(`/api/eval-schedules/${deleteId}`, {
      method: "DELETE",
      credentials: "include",
    });
    setDeleteId(null);
    refetchAll();
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5" />
            Scheduled Jobs
          </CardTitle>
          <CardDescription>
            {schedules ? `${schedules.length} schedule${schedules.length !== 1 ? "s" : ""}` : "Loading..."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : schedules && schedules.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Cron</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Next Run</TableHead>
                  <TableHead>Last Run</TableHead>
                  <TableHead>Runs</TableHead>
                  <TableHead>Creator</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell>{s.workflowName}</TableCell>
                    <TableCell><Badge variant="outline">{formatRegion(s.region)}</Badge></TableCell>
                    <TableCell>
                      <Badge variant="secondary">{s.scheduleType}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{s.cronExpression ?? "-"}</TableCell>
                    <TableCell>
                      <Badge variant={s.isEnabled ? "default" : "outline"}>
                        {s.isEnabled ? "active" : "paused"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {s.nextRunAt ? formatSmartTimestamp(s.nextRunAt) : "-"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {s.lastRunAt ? formatSmartTimestamp(s.lastRunAt) : "-"}
                    </TableCell>
                    <TableCell className="font-mono">
                      {s.runCount}{s.maxRuns != null ? `/${s.maxRuns}` : ""}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{s.creatorName}</TableCell>
                    <TableCell>
                      {canManage(s) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" disabled={actionLoading === s.id}>
                              {actionLoading === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => toggleEnabled(s)}>
                              {s.isEnabled ? <><Pause className="h-4 w-4 mr-2" />Pause</> : <><Play className="h-4 w-4 mr-2" />Resume</>}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => openEdit(s)}>
                              <Pencil className="h-4 w-4 mr-2" />Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => runNow(s.id)}>
                              <Zap className="h-4 w-4 mr-2" />Run Now
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-destructive" onClick={() => setDeleteId(s.id)}>
                              <Trash2 className="h-4 w-4 mr-2" />Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No scheduled jobs yet. Create one from an eval set.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={!!editSchedule} onOpenChange={(open) => { if (!open) setEditSchedule(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Schedule</DialogTitle>
            <DialogDescription>Update schedule settings</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Name</Label>
              <Input id="edit-name" value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            {editSchedule?.scheduleType === "recurring" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="edit-cron">Cron Expression</Label>
                  <Input id="edit-cron" value={editCron} onChange={(e) => setEditCron(e.target.value)} placeholder="0 */8 * * *" className="font-mono" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-max-runs">Max Runs (empty = unlimited)</Label>
                  <Input id="edit-max-runs" type="number" value={editMaxRuns} onChange={(e) => setEditMaxRuns(e.target.value)} placeholder="unlimited" />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditSchedule(null)}>Cancel</Button>
            <Button onClick={submitEdit}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteId != null} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Schedule</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this schedule. Any jobs already created by it will remain. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function JobsTab() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [regionFilter, setRegionFilter] = useState("all");
  const [workflowFilter, setWorkflowFilter] = useState("all");

  const url = buildJobsUrl({ status: statusFilter, region: regionFilter, workflowId: workflowFilter });

  const { data: jobs, isLoading } = useQuery<EnrichedEvalJob[]>({
    queryKey: [url],
    queryFn: async () => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch jobs");
      return res.json();
    },
    refetchInterval: 10000,
  });

  const { data: workflows } = useQuery<WorkflowType[]>({
    queryKey: ["/api/workflows?includePublic=true"],
  });

  const workflowMap = new Map(workflows?.map((w) => [w.id, w.name]) ?? []);

  const hasActiveFilters = statusFilter !== "all" || regionFilter !== "all" || workflowFilter !== "all";

  return (
    <div className="space-y-4">
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
                  <TableHead>Creator</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
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
                      <TableCell className="text-sm text-muted-foreground">
                        {job.creatorName || "-"}
                      </TableCell>
                      <TableCell>
                        {job.type === "scheduled" ? (
                          <Badge variant="outline" className="gap-1">
                            <CalendarClock className="h-3 w-3" />
                            scheduled
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="gap-1">
                            <MousePointerClick className="h-3 w-3" />
                            manual
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{formatRegion(job.region)}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={cfg.variant} className="gap-1">
                          <StatusIcon className={`h-3 w-3${job.status === "running" ? " animate-spin" : ""}`} />
                          {job.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatSmartTimestamp(job.createdAt)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {job.completedAt ? formatSmartTimestamp(job.completedAt) : "-"}
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

export default function ConsoleEvalJobs() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Eval Jobs</h1>
        <p className="text-muted-foreground">Manage schedules and monitor job execution</p>
      </div>

      <Tabs defaultValue="schedules">
        <TabsList>
          <TabsTrigger value="schedules">
            <CalendarClock className="h-4 w-4 mr-2" />
            Schedules
          </TabsTrigger>
          <TabsTrigger value="jobs">
            <ClipboardList className="h-4 w-4 mr-2" />
            Jobs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="schedules" className="mt-4">
          <ScheduledJobsBlock />
        </TabsContent>

        <TabsContent value="jobs" className="mt-4">
          <JobsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
