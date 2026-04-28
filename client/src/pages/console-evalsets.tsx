import { useQuery, useMutation } from "@tanstack/react-query";
import { REGIONS } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Plus, FileText, Globe, Lock, Star, Play, Pencil, Copy, Trash2 } from "lucide-react";
import { useState } from "react";
import type { EvalSet, Workflow as WorkflowType } from "@shared/schema";

const SCENARIO_PRESETS: Record<string, string> = {
  "appointment-vat": `tags:
  - default
steps:
  - action: wait_for_voice
  - action: wait_for_silence
  - action: speak
    file: hello_make_an_appointment.mp3
  - action: wait_for_voice
    metrics: elapsed_time
  - action: wait_for_silence
  - action: speak
    file: appointment_data.mp3
  - action: wait_for_voice
    metrics: elapsed_time`,
  "response-latency-aeval": `# aeval response latency scenario
# Place your aeval scenario YAML here
# See aeval documentation for schema details`,
  custom: "",
};

interface AuthStatus {
  user: {
    id: number;
    username: string;
    plan: string;
    isAdmin: boolean;
  } | null;
}


export default function ConsoleEvalSets() {
  const { toast } = useToast();

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState("public");
  const [scenarioPreset, setScenarioPreset] = useState("custom");
  const [scenarioYaml, setScenarioYaml] = useState("");

  // Run dialog state
  const [runOpen, setRunOpen] = useState(false);
  const [runEvalSet, setRunEvalSet] = useState<EvalSet | null>(null);
  const [runWorkflowId, setRunWorkflowId] = useState("");
  const [runRegion, setRunRegion] = useState("");
  const [runMode, setRunMode] = useState<"once" | "recurring">("once");
  const [cronExpression, setCronExpression] = useState("");
  const [scheduleName, setScheduleName] = useState("");

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editEvalSet, setEditEvalSet] = useState<EvalSet | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editVisibility, setEditVisibility] = useState("public");
  const [editScenarioYaml, setEditScenarioYaml] = useState("");

  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<EvalSet | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const { data: evalSets, isLoading } = useQuery<EvalSet[]>({
    queryKey: ["/api/eval-sets?includePublic=true"],
  });

  const { data: workflows } = useQuery<WorkflowType[]>({
    queryKey: ["/api/workflows?includePublic=true"],
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const config: Record<string, string> = {};
      if (scenarioYaml) config.scenario = scenarioYaml;
      const res = await apiRequest("POST", "/api/eval-sets", {
        name,
        description,
        visibility,
        config,
      });
      return res.json();
    },
    onSuccess: () => {
      setCreateOpen(false);
      setName("");
      setDescription("");
      setVisibility("public");
      setScenarioPreset("custom");
      setScenarioYaml("");
      queryClient.invalidateQueries({ queryKey: ["/api/eval-sets?includePublic=true"] });
      toast({ title: "Eval set created" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create eval set", description: error.message, variant: "destructive" });
    },
  });

  const toggleMainlineMutation = useMutation({
    mutationFn: async ({ id, isMainline }: { id: number; isMainline: boolean }) => {
      const res = await apiRequest("PATCH", `/api/eval-sets/${id}/mainline`, { isMainline });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/eval-sets?includePublic=true"] });
      toast({ title: "Eval set updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update eval set", description: error.message, variant: "destructive" });
    },
  });

  const runOnceMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/workflows/${runWorkflowId}/run`, {
        region: runRegion,
        evalSetId: runEvalSet!.id,
      });
      return res.json();
    },
    onSuccess: (data) => {
      closeRunDialog();
      toast({ title: "Job created", description: `Eval job #${data.job?.id} is now pending.` });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to run evaluation", description: error.message, variant: "destructive" });
    },
  });

  const runRecurringMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/eval-schedules", {
        name: scheduleName || `${runEvalSet!.name} schedule`,
        workflowId: parseInt(runWorkflowId),
        evalSetId: runEvalSet!.id,
        region: runRegion,
        scheduleType: "recurring",
        cronExpression,
      });
      return res.json();
    },
    onSuccess: () => {
      closeRunDialog();
      toast({ title: "Schedule created", description: "Recurring evaluation scheduled." });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create schedule", description: error.message, variant: "destructive" });
    },
  });

  const editMutation = useMutation({
    mutationFn: async () => {
      const config: Record<string, string> = {};
      if (editScenarioYaml) config.scenario = editScenarioYaml;
      const res = await apiRequest("PATCH", `/api/eval-sets/${editEvalSet!.id}`, {
        name: editName,
        description: editDescription,
        visibility: editVisibility,
        config,
      });
      return res.json();
    },
    onSuccess: () => {
      setEditOpen(false);
      setEditEvalSet(null);
      queryClient.invalidateQueries({ queryKey: ["/api/eval-sets?includePublic=true"] });
      toast({ title: "Eval set updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update eval set", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/eval-sets/${id}`);
      return res.json();
    },
    onSuccess: () => {
      setDeleteTarget(null);
      setDeleteConfirmName("");
      queryClient.invalidateQueries({ queryKey: ["/api/eval-sets?includePublic=true"] });
      toast({ title: "Eval set deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete eval set", description: error.message, variant: "destructive" });
    },
  });

  const isPrincipal = authStatus?.user?.plan === "principal";
  const canCreatePrivate = authStatus?.user?.plan !== "basic";

  const cloneMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/eval-sets/${id}/clone`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/eval-sets?includePublic=true"] });
      toast({ title: "Eval set cloned" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to clone eval set", description: error.message, variant: "destructive" });
    },
  });

  function openRunDialog(evalSet: EvalSet) {
    setRunEvalSet(evalSet);
    setRunWorkflowId("");
    setRunRegion("");
    setRunMode("once");
    setCronExpression("");
    setScheduleName("");
    setRunOpen(true);
  }

  function closeRunDialog() {
    setRunOpen(false);
    setRunEvalSet(null);
    setRunWorkflowId("");
    setRunRegion("");
    setRunMode("once");
    setCronExpression("");
    setScheduleName("");
  }

  function openEditDialog(evalSet: EvalSet) {
    const cfg = (evalSet.config || {}) as Record<string, string>;
    setEditEvalSet(evalSet);
    setEditName(evalSet.name);
    setEditDescription(evalSet.description || "");
    setEditVisibility(evalSet.visibility);
    setEditScenarioYaml(cfg.scenario || "");
    setEditOpen(true);
  }

  function handleRun() {
    if (runMode === "once") {
      runOnceMutation.mutate();
    } else {
      runRecurringMutation.mutate();
    }
  }

  const isRunPending = runOnceMutation.isPending || runRecurringMutation.isPending;
  const canRun = runWorkflowId && runRegion && (runMode === "once" || cronExpression);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Eval Sets</h1>
          <p className="text-muted-foreground">Manage evaluation configurations</p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-create-evalset">
              <Plus className="mr-2 h-4 w-4" />
              New Eval Set
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Eval Set</DialogTitle>
              <DialogDescription>
                Create a new evaluation set for testing.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="evalset-name">Name</Label>
                <Input
                  id="evalset-name"
                  placeholder="My Eval Set"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="input-evalset-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="evalset-description">Description</Label>
                <Textarea
                  id="evalset-description"
                  placeholder="Describe what this eval set measures..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  data-testid="input-evalset-description"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="evalset-visibility">Visibility</Label>
                <Select value={visibility} onValueChange={setVisibility}>
                  <SelectTrigger data-testid="select-evalset-visibility">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">Public</SelectItem>
                    <SelectItem value="private" disabled={!canCreatePrivate}>
                      Private {!canCreatePrivate && "(Premium required)"}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Scenario Preset</Label>
                <Select
                  value={scenarioPreset}
                  onValueChange={(v) => {
                    setScenarioPreset(v);
                    if (SCENARIO_PRESETS[v] !== undefined) {
                      setScenarioYaml(SCENARIO_PRESETS[v]);
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="appointment-vat">Appointment (VAT)</SelectItem>
                    <SelectItem value="response-latency-aeval">Response Latency (aeval)</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Scenario (YAML)</Label>
                <Textarea
                  className="font-mono text-sm min-h-[160px]"
                  placeholder="steps:&#10;  - action: speak&#10;    file: hello.mp3&#10;  - action: wait_for_voice&#10;    metrics: elapsed_time"
                  value={scenarioYaml}
                  onChange={(e) => setScenarioYaml(e.target.value)}
                  data-testid="textarea-evalset-scenario"
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || !name}
                data-testid="button-submit-evalset"
              >
                Create Eval Set
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardDescription>
            {isPrincipal
              ? "As a principal user, you can mark eval sets as mainline for the official evaluation."
              : "View and manage your evaluation configurations."
            }
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : evalSets && evalSets.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Visibility</TableHead>
                  <TableHead>Status</TableHead>
                  {isPrincipal && <TableHead>Mainline</TableHead>}
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {evalSets.map((evalSet) => (
                  <TableRow key={evalSet.id} data-testid={`row-evalset-${evalSet.id}`}>
                    <TableCell>
                      <div>
                        <div className="font-medium">{evalSet.name}</div>
                        {evalSet.description && (
                          <div className="text-sm text-muted-foreground">{evalSet.description}</div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="gap-1">
                        {evalSet.visibility === "public" ? (
                          <><Globe className="h-3 w-3" /> Public</>
                        ) : (
                          <><Lock className="h-3 w-3" /> Private</>
                        )}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {evalSet.isMainline ? (
                        <Badge className="gap-1">
                          <Star className="h-3 w-3" /> Mainline
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Community</Badge>
                      )}
                    </TableCell>
                    {isPrincipal && (
                      <TableCell>
                        <Switch
                          checked={evalSet.isMainline}
                          onCheckedChange={(checked) =>
                            toggleMainlineMutation.mutate({ id: evalSet.id, isMainline: checked })
                          }
                          disabled={evalSet.visibility === "private" && !evalSet.isMainline}
                          data-testid={`switch-mainline-${evalSet.id}`}
                        />
                      </TableCell>
                    )}
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {String(evalSet.ownerId) === String(authStatus?.user?.id) ? (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => openEditDialog(evalSet)}
                              data-testid={`button-edit-evalset-${evalSet.id}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => { setDeleteTarget(evalSet); setDeleteConfirmName(""); }}
                              data-testid={`button-delete-evalset-${evalSet.id}`}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </>
                        ) : evalSet.visibility === "public" ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => cloneMutation.mutate(evalSet.id)}
                            disabled={cloneMutation.isPending}
                            data-testid={`button-clone-evalset-${evalSet.id}`}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openRunDialog(evalSet)}
                          data-testid={`button-run-evalset-${evalSet.id}`}
                        >
                          <Play className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No eval sets yet. Create your first eval set to get started.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Run Eval Set Dialog */}
      <Dialog open={runOpen} onOpenChange={(open) => { if (!open) closeRunDialog(); else setRunOpen(true); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Run Evaluation</DialogTitle>
            <DialogDescription>
              Run <span className="font-medium text-foreground">{runEvalSet?.name}</span> against a workflow.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Workflow</Label>
              <Select value={runWorkflowId} onValueChange={setRunWorkflowId}>
                <SelectTrigger data-testid="select-run-workflow">
                  <SelectValue placeholder="Select workflow" />
                </SelectTrigger>
                <SelectContent>
                  {workflows?.map((w) => (
                    <SelectItem key={w.id} value={String(w.id)}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Region</Label>
              <Select value={runRegion} onValueChange={setRunRegion}>
                <SelectTrigger data-testid="select-run-region">
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

            <div className="space-y-3">
              <Label>Run Mode</Label>
              <RadioGroup value={runMode} onValueChange={(v) => setRunMode(v as "once" | "recurring")}>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="once" id="run-once" data-testid="radio-run-once" />
                  <Label htmlFor="run-once" className="font-normal cursor-pointer">
                    Run once
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="recurring" id="run-recurring" data-testid="radio-run-recurring" />
                  <Label htmlFor="run-recurring" className="font-normal cursor-pointer">
                    Recurring schedule
                  </Label>
                </div>
              </RadioGroup>
            </div>

            {runMode === "recurring" && (
              <div className="space-y-4 rounded-md border p-3">
                <div className="space-y-2">
                  <Label htmlFor="schedule-name">Schedule Name</Label>
                  <Input
                    id="schedule-name"
                    placeholder="e.g. Daily NA run"
                    value={scheduleName}
                    onChange={(e) => setScheduleName(e.target.value)}
                    data-testid="input-schedule-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cron-expression">Cron Expression</Label>
                  <Input
                    id="cron-expression"
                    placeholder="0 */6 * * *"
                    value={cronExpression}
                    onChange={(e) => setCronExpression(e.target.value)}
                    data-testid="input-cron-expression"
                  />
                  <p className="text-xs text-muted-foreground">
                    5-part cron: minute hour day month weekday (e.g. <code>0 */6 * * *</code> = every 6 hours)
                  </p>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeRunDialog}>
              Cancel
            </Button>
            <Button
              onClick={handleRun}
              disabled={isRunPending || !canRun}
              data-testid="button-submit-run"
            >
              <Play className="mr-2 h-4 w-4" />
              {runMode === "once" ? "Run Now" : "Create Schedule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Eval Set Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Eval Set</DialogTitle>
            <DialogDescription>
              Update the eval set details.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-evalset-name">Name</Label>
              <Input
                id="edit-evalset-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                data-testid="input-edit-evalset-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-evalset-description">Description</Label>
              <Textarea
                id="edit-evalset-description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                data-testid="input-edit-evalset-description"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-evalset-visibility">Visibility</Label>
              <Select value={editVisibility} onValueChange={setEditVisibility}>
                <SelectTrigger data-testid="select-edit-evalset-visibility">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">Public</SelectItem>
                  <SelectItem value="private" disabled={!canCreatePrivate}>
                    Private {!canCreatePrivate && "(Premium required)"}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Scenario (YAML)</Label>
              <Textarea
                className="font-mono text-sm min-h-[160px]"
                placeholder="steps:&#10;  - action: speak&#10;    file: hello.mp3&#10;  - action: wait_for_voice&#10;    metrics: elapsed_time"
                value={editScenarioYaml}
                onChange={(e) => setEditScenarioYaml(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => editMutation.mutate()}
              disabled={editMutation.isPending || !editName}
              data-testid="button-submit-edit-evalset"
            >
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Eval Set Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteConfirmName(""); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Eval Set</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <span className="font-semibold text-foreground">{deleteTarget?.name}</span>. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="delete-confirm-name">
              Type <span className="font-mono font-semibold">{deleteTarget?.name}</span> to confirm
            </Label>
            <Input
              id="delete-confirm-name"
              value={deleteConfirmName}
              onChange={(e) => setDeleteConfirmName(e.target.value)}
              placeholder={deleteTarget?.name}
              data-testid="input-delete-confirm-name"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteConfirmName !== deleteTarget?.name || deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              data-testid="button-confirm-delete-evalset"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
