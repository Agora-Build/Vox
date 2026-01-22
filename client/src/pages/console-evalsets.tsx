import { useQuery, useMutation } from "@tanstack/react-query";
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
import { Plus, FileText, Globe, Lock, Star } from "lucide-react";
import { useState } from "react";
import type { EvalSet } from "@shared/schema";

interface AuthStatus {
  user: {
    id: string;
    username: string;
    plan: string;
    isAdmin: boolean;
  } | null;
}

export default function ConsoleEvalSets() {
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState("public");

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const { data: evalSets, isLoading } = useQuery<EvalSet[]>({
    queryKey: ["/api/eval-sets"],
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/eval-sets", {
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
      queryClient.invalidateQueries({ queryKey: ["/api/eval-sets"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/eval-sets"] });
      toast({ title: "Eval set updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update eval set", description: error.message, variant: "destructive" });
    },
  });

  const isPrincipal = authStatus?.user?.plan === "principal";
  const canCreatePrivate = authStatus?.user?.plan !== "basic";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Eval Sets</h1>
          <p className="text-muted-foreground">Manage benchmark evaluation configurations</p>
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
                Create a new evaluation set for benchmarking.
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
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Eval Sets
          </CardTitle>
          <CardDescription>
            {isPrincipal
              ? "As a principal user, you can mark eval sets as mainline for the official benchmark."
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
                  {isPrincipal && <TableHead className="text-right">Mainline</TableHead>}
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
                      <TableCell className="text-right">
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
    </div>
  );
}
