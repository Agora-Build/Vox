import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Plus, Key, MapPin, Copy, Check, Ban, Eye, EyeOff } from "lucide-react";
import { useState } from "react";

interface AuthStatus {
  initialized: boolean;
  user: {
    id: string;
    username: string;
    email: string;
    plan: string;
    isAdmin: boolean;
  } | null;
}

interface EvalAgentToken {
  id: number;
  name: string;
  token: string;
  region: string;
  visibility: "public" | "private";
  isRevoked: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

const REGIONS = [
  { value: "na", label: "North America" },
  { value: "apac", label: "Asia Pacific" },
  { value: "eu", label: "Europe" },
];

export default function ConsoleEvalAgentTokens() {
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [region, setRegion] = useState("");
  const [visibility, setVisibility] = useState<string>("public");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const isAdmin = authStatus?.user?.isAdmin || false;

  // Use the user-facing endpoint (returns all for admin, own for non-admin)
  const { data: tokens, isLoading } = useQuery<EvalAgentToken[]>({
    queryKey: ["/api/eval-agent-tokens"],
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, string> = { name, region };
      if (isAdmin) {
        body.visibility = visibility;
      }
      const res = await apiRequest("POST", "/api/eval-agent-tokens", body);
      return res.json();
    },
    onSuccess: (data) => {
      setNewToken(data.token);
      setName("");
      setRegion("");
      setVisibility("public");
      queryClient.invalidateQueries({ queryKey: ["/api/eval-agent-tokens"] });
      toast({ title: "Eval agent token created" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create token", description: error.message, variant: "destructive" });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (tokenId: number) => {
      const res = await apiRequest("POST", `/api/eval-agent-tokens/${tokenId}/revoke`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/eval-agent-tokens"] });
      toast({ title: "Token revoked" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to revoke token", description: error.message, variant: "destructive" });
    },
  });

  const handleCopyToken = () => {
    if (newToken) {
      navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleCloseDialog = () => {
    setCreateOpen(false);
    setNewToken(null);
    setCopied(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Agent Tokens</h1>
          <p className="text-muted-foreground">
            {isAdmin
              ? "Manage tokens for eval agent registration"
              : "Manage your private eval agent tokens"}
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={(open) => {
          if (!open) handleCloseDialog();
          else setCreateOpen(true);
        }}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              New Token
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Agent Token</DialogTitle>
              <DialogDescription>
                {isAdmin
                  ? "Create a new token for eval agent registration."
                  : "Create a private token for your eval agent. Private tokens produce results visible only in your evals."}
              </DialogDescription>
            </DialogHeader>
            {!newToken ? (
              <>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="token-name">Name</Label>
                    <Input
                      id="token-name"
                      placeholder="NA Agent 1"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="token-region">Region</Label>
                    <Select value={region} onValueChange={setRegion}>
                      <SelectTrigger>
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
                  {isAdmin && (
                    <div className="space-y-2">
                      <Label htmlFor="token-visibility">Visibility</Label>
                      <Select value={visibility} onValueChange={setVisibility}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select visibility" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="public">Public</SelectItem>
                          <SelectItem value="private">Private</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {!isAdmin && (
                    <p className="text-xs text-muted-foreground">
                      Non-admin tokens are always private.
                    </p>
                  )}
                </div>
                <DialogFooter>
                  <Button
                    onClick={() => createMutation.mutate()}
                    disabled={createMutation.isPending || !name || !region}
                  >
                    Create Token
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label>Agent Token</Label>
                    <div className="flex gap-2">
                      <Input
                        value={newToken}
                        readOnly
                        className="font-mono text-sm"
                      />
                      <Button
                        size="icon"
                        variant="outline"
                        onClick={handleCopyToken}
                      >
                        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Copy this token now. It won't be shown again.
                    </p>
                  </div>
                  <div className="p-3 bg-muted rounded-md">
                    <p className="text-sm font-medium mb-2">Usage:</p>
                    <code className="text-xs">./vox_agent --up --token={newToken}</code>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={handleCloseDialog}>
                    Done
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            {isAdmin ? "All Eval Agent Tokens" : "Your Eval Agent Tokens"}
          </CardTitle>
          <CardDescription>
            Tokens allow eval agents to register and fetch jobs for their assigned region.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : tokens && tokens.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Visibility</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Used</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((token) => (
                  <TableRow key={token.id}>
                    <TableCell className="font-medium">{token.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="gap-1">
                        <MapPin className="h-3 w-3" />
                        {REGIONS.find(r => r.value === token.region)?.label || token.region}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={token.visibility === "public" ? "outline" : "secondary"} className="gap-1">
                        {token.visibility === "public" ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                        {token.visibility === "public" ? "Public" : "Private"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {token.isRevoked ? (
                        <Badge variant="destructive">Revoked</Badge>
                      ) : (
                        <Badge variant="outline">Active</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {token.lastUsedAt
                        ? new Date(token.lastUsedAt).toLocaleDateString()
                        : "Never"
                      }
                    </TableCell>
                    <TableCell className="text-right">
                      {!token.isRevoked && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => revokeMutation.mutate(token.id)}
                          disabled={revokeMutation.isPending}
                        >
                          <Ban className="h-4 w-4 mr-1" />
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No eval agent tokens yet. Create a token to allow eval agents to register.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
