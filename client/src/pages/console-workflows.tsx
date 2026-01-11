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
import { Plus, Workflow, Globe, Lock, Star, StarOff, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import type { Workflow as WorkflowType } from "@shared/schema";

interface AuthStatus {
  user: {
    id: string;
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

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const { data: workflows, isLoading } = useQuery<WorkflowType[]>({
    queryKey: ["/api/workflows"],
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/workflows", {
        name,
        description,
        visibility,
      });
      return res.json();
    },
    onSuccess: () => {
      setCreateOpen(false);
      setName("");
      setDescription("");
      setVisibility("public");
      queryClient.invalidateQueries({ queryKey: ["/api/workflows"] });
      toast({ title: "Workflow created" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create workflow", description: error.message, variant: "destructive" });
    },
  });

  const toggleMainlineMutation = useMutation({
    mutationFn: async ({ id, isMainline }: { id: number; isMainline: boolean }) => {
      const res = await apiRequest("PATCH", `/api/workflows/${id}/mainline`, { isMainline });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/workflows"] });
      toast({ title: "Workflow updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update workflow", description: error.message, variant: "destructive" });
    },
  });

  const isPrincipal = authStatus?.user?.plan === "principal";
  const canCreatePrivate = authStatus?.user?.plan !== "basic";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Test Workflows</h1>
          <p className="text-muted-foreground">Manage benchmark test workflows</p>
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
                Create a new test workflow for benchmarking.
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
            </div>
            <DialogFooter>
              <Button
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || !name}
                data-testid="button-submit-workflow"
              >
                Create Workflow
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Workflow className="h-5 w-5" />
            Workflows
          </CardTitle>
          <CardDescription>
            {isPrincipal 
              ? "As a principal user, you can mark workflows as mainline for the official benchmark."
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
                  <TableHead>Visibility</TableHead>
                  <TableHead>Status</TableHead>
                  {isPrincipal && <TableHead className="text-right">Mainline</TableHead>}
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
                      <TableCell className="text-right">
                        <Switch
                          checked={workflow.isMainline}
                          onCheckedChange={(checked) =>
                            toggleMainlineMutation.mutate({ id: workflow.id, isMainline: checked })
                          }
                          disabled={workflow.visibility === "private" && !workflow.isMainline}
                          data-testid={`switch-mainline-${workflow.id}`}
                        />
                      </TableCell>
                    )}
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
    </div>
  );
}
