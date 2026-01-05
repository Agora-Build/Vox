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
import { Plus, FileText, Globe, Lock, Star } from "lucide-react";
import { useState } from "react";
import type { TestSet } from "@shared/schema";

interface AuthStatus {
  user: {
    id: string;
    username: string;
    plan: string;
    isAdmin: boolean;
  } | null;
}

export default function ConsoleTestSets() {
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState("public");

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const { data: testSets, isLoading } = useQuery<TestSet[]>({
    queryKey: ["/api/test-sets"],
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/test-sets", {
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
      queryClient.invalidateQueries({ queryKey: ["/api/test-sets"] });
      toast({ title: "Test set created" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create test set", description: error.message, variant: "destructive" });
    },
  });

  const toggleMainlineMutation = useMutation({
    mutationFn: async ({ id, isMainline }: { id: number; isMainline: boolean }) => {
      const res = await apiRequest("PATCH", `/api/test-sets/${id}/mainline`, { isMainline });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/test-sets"] });
      toast({ title: "Test set updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update test set", description: error.message, variant: "destructive" });
    },
  });

  const isPrincipal = authStatus?.user?.plan === "principal";
  const canCreatePrivate = authStatus?.user?.plan !== "basic";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Test Sets</h1>
          <p className="text-muted-foreground">Manage benchmark test configurations</p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-create-testset">
              <Plus className="mr-2 h-4 w-4" />
              New Test Set
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Test Set</DialogTitle>
              <DialogDescription>
                Create a new test set for benchmarking.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="testset-name">Name</Label>
                <Input
                  id="testset-name"
                  placeholder="My Test Set"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="input-testset-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="testset-description">Description</Label>
                <Textarea
                  id="testset-description"
                  placeholder="Describe what this test set measures..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  data-testid="input-testset-description"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="testset-visibility">Visibility</Label>
                <Select value={visibility} onValueChange={setVisibility}>
                  <SelectTrigger data-testid="select-testset-visibility">
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
                data-testid="button-submit-testset"
              >
                Create Test Set
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Test Sets
          </CardTitle>
          <CardDescription>
            {isPrincipal
              ? "As a principal user, you can mark test sets as mainline for the official benchmark."
              : "View and manage your test configurations."
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
          ) : testSets && testSets.length > 0 ? (
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
                {testSets.map((testSet) => (
                  <TableRow key={testSet.id} data-testid={`row-testset-${testSet.id}`}>
                    <TableCell>
                      <div>
                        <div className="font-medium">{testSet.name}</div>
                        {testSet.description && (
                          <div className="text-sm text-muted-foreground">{testSet.description}</div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="gap-1">
                        {testSet.visibility === "public" ? (
                          <><Globe className="h-3 w-3" /> Public</>
                        ) : (
                          <><Lock className="h-3 w-3" /> Private</>
                        )}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {testSet.isMainline ? (
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
                          checked={testSet.isMainline}
                          onCheckedChange={(checked) =>
                            toggleMainlineMutation.mutate({ id: testSet.id, isMainline: checked })
                          }
                          disabled={testSet.visibility === "private" && !testSet.isMainline}
                          data-testid={`switch-mainline-${testSet.id}`}
                        />
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No test sets yet. Create your first test set to get started.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
