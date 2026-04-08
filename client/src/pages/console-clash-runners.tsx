import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Server, MapPin, Activity, Clock, Plus, Key, Copy, Check, Ban } from "lucide-react";
import { useState } from "react";
import { formatSmartTimestamp } from "@/lib/utils";

interface ClashRunner {
  id: number;
  runnerId: string;
  region: string;
  state: "idle" | "assigned" | "running" | "draining";
  currentMatchId: number | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
}

interface RunnerToken {
  id: number;
  name: string;
  region: string;
  isRevoked: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

const REGIONS = [
  { value: "na", label: "North America" },
  { value: "apac", label: "Asia Pacific" },
  { value: "eu", label: "Europe" },
];

function getStateBadge(state: string) {
  switch (state) {
    case "idle":
      return <Badge className="bg-green-500">Idle</Badge>;
    case "assigned":
      return <Badge className="bg-blue-500">Assigned</Badge>;
    case "running":
      return <Badge className="bg-yellow-500">Running</Badge>;
    case "draining":
    default:
      return <Badge variant="secondary">Draining</Badge>;
  }
}

export default function ConsoleClashRunners() {
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [region, setRegion] = useState("na");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: runners, isLoading: runnersLoading } = useQuery<ClashRunner[]>({
    queryKey: ["/api/admin/clash-runners"],
    refetchInterval: 10000,
  });

  const { data: tokens, isLoading: tokensLoading } = useQuery<RunnerToken[]>({
    queryKey: ["/api/admin/clash-runner-tokens"],
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/clash-runner-tokens", { name, region });
      return res.json();
    },
    onSuccess: (data) => {
      setNewToken(data.token);
      setName("");
      setRegion("na");
      queryClient.invalidateQueries({ queryKey: ["/api/admin/clash-runner-tokens"] });
      toast({ title: "Runner token created" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create token", description: error.message, variant: "destructive" });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/admin/clash-runner-tokens/${id}/revoke`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/clash-runner-tokens"] });
      toast({ title: "Token revoked" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to revoke token", description: error.message, variant: "destructive" });
    },
  });

  const handleCopy = () => {
    if (newToken) {
      navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleClose = () => {
    setCreateOpen(false);
    setNewToken(null);
    setCopied(false);
  };

  const idleCount = runners?.filter(r => r.state === "idle").length || 0;
  const runningCount = runners?.filter(r => r.state === "running" || r.state === "assigned").length || 0;
  const drainingCount = runners?.filter(r => r.state === "draining").length || 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Clash Runners</h1>
        <p className="text-muted-foreground">Manage runner tokens and monitor connected clash runners</p>
      </div>

      {/* Status summary */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Idle</CardTitle>
            <Activity className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-500">{idleCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Running</CardTitle>
            <Activity className="h-4 w-4 text-yellow-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-500">{runningCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Draining</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-muted-foreground">{drainingCount}</div>
          </CardContent>
        </Card>
      </div>

      {/* Connected runners */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            Connected Runners
          </CardTitle>
          <CardDescription>
            Clash runners registered in the pool. Runners are assigned matches automatically when an event goes live.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {runnersLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : runners && runners.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Runner ID</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Current Match</TableHead>
                  <TableHead>Last Heartbeat</TableHead>
                  <TableHead>Registered</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runners.map(runner => (
                  <TableRow key={runner.id}>
                    <TableCell className="font-mono text-sm">{runner.runnerId}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="gap-1">
                        <MapPin className="h-3 w-3" />
                        {REGIONS.find(r => r.value === runner.region)?.label || runner.region}
                      </Badge>
                    </TableCell>
                    <TableCell>{getStateBadge(runner.state)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {runner.currentMatchId ? `#${runner.currentMatchId}` : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {runner.lastHeartbeatAt ? formatSmartTimestamp(runner.lastHeartbeatAt) : "Never"}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatSmartTimestamp(runner.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No runners connected. Create a token below and deploy a clash runner container.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Runner tokens */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Key className="h-5 w-5" />
                Runner Tokens
              </CardTitle>
              <CardDescription className="mt-1.5">
                Issue tokens for clash runner deployments. Each runner needs a unique token to register.
              </CardDescription>
            </div>
            <Dialog open={createOpen} onOpenChange={open => { if (!open) handleClose(); else setCreateOpen(true); }}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  New Token
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create Runner Token</DialogTitle>
                  <DialogDescription>
                    Issue a token for a clash runner deployment. The token is shown once — copy it before closing.
                  </DialogDescription>
                </DialogHeader>
                {!newToken ? (
                  <>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label>Name</Label>
                        <Input
                          placeholder="e.g. NA Runner 1"
                          value={name}
                          onChange={e => setName(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Region</Label>
                        <Select value={region} onValueChange={setRegion}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {REGIONS.map(r => (
                              <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={handleClose}>Cancel</Button>
                      <Button
                        onClick={() => createMutation.mutate()}
                        disabled={!name || createMutation.isPending}
                      >
                        {createMutation.isPending ? "Creating..." : "Create Token"}
                      </Button>
                    </DialogFooter>
                  </>
                ) : (
                  <>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label>Token</Label>
                        <div className="flex gap-2">
                          <Input value={newToken} readOnly className="font-mono text-sm" />
                          <Button size="icon" variant="outline" onClick={handleCopy}>
                            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">Copy this token now — it won't be shown again.</p>
                      </div>
                      <div className="p-3 bg-muted rounded-md space-y-2 text-xs">
                        <p className="font-medium">Deploy the runner:</p>
                        <code className="break-all block">
                          docker run -e RUNNER_TOKEN={newToken} -e VOX_SERVER={window.location.origin} -e RUNNER_REGION={region} vox-clash-runner
                        </code>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button onClick={handleClose}>Done</Button>
                    </DialogFooter>
                  </>
                )}
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          {tokensLoading ? (
            <div className="space-y-4">
              {[1, 2].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : tokens && tokens.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Used</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map(token => (
                  <TableRow key={token.id}>
                    <TableCell className="font-medium">{token.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="gap-1">
                        <MapPin className="h-3 w-3" />
                        {REGIONS.find(r => r.value === token.region)?.label || token.region}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {token.isRevoked
                        ? <Badge variant="destructive">Revoked</Badge>
                        : <Badge variant="outline">Active</Badge>
                      }
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {token.lastUsedAt ? formatSmartTimestamp(token.lastUsedAt) : "Never"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatSmartTimestamp(token.createdAt)}
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
              No tokens yet. Create one to deploy a clash runner.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
