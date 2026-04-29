import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Save, LogOut, ArrowRight, FolderKanban, Workflow, FileText, CalendarClock } from "lucide-react";
import { formatRegion } from "@/lib/utils";

interface AuthStatus {
  user: {
    id: number;
    organizationId: number | null;
    orgRole: string | null;
  } | null;
}

interface Organization {
  id: number;
  name: string;
  address: string | null;
}

interface Project { id: number; name: string; organizationId: number | null; }
interface WorkflowItem { id: number; name: string; projectId: number | null; organizationId: number | null; }
interface EvalSetItem { id: number; name: string; organizationId: number | null; }
interface ScheduleItem { id: number; name: string; workflowName: string; region: string; organizationId: number | null; }

export default function ConsoleOrganizationSettings() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const { data: org, isLoading } = useQuery<Organization>({
    queryKey: ["/api/user/organization"],
    enabled: !!authStatus?.user?.organizationId,
  });

  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [moveOpen, setMoveOpen] = useState(false);

  useEffect(() => {
    if (org) {
      setName(org.name);
      setAddress(org.address || "");
    }
  }, [org]);

  const updateMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/organizations/${org?.id}`, { name, address });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user/organization"] });
      toast({ title: "Settings saved" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to save", description: error.message, variant: "destructive" });
    },
  });

  const leaveMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/organizations/${org?.id}/leave`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/organization"] });
      setLocation("/console/organization/create");
      toast({ title: "Left organization" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to leave", description: error.message, variant: "destructive" });
    },
  });

  const handleSave = () => updateMutation.mutate();

  if (isLoading) {
    return <div className="space-y-6"><Skeleton className="h-48 w-full" /></div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Organization Settings</h1>
        <p className="text-muted-foreground">Manage your organization</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="org-name">Organization Name</Label>
            <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="org-address">Address</Label>
            <Textarea id="org-address" value={address} onChange={(e) => setAddress(e.target.value)} rows={3} />
          </div>
          <Button onClick={handleSave} disabled={updateMutation.isPending || !name}>
            <Save className="mr-2 h-4 w-4" />
            {updateMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </CardContent>
      </Card>

      {/* Move Resources */}
      <Card>
        <CardHeader>
          <CardTitle>Move Resources</CardTitle>
          <CardDescription>
            Move your personal resources to the organization. This is irreversible — moved resources belong to the org permanently.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" className="gap-2" onClick={() => setMoveOpen(true)}>
            <ArrowRight className="h-4 w-4" />
            Move resources from personal to organization
          </Button>
        </CardContent>
      </Card>

      <MoveResourcesDialog open={moveOpen} onOpenChange={setMoveOpen} orgName={org?.name || "Organization"} />

      {/* Danger Zone */}
      <Card className="border-red-500/50">
        <CardHeader>
          <CardTitle className="text-red-500">Danger Zone</CardTitle>
          <CardDescription>Irreversible actions</CardDescription>
        </CardHeader>
        <CardContent>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" disabled={authStatus?.user?.orgRole === 'owner'}>
                <LogOut className="mr-2 h-4 w-4" />
                Leave Organization
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Leave Organization</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to leave this organization? You will lose access to
                  organization resources and will need to be re-invited to join again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => leaveMutation.mutate()}
                  className="bg-red-500 hover:bg-red-600"
                >
                  Leave Organization
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>
    </div>
  );
}

function MoveResourcesDialog({ open, onOpenChange, orgName }: { open: boolean; onOpenChange: (open: boolean) => void; orgName: string }) {
  const { toast } = useToast();

  const { data: projects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
    enabled: open,
  });

  const { data: workflows } = useQuery<WorkflowItem[]>({
    queryKey: ["/api/workflows"],
    enabled: open,
  });

  const { data: evalSets } = useQuery<EvalSetItem[]>({
    queryKey: ["/api/eval-sets"],
    enabled: open,
  });

  const { data: schedules } = useQuery<ScheduleItem[]>({
    queryKey: ["/api/eval-schedules"],
    enabled: open,
  });

  // Filter to personal resources only (no organizationId)
  const personalProjects = projects?.filter(p => !p.organizationId) ?? [];
  const personalWorkflows = workflows?.filter(w => !w.organizationId) ?? [];
  const personalEvalSets = evalSets?.filter(e => !e.organizationId) ?? [];
  const personalSchedules = schedules?.filter(s => !s.organizationId) ?? [];

  const [selectedProjects, setSelectedProjects] = useState<Set<number>>(new Set());
  const [selectedWorkflows, setSelectedWorkflows] = useState<Set<number>>(new Set());
  const [selectedEvalSets, setSelectedEvalSets] = useState<Set<number>>(new Set());
  const [selectedSchedules, setSelectedSchedules] = useState<Set<number>>(new Set());

  const toggleSet = (set: Set<number>, id: number, setter: (s: Set<number>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    setter(next);
  };

  const totalSelected = selectedProjects.size + selectedWorkflows.size + selectedEvalSets.size + selectedSchedules.size;
  const hasPersonalResources = personalProjects.length + personalWorkflows.length + personalEvalSets.length + personalSchedules.length > 0;

  const moveMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/organizations/move-resources", {
        projectIds: Array.from(selectedProjects),
        workflowIds: Array.from(selectedWorkflows),
        evalSetIds: Array.from(selectedEvalSets),
        scheduleIds: Array.from(selectedSchedules),
      }).then(r => r.json());
    },
    onSuccess: (data) => {
      const m = data.moved;
      toast({ title: "Resources moved", description: `${m.projects} projects, ${m.workflows} workflows, ${m.evalSets} eval sets, ${m.schedules} schedules` });
      setSelectedProjects(new Set());
      setSelectedWorkflows(new Set());
      setSelectedEvalSets(new Set());
      setSelectedSchedules(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/workflows"] });
      queryClient.invalidateQueries({ queryKey: ["/api/eval-sets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/eval-schedules"] });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to move", description: error.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Move Resources to {orgName}</DialogTitle>
          <DialogDescription>
            Select personal resources to move. This is permanent — moved resources belong to the organization and cannot be moved back.
          </DialogDescription>
        </DialogHeader>

        {!hasPersonalResources ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No personal resources to move.</p>
        ) : (
          <div className="space-y-6 py-2">
            {/* Projects */}
            {personalProjects.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <FolderKanban className="h-4 w-4" />
                  Projects ({personalProjects.length})
                </div>
                <div className="space-y-1 ml-6">
                  {personalProjects.map(p => (
                    <label key={p.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/50 rounded px-2 py-1">
                      <Checkbox checked={selectedProjects.has(p.id)} onCheckedChange={() => toggleSet(selectedProjects, p.id, setSelectedProjects)} />
                      {p.name}
                      <Badge variant="outline" className="text-xs ml-auto">+ child workflows</Badge>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Workflows */}
            {personalWorkflows.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Workflow className="h-4 w-4" />
                  Workflows ({personalWorkflows.length})
                </div>
                <div className="space-y-1 ml-6">
                  {personalWorkflows.map(w => (
                    <label key={w.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/50 rounded px-2 py-1">
                      <Checkbox checked={selectedWorkflows.has(w.id)} onCheckedChange={() => toggleSet(selectedWorkflows, w.id, setSelectedWorkflows)} />
                      {w.name}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Eval Sets */}
            {personalEvalSets.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <FileText className="h-4 w-4" />
                  Eval Sets ({personalEvalSets.length})
                </div>
                <div className="space-y-1 ml-6">
                  {personalEvalSets.map(e => (
                    <label key={e.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/50 rounded px-2 py-1">
                      <Checkbox checked={selectedEvalSets.has(e.id)} onCheckedChange={() => toggleSet(selectedEvalSets, e.id, setSelectedEvalSets)} />
                      {e.name}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Schedules */}
            {personalSchedules.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <CalendarClock className="h-4 w-4" />
                  Schedules ({personalSchedules.length})
                </div>
                <div className="space-y-1 ml-6">
                  {personalSchedules.map(s => (
                    <label key={s.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/50 rounded px-2 py-1">
                      <Checkbox checked={selectedSchedules.has(s.id)} onCheckedChange={() => toggleSet(selectedSchedules, s.id, setSelectedSchedules)} />
                      {s.name}
                      <span className="text-xs text-muted-foreground ml-auto">{s.workflowName} / {formatRegion(s.region)}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => moveMutation.mutate()}
            disabled={totalSelected === 0 || moveMutation.isPending}
          >
            {moveMutation.isPending ? "Moving..." : `Move ${totalSelected} resource${totalSelected !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
