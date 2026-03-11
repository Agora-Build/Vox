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
import { Plus, Workflow, Globe, Lock, Star, StarOff, ChevronRight, Pencil, FolderKanban, Copy, Trash2 } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import type { Workflow as WorkflowType, Provider, Project } from "@shared/schema";

const APP_CONFIG_PRESETS: Record<string, string> = {
  "livekit-playground": `url: "https://livekit.io/"
steps:
  - action: wait
    selector: "xpath///button[contains(., 'Talk to LiveKit Agent')]"
  - action: sleep
    time: 5000
  - action: click
    selector: "xpath///button[contains(., 'Talk to LiveKit Agent')]"
  - action: wait_for_voice
  - action: wait_for_silence`,
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

export default function ConsoleWorkflows() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState("public");
  const [providerId, setProviderId] = useState("");
  const [framework, setFramework] = useState("aeval");
  const [appConfigPreset, setAppConfigPreset] = useState("custom");
  const [appConfigYaml, setAppConfigYaml] = useState("");

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editWorkflow, setEditWorkflow] = useState<WorkflowType | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editVisibility, setEditVisibility] = useState("");
  const [editProjectId, setEditProjectId] = useState("");
  const [editFramework, setEditFramework] = useState("aeval");
  const [editAppConfigYaml, setEditAppConfigYaml] = useState("");

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const { data: workflows, isLoading } = useQuery<WorkflowType[]>({
    queryKey: ["/api/workflows?includePublic=true"],
  });

  const { data: providers } = useQuery<Provider[]>({
    queryKey: ["/api/providers"],
  });

  const { data: projects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const config: Record<string, string> = { framework };
      if (framework === "voice-agent-tester" && appConfigYaml) {
        config.app = appConfigYaml;
      }
      const res = await apiRequest("POST", "/api/workflows", {
        name,
        description,
        visibility,
        providerId,
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
      setFramework("aeval");
      setAppConfigPreset("custom");
      setAppConfigYaml("");
      queryClient.invalidateQueries({ queryKey: ["/api/workflows?includePublic=true"] });
      toast({ title: "Workflow created" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create workflow", description: error.message, variant: "destructive" });
    },
  });

  const editMutation = useMutation({
    mutationFn: async () => {
      if (!editWorkflow) return;
      const body: Record<string, unknown> = {};
      if (editName !== editWorkflow.name) body.name = editName;
      if (editDescription !== (editWorkflow.description || "")) body.description = editDescription;
      if (editVisibility !== editWorkflow.visibility) body.visibility = editVisibility;
      if (editProjectId && !editWorkflow.projectId) body.projectId = parseInt(editProjectId);
      const config: Record<string, string> = { framework: editFramework };
      if (editFramework === "voice-agent-tester" && editAppConfigYaml) {
        config.app = editAppConfigYaml;
      }
      body.config = config;
      const res = await apiRequest("PATCH", `/api/workflows/${editWorkflow.id}`, body);
      return res.json();
    },
    onSuccess: () => {
      setEditOpen(false);
      setEditWorkflow(null);
      queryClient.invalidateQueries({ queryKey: ["/api/workflows?includePublic=true"] });
      toast({ title: "Workflow updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update workflow", description: error.message, variant: "destructive" });
    },
  });

  const toggleMainlineMutation = useMutation({
    mutationFn: async ({ id, isMainline }: { id: number; isMainline: boolean }) => {
      const res = await apiRequest("PATCH", `/api/workflows/${id}/mainline`, { isMainline });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/workflows?includePublic=true"] });
      toast({ title: "Workflow updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update workflow", description: error.message, variant: "destructive" });
    },
  });

  const cloneMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/workflows/${id}/clone`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/workflows?includePublic=true"] });
      toast({ title: "Workflow cloned" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to clone workflow", description: error.message, variant: "destructive" });
    },
  });

  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<WorkflowType | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/workflows/${id}`);
      return res.json();
    },
    onSuccess: () => {
      setDeleteTarget(null);
      setDeleteConfirmName("");
      queryClient.invalidateQueries({ queryKey: ["/api/workflows?includePublic=true"] });
      toast({ title: "Workflow deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete workflow", description: error.message, variant: "destructive" });
    },
  });

  const openEditDialog = (workflow: WorkflowType) => {
    const cfg = (workflow.config || {}) as Record<string, string>;
    setEditWorkflow(workflow);
    setEditName(workflow.name);
    setEditDescription(workflow.description || "");
    setEditVisibility(workflow.visibility);
    setEditProjectId(workflow.projectId?.toString() || "");
    setEditFramework(cfg.framework || "aeval");
    setEditAppConfigYaml(cfg.app || "");
    setEditOpen(true);
  };

  const isPrincipal = authStatus?.user?.plan === "principal";
  const canCreatePrivate = authStatus?.user?.plan !== "basic";
  const hasProjects = projects && projects.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Test Workflows</h1>
          <p className="text-muted-foreground">Manage evaluation test workflows</p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-create-workflow">
              <Plus className="mr-2 h-4 w-4" />
              New Workflow
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Workflow</DialogTitle>
              <DialogDescription>
                Create a new test workflow for evaluation.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="workflow-name">Name</Label>
                <Input
                  id="workflow-name"
                  placeholder="My Test Workflow"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="input-workflow-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="workflow-description">Description</Label>
                <Textarea
                  id="workflow-description"
                  placeholder="Describe what this workflow tests..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  data-testid="input-workflow-description"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="workflow-provider">Provider</Label>
                <Select value={providerId} onValueChange={setProviderId}>
                  <SelectTrigger data-testid="select-workflow-provider">
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
                <Label htmlFor="workflow-visibility">Visibility</Label>
                <Select value={visibility} onValueChange={setVisibility}>
                  <SelectTrigger data-testid="select-workflow-visibility">
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
                <Label>Eval Framework</Label>
                <Select value={framework} onValueChange={setFramework}>
                  <SelectTrigger data-testid="select-workflow-framework">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="aeval">aeval</SelectItem>
                    <SelectItem value="voice-agent-tester">voice-agent-tester</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {framework === "voice-agent-tester" && (
                <>
                  <div className="space-y-2">
                    <Label>App Config Preset</Label>
                    <Select
                      value={appConfigPreset}
                      onValueChange={(v) => {
                        setAppConfigPreset(v);
                        if (APP_CONFIG_PRESETS[v] !== undefined) {
                          setAppConfigYaml(APP_CONFIG_PRESETS[v]);
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="livekit-playground">LiveKit Playground</SelectItem>
                        <SelectItem value="custom">Custom</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>App Config (YAML)</Label>
                    <Textarea
                      className="font-mono text-sm min-h-[160px]"
                      placeholder="url: &quot;https://...&quot;&#10;steps:&#10;  - action: wait&#10;    selector: ..."
                      value={appConfigYaml}
                      onChange={(e) => setAppConfigYaml(e.target.value)}
                      data-testid="textarea-workflow-app-config"
                    />
                  </div>
                </>
              )}
            </div>
            <DialogFooter>
              <Button
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || !name || !providerId}
                data-testid="button-submit-workflow"
              >
                Create Workflow
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Edit Workflow Dialog */}
      <Dialog open={editOpen} onOpenChange={(open) => {
        if (!open) {
          setEditOpen(false);
          setEditWorkflow(null);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Workflow</DialogTitle>
            <DialogDescription>
              Update workflow details. Project assignment is permanent once set.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-workflow-name">Name</Label>
              <Input
                id="edit-workflow-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-workflow-description">Description</Label>
              <Textarea
                id="edit-workflow-description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-workflow-visibility">Visibility</Label>
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
              <Label>Eval Framework</Label>
              <Select value={editFramework} onValueChange={setEditFramework}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="aeval">aeval</SelectItem>
                  <SelectItem value="voice-agent-tester">voice-agent-tester</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {editFramework === "voice-agent-tester" && (
              <div className="space-y-2">
                <Label>App Config (YAML)</Label>
                <Textarea
                  className="font-mono text-sm min-h-[160px]"
                  placeholder="url: &quot;https://...&quot;&#10;steps:&#10;  - action: wait&#10;    selector: ..."
                  value={editAppConfigYaml}
                  onChange={(e) => setEditAppConfigYaml(e.target.value)}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="edit-workflow-project">Project</Label>
              {editWorkflow?.projectId ? (
                <div className="flex items-center gap-2 p-2 border rounded-md bg-muted/50">
                  <FolderKanban className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">
                    {projects?.find(p => p.id === editWorkflow.projectId)?.name || `Project #${editWorkflow.projectId}`}
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
              {!editWorkflow?.projectId && (
                <p className="text-xs text-muted-foreground">
                  Once attached to a project, this cannot be changed.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEditOpen(false); setEditWorkflow(null); }}>
              Cancel
            </Button>
            <Button
              onClick={() => editMutation.mutate()}
              disabled={editMutation.isPending || !editName}
            >
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Workflow className="h-5 w-5" />
            Workflows
          </CardTitle>
          <CardDescription>
            {isPrincipal
              ? "As a principal user, you can mark workflows as mainline for the official evaluation."
              : "View and manage your test workflows."
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
          ) : workflows && workflows.length > 0 ? (
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
                {workflows.map((workflow) => (
                  <TableRow
                    key={workflow.id}
                    data-testid={`row-workflow-${workflow.id}`}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setLocation(`/console/workflows/${workflow.id}`)}
                  >
                    <TableCell>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-medium">{workflow.name}</div>
                          {workflow.description && (
                            <div className="text-sm text-muted-foreground">{workflow.description}</div>
                          )}
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </TableCell>
                    {hasProjects && (
                      <TableCell>
                        {workflow.projectId ? (
                          <Badge variant="outline" className="gap-1">
                            <FolderKanban className="h-3 w-3" />
                            {projects?.find(p => p.id === workflow.projectId)?.name || `#${workflow.projectId}`}
                          </Badge>
                        ) : (
                          <span className="text-sm text-muted-foreground">--</span>
                        )}
                      </TableCell>
                    )}
                    <TableCell>
                      <Badge variant="outline" className="gap-1">
                        {workflow.visibility === "public" ? (
                          <><Globe className="h-3 w-3" /> Public</>
                        ) : (
                          <><Lock className="h-3 w-3" /> Private</>
                        )}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {workflow.isMainline ? (
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
                          checked={workflow.isMainline}
                          onCheckedChange={(checked) => {
                            toggleMainlineMutation.mutate({ id: workflow.id, isMainline: checked });
                          }}
                          disabled={workflow.visibility === "private" && !workflow.isMainline}
                          data-testid={`switch-mainline-${workflow.id}`}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </TableCell>
                    )}
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {String(workflow.ownerId) === String(authStatus?.user?.id) ? (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                openEditDialog(workflow);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteTarget(workflow);
                                setDeleteConfirmName("");
                              }}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </>
                        ) : workflow.visibility === "public" ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              cloneMutation.mutate(workflow.id);
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
              No workflows yet. Create your first workflow to get started.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete Workflow Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteConfirmName(""); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Workflow</AlertDialogTitle>
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
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteConfirmName !== deleteTarget?.name || deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
