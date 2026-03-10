import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { KeyRound, Plus, Trash2, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { formatSmartTimestamp } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface SecretEntry {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface SecretsResponse {
  encryptionConfigured: boolean;
  secrets: SecretEntry[];
}

export default function ConsoleSecrets() {
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");

  const { data: response, isLoading } = useQuery<SecretsResponse>({
    queryKey: ["/api/secrets"],
  });

  const encryptionConfigured = response?.encryptionConfigured ?? true;
  const secrets = response?.secrets;

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/secrets", { name: name.trim(), value });
      return res.json();
    },
    onSuccess: () => {
      setName("");
      setValue("");
      setCreateOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/secrets"] });
      toast({ title: "Secret saved" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to save secret", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (secretName: string) => {
      const res = await apiRequest("DELETE", `/api/secrets/${encodeURIComponent(secretName)}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/secrets"] });
      toast({ title: "Secret deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete secret", description: error.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Secrets</h1>
        <p className="text-muted-foreground">
          Manage encrypted credentials for your eval scenarios. Secrets are referenced in scenario YAML as{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">{"${secrets.KEY_NAME}"}</code>.
        </p>
      </div>

      {!encryptionConfigured && (
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Encryption not configured</AlertTitle>
          <AlertDescription>
            The server does not have <code className="text-xs bg-muted px-1 py-0.5 rounded">CREDENTIAL_ENCRYPTION_KEY</code> set.
            Secrets cannot be created or decrypted until an admin configures this environment variable.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-5 w-5" />
                Your Secrets
              </CardTitle>
              <CardDescription className="mt-1.5">
                Secret values are encrypted at rest and never displayed after creation.
              </CardDescription>
            </div>
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button disabled={!encryptionConfigured}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Secret
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Secret</DialogTitle>
                  <DialogDescription>
                    Create or update an encrypted secret. If a secret with this name already exists, its value will be replaced.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="secret-name">Name</Label>
                    <Input
                      id="secret-name"
                      placeholder="YOUR_EMAIL"
                      value={name}
                      onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
                      className="font-mono"
                    />
                    <p className="text-xs text-muted-foreground">
                      Uppercase letters, digits, and underscores only.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="secret-value">Value</Label>
                    <Input
                      id="secret-value"
                      type="password"
                      placeholder="Enter secret value"
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    onClick={() => createMutation.mutate()}
                    disabled={createMutation.isPending || !name.trim() || !value}
                  >
                    Save Secret
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : secrets && secrets.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Last Updated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {secrets.map((secret) => (
                  <TableRow key={secret.id}>
                    <TableCell className="font-mono font-medium">{secret.name}</TableCell>
                    <TableCell className="text-muted-foreground">••••••••</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatSmartTimestamp(secret.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => deleteMutation.mutate(secret.name)}
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4 mr-1" />
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No secrets yet. Add a secret to use in your eval scenarios.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How to use it</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-sm bg-muted p-4 rounded-md overflow-x-auto">{`- type: platform.setup
  platform_id: agora
  params:
    mode: account
    email: \${secrets.YOUR_EMAIL}
    password: \${secrets.YOUR_PASSWORD}`}</pre>
          <p className="text-xs text-muted-foreground mt-2">
            The eval agent resolves <code>{"${secrets.*}"}</code> placeholders before running the eval jobs.
            Secret values are never stored in job configs or logs.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
