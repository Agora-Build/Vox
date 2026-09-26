import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Plus, Workflow as EvalFlowIcon, Globe, Lock, Star, StarOff, ChevronRight, Pencil, FolderKanban, Copy, Trash2, Phone } from "lucide-react";
import { useState } from "react";
import { LEGACY_CONFIG_KEY_PREFIX } from "@shared/secrets";
import { useLocation } from "wouter";
import { load as loadYaml } from "js-yaml";
import type { EvalFlow as EvalFlowType, Provider, Project } from "@shared/schema";

// Extract `platform_id` from the aeval `platform.setup` step in a stepsPrefix YAML.
// Checks both the step's top level and its `params`. Returns null if absent/unparseable.
function extractPlatformId(stepsPrefix: string): string | null {
  if (!stepsPrefix?.trim()) return null;
  try {
    const parsed = loadYaml(stepsPrefix);
    if (!Array.isArray(parsed)) return null;
    for (const step of parsed) {
      if (step && typeof step === "object" && (step as any).type === "platform.setup") {
        const pid = (step as any).platform_id ?? (step as any).params?.platform_id;
        return pid != null ? String(pid) : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

type SaveDecision =
  | { action: "ok" }
  | { action: "auto-custom"; customId: string }
  | { action: "mismatch"; yamlPlatform: string; providerName: string };

// Decide whether an evalFlow save can proceed, must switch to Custom, or should warn.
function evaluateSave(
  stepsPrefix: string,
  providerId: string,
  providers: Provider[] | undefined,
): SaveDecision {
  const yamlPlatform = extractPlatformId(stepsPrefix);
  const selected = providers?.find((p) => p.id === providerId);
  const custom = providers?.find((p) => p.name === "Custom" || (!p.platformId && p.name.toLowerCase() === "custom"));
  if (!yamlPlatform) {
    // No platform_id in the setup steps → this is a Custom/self-hosted evalFlow.
    if (custom && providerId !== custom.id) return { action: "auto-custom", customId: custom.id };
    return { action: "ok" };
  }
  if (selected?.platformId && selected.platformId === yamlPlatform) return { action: "ok" };
  return { action: "mismatch", yamlPlatform, providerName: selected?.name ?? "(none)" };
}


interface AuthStatus {
  user: {
    id: number;
    username: string;
    plan: string;
    isAdmin: boolean;
  } | null;
}

export default function ConsoleEvalFlows() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState("public");
  const [providerId, setProviderId] = useState("");
  // Evaluation Mode (design §11): "web" = Web vs Agent, "phone" = Phone vs Agent.
  const [transport, setTransport] = useState("web");
  const [stepsPrefix, setStepsPrefix] = useState("");
  const [stepsSuffix, setStepsSuffix] = useState("");
  const [editStepsPrefix, setEditStepsPrefix] = useState("");
  const [editStepsSuffix, setEditStepsSuffix] = useState("");

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editEvalFlow, setEditEvalFlow] = useState<EvalFlowType | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editVisibility, setEditVisibility] = useState("");
  const [editProjectId, setEditProjectId] = useState("");
  const [editProviderId, setEditProviderId] = useState("");
  const [editTransport, setEditTransport] = useState("web");
  // Payloads parked by a migration (0040's _legacyPhoneDial). Read-only:
  // nothing executes them, and the server carries them across saves, so this
  // is purely so the owner can see and copy the value.
  const [editLegacyConfig, setEditLegacyConfig] = useState<string>("");

  // Non-blocking warning when the evalFlow's provider disagrees with its YAML platform_id.
  const [pendingMismatch, setPendingMismatch] = useState<{ kind: "create" | "edit"; yamlPlatform: string; providerName: string } | null>(null);

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const { data: evalFlows, isLoading } = useQuery<EvalFlowType[]>({
    queryKey: ["/api/eval-flows?includePublic=true"],
  });

  const { data: providers } = useQuery<Provider[]>({
    queryKey: ["/api/providers"],
  });

  const { data: projects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const createMutation = useMutation({
    mutationFn: async (overrideProviderId?: string) => {
      const config: Record<string, unknown> = { framework: "aeval" };
      // Unified steps model: Setup/Teardown are the same fields for every
      // Evaluation Mode — vocabulary differs (call.* for phone), layout doesn't.
      if (stepsPrefix) config.stepsPrefix = stepsPrefix;
      if (stepsSuffix) config.stepsSuffix = stepsSuffix;
      const res = await apiRequest("POST", "/api/eval-flows", {
        name,
        description,
        visibility,
        transport,
        providerId: overrideProviderId ?? providerId,
        config,
      });
      return res.json();
    },
    onSuccess: () => {
      setCreateOpen(false);
      setName("");
      setDescription("");
      setVisibility("public");
      setProviderId("");
      setTransport("web");
      setStepsPrefix("");
      setStepsSuffix("");
      queryClient.invalidateQueries({ queryKey: ["/api/eval-flows?includePublic=true"] });
      toast({ title: "Eval Flow created" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create evalFlow", description: error.message, variant: "destructive" });
    },
  });

  const editMutation = useMutation({
    mutationFn: async (overrideProviderId?: string) => {
      if (!editEvalFlow) return;
      const body: Record<string, unknown> = {};
      if (editName !== editEvalFlow.name) body.name = editName;
      if (editDescription !== (editEvalFlow.description || "")) body.description = editDescription;
      if (editVisibility !== editEvalFlow.visibility) body.visibility = editVisibility;
      if (editProjectId && !editEvalFlow.projectId) body.projectId = parseInt(editProjectId);
      const pid = overrideProviderId ?? editProviderId;
      if (pid && pid !== editEvalFlow.providerId) body.providerId = pid;
      if (editTransport !== editEvalFlow.transport) body.transport = editTransport;
      const config: Record<string, unknown> = { framework: "aeval" };
      if (editStepsPrefix) config.stepsPrefix = editStepsPrefix;
      if (editStepsSuffix) config.stepsSuffix = editStepsSuffix;
      body.config = config;
      const res = await apiRequest("PATCH", `/api/eval-flows/${editEvalFlow.id}`, body);
      return res.json();
    },
    onSuccess: () => {
      setEditOpen(false);
      setEditEvalFlow(null);
      queryClient.invalidateQueries({ queryKey: ["/api/eval-flows?includePublic=true"] });
      toast({ title: "Eval Flow updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update evalFlow", description: error.message, variant: "destructive" });
    },
  });

  const toggleMainlineMutation = useMutation({
    mutationFn: async ({ id, isMainline }: { id: number; isMainline: boolean }) => {
      const res = await apiRequest("PATCH", `/api/eval-flows/${id}/mainline`, { isMainline });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/eval-flows?includePublic=true"] });
      toast({ title: "Eval Flow updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update evalFlow", description: error.message, variant: "destructive" });
    },
  });

  const cloneMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/eval-flows/${id}/clone`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/eval-flows?includePublic=true"] });
      toast({ title: "Eval Flow cloned" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to clone evalFlow", description: error.message, variant: "destructive" });
    },
  });

  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<EvalFlowType | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/eval-flows/${id}`);
      return res.json();
    },
    onSuccess: () => {
      setDeleteTarget(null);
      setDeleteConfirmName("");
      queryClient.invalidateQueries({ queryKey: ["/api/eval-flows?includePublic=true"] });
      toast({ title: "Eval Flow deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete evalFlow", description: error.message, variant: "destructive" });
    },
  });

  const openEditDialog = (evalFlow: EvalFlowType) => {
    const cfg = (evalFlow.config || {}) as Record<string, any>;
    setEditEvalFlow(evalFlow);
    setEditName(evalFlow.name);
    setEditDescription(evalFlow.description || "");
    setEditVisibility(evalFlow.visibility);
    setEditProjectId(evalFlow.projectId?.toString() || "");
    setEditStepsPrefix(cfg.stepsPrefix || "");
    setEditStepsSuffix(cfg.stepsSuffix || "");
    setEditProviderId(evalFlow.providerId);
    setEditTransport(evalFlow.transport || "web");
    const parked = Object.fromEntries(Object.entries(cfg).filter(([k]) => k.startsWith(LEGACY_CONFIG_KEY_PREFIX)));
    setEditLegacyConfig(Object.keys(parked).length > 0 ? JSON.stringify(parked, null, 2) : "");
    setEditOpen(true);
  };

  // Run the provider/platform_id guard, then create. Warns on mismatch, auto-switches to Custom.
  const handleCreateClick = () => {
    const decision = evaluateSave(stepsPrefix, providerId, providers);
    if (decision.action === "mismatch") {
      setPendingMismatch({ kind: "create", yamlPlatform: decision.yamlPlatform, providerName: decision.providerName });
      return;
    }
    if (decision.action === "auto-custom") {
      setProviderId(decision.customId);
      toast({ title: "Provider set to Custom", description: "No platform_id found in the setup steps." });
      createMutation.mutate(decision.customId);
      return;
    }
    createMutation.mutate(undefined);
  };

  const handleEditClick = () => {
    const decision = evaluateSave(editStepsPrefix, editProviderId, providers);
    if (decision.action === "mismatch") {
      setPendingMismatch({ kind: "edit", yamlPlatform: decision.yamlPlatform, providerName: decision.providerName });
      return;
    }
    if (decision.action === "auto-custom") {
      setEditProviderId(decision.customId);
      toast({ title: "Provider set to Custom", description: "No platform_id found in the setup steps." });
      editMutation.mutate(decision.customId);
      return;
    }
    editMutation.mutate(undefined);
  };

  const confirmMismatchSave = () => {
    if (!pendingMismatch) return;
    if (pendingMismatch.kind === "create") createMutation.mutate(undefined);
    else editMutation.mutate(undefined);
    setPendingMismatch(null);
  };

  const isPrincipal = authStatus?.user?.plan === "principal";
  const canCreatePrivate = authStatus?.user?.plan !== "basic";
  const hasProjects = projects && projects.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Eval Flows</h1>
          <p className="text-muted-foreground">Manage how evaluations reach each agent</p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-create-eval-flow">
              <Plus className="mr-2 h-4 w-4" />
              New Eval Flow
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Eval Flow</DialogTitle>
              <DialogDescription>
                Create a new test evalFlow for evaluation.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="eval-flow-name">Name</Label>
                <Input
                  id="eval-flow-name"
                  placeholder="My Test Eval Flow"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="input-eval-flow-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="eval-flow-description">Description</Label>
                <Textarea
                  id="eval-flow-description"
                  placeholder="Describe what this evalFlow tests..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  data-testid="input-eval-flow-description"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="eval-flow-provider">Provider</Label>
                <Select value={providerId} onValueChange={setProviderId}>
                  <SelectTrigger data-testid="select-eval-flow-provider">
                    <SelectValue placeholder="Select a provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers?.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Evaluation Mode</Label>
                <Select value={transport} onValueChange={setTransport}>
                  <SelectTrigger data-testid="select-eval-flow-transport">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="web">Web vs Agent</SelectItem>
                    <SelectItem value="phone">Phone vs Agent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="eval-flow-visibility">Visibility</Label>
                <Select value={visibility} onValueChange={setVisibility}>
                  <SelectTrigger data-testid="select-eval-flow-visibility">
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
                <Label>Setup Steps (stepsPrefix, YAML)</Label>
                <Textarea
                  className="font-mono text-sm min-h-[120px]"
                  placeholder={transport === "phone"
                    ? "- type: call.dial\n  number: \"+1 555 010 1234\"\n- type: call.wait_answered"
                    : "- type: platform.setup\n  platform_id: livekit\n- type: platform.enter"}
                  value={stepsPrefix}
                  onChange={(e) => setStepsPrefix(e.target.value)}
                  data-testid="textarea-eval-flow-steps-prefix"
                />
                <p className="text-xs text-muted-foreground">
                  {transport === "phone"
                    ? "How we reach the agent: dial it (call.dial) or trigger it. The conversation lives in the eval set."
                    : "Platform connect/login steps. Differs per provider. The test body lives in the eval set."}
                </p>
              </div>
              <div className="space-y-2">
                <Label>Teardown Steps (stepsSuffix, YAML)</Label>
                <Textarea
                  className="font-mono text-sm min-h-[80px]"
                  placeholder={transport === "phone"
                    ? "- type: call.hangup"
                    : "- type: audio.stop_recording\n- type: platform.exit"}
                  value={stepsSuffix}
                  onChange={(e) => setStepsSuffix(e.target.value)}
                  data-testid="textarea-eval-flow-steps-suffix"
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={handleCreateClick}
                disabled={createMutation.isPending || !name || !providerId}
                data-testid="button-submit-eval-flow"
              >
                Create Eval Flow
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Edit Eval Flow Dialog */}
      <Dialog open={editOpen} onOpenChange={(open) => {
        if (!open) {
          setEditOpen(false);
          setEditEvalFlow(null);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Eval Flow</DialogTitle>
            <DialogDescription>
              Update evalFlow details. Project assignment is permanent once set.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-eval-flow-name">Name</Label>
              <Input
                id="edit-eval-flow-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-eval-flow-description">Description</Label>
              <Textarea
                id="edit-eval-flow-description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-eval-flow-provider">Provider</Label>
              <Select value={editProviderId} onValueChange={setEditProviderId}>
                <SelectTrigger data-testid="select-edit-eval-flow-provider">
                  <SelectValue placeholder="Select a provider" />
                </SelectTrigger>
                <SelectContent>
                  {providers?.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-eval-flow-visibility">Visibility</Label>
              <Select value={editVisibility} onValueChange={setEditVisibility}>
                <SelectTrigger>
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
              <Label>Evaluation Mode</Label>
              <Select value={editTransport} onValueChange={setEditTransport}>
                <SelectTrigger data-testid="select-edit-eval-flow-transport">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="web">Web vs Agent</SelectItem>
                  <SelectItem value="phone">Phone vs Agent</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Past runs keep the mode they ran with — changing this affects future runs only.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Setup Steps (stepsPrefix, YAML)</Label>
              <Textarea
                className="font-mono text-sm min-h-[120px]"
                placeholder={editTransport === "phone"
                  ? "- type: call.dial\n  number: \"+1 555 010 1234\"\n- type: call.wait_answered"
                  : "- type: platform.setup\n  platform_id: livekit\n- type: platform.enter"}
                value={editStepsPrefix}
                onChange={(e) => setEditStepsPrefix(e.target.value)}
                data-testid="textarea-eval-flow-steps-prefix-edit"
              />
              <p className="text-xs text-muted-foreground">
                {editTransport === "phone"
                  ? "How we reach the agent: dial it (call.dial) or trigger it. The conversation lives in the eval set."
                  : "Platform connect/login steps. Differs per provider. The test body lives in the eval set."}
              </p>
            </div>
            <div className="space-y-2">
              <Label>Teardown Steps (stepsSuffix, YAML)</Label>
              <Textarea
                className="font-mono text-sm min-h-[80px]"
                placeholder={editTransport === "phone"
                  ? "- type: call.hangup"
                  : "- type: audio.stop_recording\n- type: platform.exit"}
                value={editStepsSuffix}
                onChange={(e) => setEditStepsSuffix(e.target.value)}
                data-testid="textarea-eval-flow-steps-suffix-edit"
              />
            </div>
            {editLegacyConfig && (
              <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                <Label className="text-amber-600 dark:text-amber-400">
                  Legacy config — kept, but unused
                </Label>
                <p className="text-xs text-muted-foreground">
                  A migration parked this from an older config format. Nothing runs it,
                  and editing this evalFlow won't remove it. Copy anything you still need.
                </p>
                <pre
                  className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-xs"
                  data-testid="text-eval-flow-legacy-config"
                >
                  {editLegacyConfig}
                </pre>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="edit-eval-flow-project">Project</Label>
              {editEvalFlow?.projectId ? (
                <div className="flex items-center gap-2 p-2 border rounded-md bg-muted/50">
                  <FolderKanban className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">
                    {projects?.find(p => p.id === editEvalFlow.projectId)?.name || `Project #${editEvalFlow.projectId}`}
                  </span>
                  <Badge variant="secondary" className="ml-auto text-xs">Locked</Badge>
                </div>
              ) : (
                <Select value={editProjectId} onValueChange={setEditProjectId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a project (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects?.map((p) => (
                      <SelectItem key={p.id} value={p.id.toString()}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {!editEvalFlow?.projectId && (
                <p className="text-xs text-muted-foreground">
                  Once attached to a project, this cannot be changed.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEditOpen(false); setEditEvalFlow(null); }}>
              Cancel
            </Button>
            <Button
              onClick={handleEditClick}
              disabled={editMutation.isPending || !editName || !editProviderId}
            >
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardDescription>
            {isPrincipal
              ? "As a principal user, you can mark evalFlows as mainline for the official evaluation."
              : "View and manage your test evalFlows."
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
          ) : evalFlows && evalFlows.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  {hasProjects && <TableHead>Project</TableHead>}
                  <TableHead>Visibility</TableHead>
                  <TableHead>Status</TableHead>
                  {isPrincipal && <TableHead>Mainline</TableHead>}
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {evalFlows.map((evalFlow) => (
                  <TableRow
                    key={evalFlow.id}
                    data-testid={`row-eval-flow-${evalFlow.id}`}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setLocation(`/console/eval-flows/${evalFlow.id}`)}
                  >
                    <TableCell>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-medium">{evalFlow.name}</div>
                          {evalFlow.description && (
                            <div className="text-sm text-muted-foreground">{evalFlow.description}</div>
                          )}
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </TableCell>
                    {hasProjects && (
                      <TableCell>
                        {evalFlow.projectId ? (
                          <Badge variant="outline" className="gap-1">
                            <FolderKanban className="h-3 w-3" />
                            {projects?.find(p => p.id === evalFlow.projectId)?.name || `#${evalFlow.projectId}`}
                          </Badge>
                        ) : (
                          <span className="text-sm text-muted-foreground">--</span>
                        )}
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Badge variant="outline" className="gap-1">
                          {evalFlow.visibility === "public" ? (
                            <><Globe className="h-3 w-3" /> Public</>
                          ) : (
                            <><Lock className="h-3 w-3" /> Private</>
                          )}
                        </Badge>
                        {evalFlow.transport === "phone" && (
                          <Badge variant="outline" className="gap-1" data-testid={`badge-phone-${evalFlow.id}`}>
                            <Phone className="h-3 w-3" /> Phone
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {evalFlow.isMainline ? (
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
                          checked={evalFlow.isMainline}
                          onCheckedChange={(checked) => {
                            toggleMainlineMutation.mutate({ id: evalFlow.id, isMainline: checked });
                          }}
                          disabled={evalFlow.visibility === "private" && !evalFlow.isMainline}
                          data-testid={`switch-mainline-${evalFlow.id}`}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </TableCell>
                    )}
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {String(evalFlow.ownerId) === String(authStatus?.user?.id) ? (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                openEditDialog(evalFlow);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteTarget(evalFlow);
                                setDeleteConfirmName("");
                              }}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </>
                        ) : evalFlow.visibility === "public" ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              cloneMutation.mutate(evalFlow.id);
                            }}
                            disabled={cloneMutation.isPending}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No evalFlows yet. Create your first evalFlow to get started.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete Eval Flow Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteConfirmName(""); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Eval Flow</AlertDialogTitle>
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
              autoComplete="off"
              data-testid="input-delete-confirm-name"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!deleteTarget?.name?.trim() || deleteConfirmName.trim() !== deleteTarget.name.trim() || deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              data-testid="button-confirm-delete-eval-flow"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Provider ↔ platform_id mismatch warning */}
      <AlertDialog open={!!pendingMismatch} onOpenChange={(open) => { if (!open) setPendingMismatch(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Provider doesn't match the setup steps</AlertDialogTitle>
            <AlertDialogDescription>
              The setup YAML uses{" "}
              <span className="font-mono font-semibold text-foreground">platform_id: {pendingMismatch?.yamlPlatform}</span>,
              but the selected provider is{" "}
              <span className="font-semibold text-foreground">{pendingMismatch?.providerName}</span>.
              These usually should match. Save anyway?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmMismatchSave}>Save anyway</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
