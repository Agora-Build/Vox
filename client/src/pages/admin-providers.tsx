import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Box, Palette, Pencil } from "lucide-react";
import { useState } from "react";

interface Provider {
  id: string;
  name: string;
  sku: string;
  description: string | null;
  brandColor: string | null;
  isActive: boolean;
  createdAt: string;
}

export default function AdminProviders() {
  const { toast } = useToast();
  const [editProvider, setEditProvider] = useState<Provider | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editColor, setEditColor] = useState("");

  const { data: providers, isLoading } = useQuery<Provider[]>({
    queryKey: ["/api/providers"],
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Record<string, unknown> }) => {
      return apiRequest("PATCH", `/api/providers/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/providers"] });
      toast({ title: "Provider updated" });
      setEditProvider(null);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update", description: error.message, variant: "destructive" });
    },
  });

  const toggleActive = (provider: Provider) => {
    updateMutation.mutate({ id: provider.id, data: { isActive: !provider.isActive } });
  };

  const openEdit = (provider: Provider) => {
    setEditProvider(provider);
    setEditName(provider.name);
    setEditDescription(provider.description ?? "");
    setEditColor(provider.brandColor ?? "");
  };

  const submitEdit = () => {
    if (!editProvider) return;
    updateMutation.mutate({
      id: editProvider.id,
      data: {
        name: editName,
        description: editDescription || null,
        brandColor: editColor || null,
      },
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const activeCount = providers?.filter(p => p.isActive).length ?? 0;
  const withColorCount = providers?.filter(p => p.brandColor).length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Providers</h1>
          <p className="text-muted-foreground">Manage AI providers and brand colors</p>
        </div>
        <Badge variant="outline" className="gap-1">
          <Box className="h-3 w-3" />
          {providers?.length ?? 0} providers
        </Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active</CardTitle>
            <Box className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">With Brand Color</CardTitle>
            <Palette className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{withColorCount}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Providers</CardTitle>
          <CardDescription>Edit provider names, descriptions, and brand colors for chart display</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Brand Color</TableHead>
                <TableHead>Active</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers?.map((provider) => (
                <TableRow key={provider.id}>
                  <TableCell>
                    <div className="font-medium">{provider.name}</div>
                    {provider.description && (
                      <div className="text-sm text-muted-foreground">{provider.description}</div>
                    )}
                    <div className="text-xs text-muted-foreground font-mono mt-0.5">{provider.id}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{provider.sku}</Badge>
                  </TableCell>
                  <TableCell>
                    {provider.brandColor ? (
                      <div className="flex items-center gap-2">
                        <div
                          className="w-6 h-6 rounded border"
                          style={{ backgroundColor: provider.brandColor }}
                        />
                        <span className="font-mono text-sm">{provider.brandColor}</span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-sm">Not set</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={provider.isActive}
                      onCheckedChange={() => toggleActive(provider)}
                      disabled={updateMutation.isPending}
                    />
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(provider)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {(!providers || providers.length === 0) && (
            <div className="text-center py-8 text-muted-foreground">
              No providers found
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!editProvider} onOpenChange={(open) => { if (!open) setEditProvider(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Provider</DialogTitle>
            <DialogDescription>Update provider details and brand color</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Name</Label>
              <Input id="edit-name" value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-description">Description</Label>
              <Input id="edit-description" value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-color">Brand Color</Label>
              <div className="flex items-center gap-3">
                <Input
                  id="edit-color"
                  value={editColor}
                  onChange={(e) => setEditColor(e.target.value)}
                  placeholder="#099DFD"
                  className="font-mono"
                />
                <input
                  type="color"
                  value={editColor || "#000000"}
                  onChange={(e) => setEditColor(e.target.value)}
                  className="w-10 h-10 rounded cursor-pointer border-0 p-0 shrink-0"
                />
              </div>
              <p className="text-xs text-muted-foreground">Hex color code used for chart lines on the realtime page. Leave empty to use default.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditProvider(null)}>Cancel</Button>
            <Button onClick={submitEdit} disabled={updateMutation.isPending}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
