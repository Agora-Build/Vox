import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { KeyRound, Plus, Trash2, ShieldAlert, Building2 } from "lucide-react";
import { useState } from "react";
import { useLocation, useSearch } from "wouter";
import { formatSmartTimestamp, brokerTypeLabel } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface SecretEntry {
  id: number;
  name: string;
  brokerType: string | null;
  isTestAccount: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SecretsResponse {
  encryptionConfigured: boolean;
  secrets: SecretEntry[];
}

interface OrgSecretEntry {
  name: string;
  brokerType: string | null;
  isTestAccount: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AuthStatus {
  user: {
    organizationId: number | null;
    orgRole: string | null;
  } | null;
}

export default function ConsoleSecrets() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const search = useSearch();
  const tabParam = new URLSearchParams(search).get("tab");

  const { data: auth } = useQuery<AuthStatus>({ queryKey: ["/api/auth/status"] });
  const hasOrg = !!auth?.user?.organizationId;
  const isOrgAdmin = auth?.user?.orgRole === "owner" || auth?.user?.orgRole === "admin";

  const activeTab = tabParam && ["personal", "org"].includes(tabParam) ? tabParam : "personal";
  const setTab = (tab: string) => setLocation(`/console/secrets?tab=${tab}`);

  // Personal secrets
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [brokerType, setBrokerType] = useState<string | null>("runtime");
  const [isTestAccount, setIsTestAccount] = useState(false);

  const { data: response, isLoading } = useQuery<SecretsResponse>({
    queryKey: ["/api/secrets"],
  });

  // Broker types serviceable right now (live, non-offline brokers). Runtime
  // (null) is always offered; each live type is added as a brokered option.
  const { data: liveBrokerTypes } = useQuery<string[]>({ queryKey: ["/api/broker-types"] });
  const brokerTypeOptions = liveBrokerTypes ?? [];

  // A secret whose name reads like a login identifier (email/account/user/name)
  // should default to the auth-session broker type — but only when such a broker
  // is actually live. If none is, Runtime stays the default. Names are uppercased,
  // so USER/NAME also cover USERNAME.
  const AUTH_NAME_HINT = /EMAIL|ACCOUNT|USER|NAME/;
  const authBrokerType = brokerTypeOptions.find((t) => /auth|session|login/i.test(t)) ?? null;
  // Toggle only between Runtime and the auth type — never clobber a different
  // broker type the user picked manually.
  function nextBrokerTypeForName(newName: string, current: string | null): string | null {
    if (!authBrokerType) return current;
    if (AUTH_NAME_HINT.test(newName)) return authBrokerType;
    if (current === authBrokerType) return "runtime";
    return current;
  }

  const encryptionConfigured = response?.encryptionConfigured ?? true;
  const secrets = response?.secrets;

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/secrets", {
        name: name.trim(),
        value,
        brokerType: brokerType === "runtime" ? null : brokerType,
        isTestAccount: brokerType === "auth-session" ? isTestAccount : undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      setName("");
      setValue("");
      setBrokerType("runtime");
      setIsTestAccount(false);
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

  // Org secrets
  const [orgCreateOpen, setOrgCreateOpen] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [orgValue, setOrgValue] = useState("");
  const [orgBrokerType, setOrgBrokerType] = useState<string | null>("runtime");
  const [orgIsTestAccount, setOrgIsTestAccount] = useState(false);

  const { data: orgSecrets, isLoading: orgLoading } = useQuery<OrgSecretEntry[]>({
    queryKey: ["/api/org-secrets"],
    enabled: hasOrg,
  });

  const orgCreateMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/org-secrets", {
        name: orgName.trim(),
        value: orgValue,
        brokerType: orgBrokerType === "runtime" ? null : orgBrokerType,
        isTestAccount: orgBrokerType === "auth-session" ? orgIsTestAccount : undefined,
      });
    },
    onSuccess: () => {
      setOrgName("");
      setOrgValue("");
      setOrgBrokerType("runtime");
      setOrgIsTestAccount(false);
      setOrgCreateOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/org-secrets"] });
      toast({ title: "Org secret saved" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to save org secret", description: error.message, variant: "destructive" });
    },
  });

  const orgDeleteMutation = useMutation({
    mutationFn: async (secretName: string) => {
      await apiRequest("DELETE", `/api/org-secrets/${encodeURIComponent(secretName)}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-secrets"] });
      toast({ title: "Org secret deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete org secret", description: error.message, variant: "destructive" });
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

      <Tabs value={activeTab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="personal">
            <KeyRound className="h-4 w-4 mr-2" />
            Personal
          </TabsTrigger>
          {hasOrg && (
            <TabsTrigger value="org">
              <Building2 className="h-4 w-4 mr-2" />
              Organization
            </TabsTrigger>
          )}
        </TabsList>

        {/* Personal Secrets Tab */}
        <TabsContent value="personal" className="mt-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-4">
                <CardDescription>
                  Private to you. Used by workflows you own.
                </CardDescription>
                <Dialog open={createOpen} onOpenChange={setCreateOpen}>
                  <DialogTrigger asChild>
                    <Button disabled={!encryptionConfigured}>
                      <Plus className="mr-2 h-4 w-4" />
                      Add Secret
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add Personal Secret</DialogTitle>
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
                          onChange={(e) => {
                            const next = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "");
                            setName(next);
                            setBrokerType((cur) => nextBrokerTypeForName(next, cur));
                          }}
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
                      <div className="space-y-2">
                        <Label htmlFor="secret-class">Type</Label>
                        <Select value={brokerType ?? "runtime"} onValueChange={(v) => setBrokerType(v)}>
                          <SelectTrigger id="secret-class">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="runtime">Runtime</SelectItem>
                            {brokerTypeOptions.map((t) => (
                              <SelectItem key={t} value={t}>{brokerTypeLabel(t)}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          {brokerType === "auth-session"
                            ? "Materialized by a broker; the agent never sees the stored value."
                            : "Sent directly to the agent at runtime. Only use with agents you trust."}
                        </p>
                      </div>
                      {brokerType === "auth-session" && (
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id="secret-test-account"
                            checked={isTestAccount}
                            onCheckedChange={(checked) => setIsTestAccount(checked === true)}
                          />
                          <Label htmlFor="secret-test-account" className="font-normal">
                            Dedicated test account
                          </Label>
                        </div>
                      )}
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
                        <TableCell className="font-mono font-medium">
                          <div className="flex items-center gap-2">
                            {secret.name}
                            {secret.brokerType != null && (
                              <>
                                <Badge variant="outline">{secret.brokerType}</Badge>
                                {secret.isTestAccount && <Badge variant="secondary">test account</Badge>}
                              </>
                            )}
                          </div>
                        </TableCell>
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
                  No personal secrets yet. Add a secret to use in your eval scenarios.
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Org Secrets Tab */}
        {hasOrg && (
          <TabsContent value="org" className="mt-4">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-4">
                  <CardDescription>
                    Shared across all org workflows. Org secrets override personal secrets with the same name.
                  </CardDescription>
                  {isOrgAdmin && (
                    <Dialog open={orgCreateOpen} onOpenChange={setOrgCreateOpen}>
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
                            This secret will be available to all workflows in your organization.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4 py-4">
                          <div className="space-y-2">
                            <Label htmlFor="org-secret-name">Name</Label>
                            <Input
                              id="org-secret-name"
                              placeholder="AGORA_CONSOLE_EMAIL"
                              value={orgName}
                              onChange={(e) => {
                                const next = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "");
                                setOrgName(next);
                                setOrgBrokerType((cur) => nextBrokerTypeForName(next, cur));
                              }}
                              className="font-mono"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="org-secret-value">Value</Label>
                            <Input
                              id="org-secret-value"
                              type="password"
                              placeholder="Enter secret value"
                              value={orgValue}
                              onChange={(e) => setOrgValue(e.target.value)}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="org-secret-class">Type</Label>
                            <Select value={orgBrokerType ?? "runtime"} onValueChange={(v) => setOrgBrokerType(v)}>
                              <SelectTrigger id="org-secret-class">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="runtime">Runtime</SelectItem>
                                {brokerTypeOptions.map((t) => (
                                  <SelectItem key={t} value={t}>{brokerTypeLabel(t)}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">
                              {orgBrokerType === "auth-session"
                                ? "Materialized by a broker; the agent never sees the stored value."
                                : "Sent directly to the agent at runtime. Only use with agents you trust."}
                            </p>
                          </div>
                          {orgBrokerType === "auth-session" && (
                            <div className="flex items-center gap-2">
                              <Checkbox
                                id="org-secret-test-account"
                                checked={orgIsTestAccount}
                                onCheckedChange={(checked) => setOrgIsTestAccount(checked === true)}
                              />
                              <Label htmlFor="org-secret-test-account" className="font-normal">
                                Dedicated test account
                              </Label>
                            </div>
                          )}
                        </div>
                        <DialogFooter>
                          <Button
                            onClick={() => orgCreateMutation.mutate()}
                            disabled={orgCreateMutation.isPending || !orgName.trim() || !orgValue}
                          >
                            Save Org Secret
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {orgLoading ? (
                  <div className="space-y-4">
                    {[1, 2, 3].map((i) => (
                      <Skeleton key={i} className="h-12 w-full" />
                    ))}
                  </div>
                ) : orgSecrets && orgSecrets.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Value</TableHead>
                        <TableHead>Last Updated</TableHead>
                        {isOrgAdmin && <TableHead className="text-right">Actions</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {orgSecrets.map((secret, i) => (
                        <TableRow key={i}>
                          <TableCell className="font-mono font-medium">
                            <div className="flex items-center gap-2">
                              {secret.name}
                              {secret.brokerType != null && (
                                <>
                                  <Badge variant="outline">{secret.brokerType}</Badge>
                                  {secret.isTestAccount && <Badge variant="secondary">test account</Badge>}
                                </>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">••••••••</TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatSmartTimestamp(secret.updatedAt)}
                          </TableCell>
                          {isOrgAdmin && (
                            <TableCell className="text-right">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => orgDeleteMutation.mutate(secret.name)}
                                disabled={orgDeleteMutation.isPending}
                              >
                                <Trash2 className="h-4 w-4 mr-1" />
                                Delete
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    {isOrgAdmin
                      ? "No org secrets yet. Add secrets that will be shared across all org workflows."
                      : "No org secrets configured. Ask an org admin to add shared credentials."}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How to use</CardTitle>
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
            For org workflows, org secrets override personal secrets with the same name.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
