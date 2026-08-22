import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Radio, Plus, Copy, Check, Ban, KeyRound, Wifi, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

type Broker = {
  id: number;
  name: string;
  tokenId: number;
  brokerType: string;
  url: string;
  state: string;
  currentLeaseId: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type BrokerToken = {
  id: number;
  name: string;
  isRevoked: boolean;
  lastUsedAt: string | null;
  createdAt: string;
};

type MintResponse = { id: number; name: string; token: string };

const fmt = (value: string | null) => (value ? new Date(value).toLocaleString() : "—");

function StateBadge({ state }: { state: string }) {
  if (state === "idle" || state === "occupied") {
    return <Badge className="gap-1"><Wifi className="h-3 w-3" />{state}</Badge>;
  }
  return <Badge variant="outline" className="gap-1 text-muted-foreground"><WifiOff className="h-3 w-3" />{state}</Badge>;
}

export default function AdminBrokers() {
  const { toast } = useToast();

  const { data: brokers, isLoading: brokersLoading } = useQuery<Broker[]>({
    queryKey: ["/api/admin/brokers"],
    // Live registry — brokers heartbeat every 60s, so keep it fresh.
    refetchInterval: 15000,
  });
  // Hide offline brokers — the reaper marks them offline after prolonged
  // silence; the row is kept in the DB but not shown in the live registry.
  const visibleBrokers = brokers?.filter((b) => b.state !== "offline");
  const { data: tokens, isLoading: tokensLoading } = useQuery<BrokerToken[]>({
    queryKey: ["/api/admin/broker-tokens"],
  });

  const [mintOpen, setMintOpen] = useState(false);
  const [mintName, setMintName] = useState("");
  const [minted, setMinted] = useState<MintResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeId, setRevokeId] = useState<number | null>(null);

  const mintMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/broker-tokens", { name: mintName });
      return res.json() as Promise<MintResponse>;
    },
    onSuccess: (data) => {
      setMinted(data);
      setMintOpen(false);
      setMintName("");
      queryClient.invalidateQueries({ queryKey: ["/api/admin/broker-tokens"] });
    },
    onError: (error: Error) => {
      toast({ title: "Could not create broker", description: error.message, variant: "destructive" });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/admin/broker-tokens/${id}/revoke`);
    },
    onSuccess: () => {
      setRevokeId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/broker-tokens"] });
      toast({ title: "Registration token revoked" });
    },
    onError: (error: Error) => {
      setRevokeId(null);
      toast({ title: "Could not revoke token", description: error.message, variant: "destructive" });
    },
  });

  const copyToken = async (token: string) => {
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Brokers</h1>
        <p className="text-muted-foreground">
          Auth-session broker sidecars mint login sessions so agents never see raw credentials. Mint a
          registration token, set it as <code className="bg-muted px-1 rounded text-xs">BROKER_REG_TOKEN</code> on the
          broker deployment, and it will self-register and appear below.
        </p>
      </div>

      {/* Registered brokers (live registry) */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Radio className="h-5 w-5" />
          <h2 className="text-lg font-semibold">Registered Brokers</h2>
        </div>
        <div className="border">
          {brokersLoading ? (
            <div className="p-4"><Skeleton className="h-24 w-full" /></div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Advertise URL</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Last Seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleBrokers?.map((broker) => (
                  <TableRow key={broker.id}>
                    <TableCell className="font-medium">{broker.name}</TableCell>
                    <TableCell><Badge variant="outline">{broker.brokerType}</Badge></TableCell>
                    <TableCell className="font-mono text-xs break-all">{broker.url}</TableCell>
                    <TableCell><StateBadge state={broker.state} /></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{fmt(broker.lastSeenAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {!brokersLoading && (visibleBrokers?.length ?? 0) === 0 && (
            <div className="py-12 text-center text-muted-foreground">
              No brokers registered. Mint a token below and deploy a broker with it.
            </div>
          )}
        </div>
      </div>

      {/* Registration tokens */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            <h2 className="text-lg font-semibold">Registration Tokens</h2>
          </div>
          <Button onClick={() => setMintOpen(true)}><Plus className="mr-2 h-4 w-4" />Create Broker</Button>
        </div>
        <div className="border">
          {tokensLoading ? (
            <div className="p-4"><Skeleton className="h-24 w-full" /></div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Used</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[80px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens?.map((token) => (
                  <TableRow key={token.id}>
                    <TableCell className="font-medium">{token.name}</TableCell>
                    <TableCell>
                      {token.isRevoked
                        ? <Badge variant="outline" className="text-muted-foreground">revoked</Badge>
                        : <Badge>active</Badge>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{fmt(token.lastUsedAt)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{fmt(token.createdAt)}</TableCell>
                    <TableCell>
                      {!token.isRevoked && (
                        <Button variant="ghost" size="icon" title="Revoke token" onClick={() => setRevokeId(token.id)}>
                          <Ban className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {!tokensLoading && (tokens?.length ?? 0) === 0 && (
            <div className="py-12 text-center text-muted-foreground">No registration tokens yet.</div>
          )}
        </div>
      </div>

      {/* Mint dialog */}
      <Dialog open={mintOpen} onOpenChange={setMintOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Broker</DialogTitle>
            <DialogDescription>
              A broker registers against Core with this token. The plaintext value is shown once.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="broker-token-name">Name</Label>
              <Input
                id="broker-token-name"
                value={mintName}
                placeholder="prod-auth-session-broker"
                onChange={(e) => setMintName(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMintOpen(false)}>Cancel</Button>
            <Button disabled={!mintName.trim() || mintMutation.isPending} onClick={() => mintMutation.mutate()}>
              Create Broker
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reveal-once dialog */}
      <Dialog open={!!minted} onOpenChange={(open) => { if (!open) setMinted(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Broker Created</DialogTitle>
            <DialogDescription>Copy this token now. It will not be shown again.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
              <code className="flex-1 text-sm font-mono break-all">{minted?.token}</code>
              <Button variant="ghost" size="icon" className="shrink-0" onClick={() => minted && copyToken(minted.token)}>
                {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Set it on the broker deployment as <code className="bg-muted px-1 rounded">BROKER_REG_TOKEN</code>, then
              redeploy — the broker will self-register and appear under Registered Brokers.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => setMinted(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirmation */}
      <AlertDialog open={revokeId != null} onOpenChange={(open) => { if (!open) setRevokeId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke Registration Token</AlertDialogTitle>
            <AlertDialogDescription>
              A broker will no longer be able to register or re-register with this token. Brokers already registered
              keep their current lease until they next re-register. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => revokeId != null && revokeMutation.mutate(revokeId)}>Revoke</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
