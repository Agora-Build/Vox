import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Redirect } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Users, Shield, Gem, Sparkles, Award, UserPlus, Link, Copy, Check, CircleDot } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface AuthStatus {
  initialized: boolean;
  user: {
    id: string;
    username: string;
    email: string;
    plan: string;
    isAdmin: boolean;
    isEnabled: boolean;
    emailVerified: boolean;
  } | null;
}

interface UserData {
  id: string;
  username: string;
  email: string;
  plan: string;
  isAdmin: boolean;
  isEnabled: boolean;
  emailVerified: boolean;
  createdAt: string;
}

function getUserRole(user: UserData): string {
  if (user.isAdmin) return "Admin";
  switch (user.plan) {
    case "principal": return "Principal";
    case "fellow": return "Fellow";
    case "premium": return "Premium";
    default: return "Basic";
  }
}

function getRoleIcon(role: string) {
  switch (role) {
    case "Admin": return <Shield className="h-3 w-3" />;
    case "Principal": return <Gem className="h-3 w-3" />;
    case "Fellow": return <Award className="h-3 w-3" />;
    case "Premium": return <Sparkles className="h-3 w-3" />;
    default: return <CircleDot className="h-3 w-3" />;
  }
}

function getRoleBadgeVariant(role: string): "default" | "secondary" | "outline" {
  switch (role) {
    case "Admin": return "default";
    case "Principal": return "default";
    case "Fellow": return "secondary";
    case "Premium": return "secondary";
    default: return "outline";
  }
}

function getPaidStatus(user: UserData): { label: string; variant: "default" | "secondary" | "outline" | "destructive" } {
  if (user.isAdmin || user.plan === "principal" || user.plan === "fellow") {
    return { label: "\u2014", variant: "outline" };
  }
  if (user.plan === "premium") {
    return { label: "Yes", variant: "default" };
  }
  return { label: "No", variant: "outline" };
}

export default function Console() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePlan, setInvitePlan] = useState("basic");
  const [inviteIsAdmin, setInviteIsAdmin] = useState(false);
  
  const [activationOpen, setActivationOpen] = useState(false);
  const [activationUserId, setActivationUserId] = useState<string | null>(null);
  const [activationEmail, setActivationEmail] = useState("");
  const [activationLink, setActivationLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: authStatus, isLoading: authLoading } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const { data: users, isLoading: usersLoading } = useQuery<UserData[]>({
    queryKey: ["/api/admin/users"],
    enabled: !!authStatus?.user?.isAdmin,
  });

  const updateUserMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: string; isEnabled?: boolean; isAdmin?: boolean; plan?: string }) => {
      const res = await apiRequest("PATCH", `/api/admin/users/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "User updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update user", description: error.message, variant: "destructive" });
    },
  });

  const inviteMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/invite", {
        email: inviteEmail,
        plan: invitePlan,
        isAdmin: inviteIsAdmin,
      });
      return res.json();
    },
    onSuccess: (data) => {
      setInviteOpen(false);
      setInviteEmail("");
      setInvitePlan("basic");
      setInviteIsAdmin(false);
      toast({ 
        title: "Invite created", 
        description: `Token: ${data.token.slice(0, 16)}...` 
      });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create invite", description: error.message, variant: "destructive" });
    },
  });

  const activationMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/users/${activationUserId}/activation-link`, {
        email: activationEmail || undefined,
      });
      return res.json();
    },
    onSuccess: (data) => {
      const fullUrl = `${window.location.origin}${data.activationUrl}`;
      setActivationLink(fullUrl);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "Activation link created" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create activation link", description: error.message, variant: "destructive" });
    },
  });

  const handleOpenActivation = (user: UserData) => {
    setActivationUserId(user.id);
    setActivationEmail(user.email === "scout@vox.internal" ? "" : user.email);
    setActivationLink(null);
    setCopied(false);
    setActivationOpen(true);
  };

  const handleCopyLink = () => {
    if (activationLink) {
      navigator.clipboard.writeText(activationLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (authLoading) {
    return (
      <div className="container mx-auto p-6 space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!authStatus?.user) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!authStatus.user.isAdmin) {
    return <Redirect to="/console/workflows" />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-console-title">
          <Shield className="h-6 w-6" />
          User Management
        </h1>
        <p className="text-muted-foreground">
          Manage user accounts and permissions
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-users">{users?.length || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Admins</CardTitle>
            <Shield className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-admin-count">
              {users?.filter(u => u.isAdmin).length || 0}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Paid Users</CardTitle>
            <Sparkles className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-paid-count">
              {users?.filter(u => u.plan === "premium").length || 0}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div>
            <CardTitle>User Management</CardTitle>
            <CardDescription>Manage user accounts and permissions</CardDescription>
          </div>
          <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-invite-user">
                <UserPlus className="mr-2 h-4 w-4" />
                Invite User
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Invite New User</DialogTitle>
                <DialogDescription>
                  Create an invitation link for a new user.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="invite-email">Email</Label>
                  <Input
                    id="invite-email"
                    type="email"
                    placeholder="user@example.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    data-testid="input-invite-email"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="invite-plan">Plan</Label>
                  <Select value={invitePlan} onValueChange={setInvitePlan}>
                    <SelectTrigger data-testid="select-invite-plan">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="basic">Basic</SelectItem>
                      <SelectItem value="premium">Premium</SelectItem>
                      <SelectItem value="principal">Principal</SelectItem>
                      <SelectItem value="fellow">Fellow</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center space-x-2">
                  <Switch
                    id="invite-admin"
                    checked={inviteIsAdmin}
                    onCheckedChange={setInviteIsAdmin}
                    data-testid="switch-invite-admin"
                  />
                  <Label htmlFor="invite-admin">Admin privileges</Label>
                </div>
              </div>
              <DialogFooter>
                <Button 
                  onClick={() => inviteMutation.mutate()} 
                  disabled={inviteMutation.isPending || !inviteEmail}
                  data-testid="button-create-invite"
                >
                  Create Invite
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {usersLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Paid</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users?.map((user) => {
                  const role = getUserRole(user);
                  const paid = getPaidStatus(user);
                  return (
                    <TableRow key={user.id} data-testid={`row-user-${user.id}`}>
                      <TableCell>
                        <div>
                          <div className="font-medium">{user.username}</div>
                          <div className="text-sm text-muted-foreground">{user.email}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={getRoleBadgeVariant(role)} className="gap-1">
                          {getRoleIcon(role)}
                          {role}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={paid.variant}>
                          {paid.label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={user.isEnabled ? "outline" : "destructive"}>
                          {user.isEnabled ? "Active" : "Disabled"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          {!user.emailVerified && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleOpenActivation(user)}
                              data-testid={`button-activate-${user.id}`}
                            >
                              <Link className="mr-1 h-3 w-3" />
                              Activate
                            </Button>
                          )}
                          <Switch
                            checked={user.isEnabled}
                            onCheckedChange={(checked) =>
                              updateUserMutation.mutate({ id: user.id, isEnabled: checked })
                            }
                            disabled={user.id === authStatus.user?.id}
                            data-testid={`switch-enable-${user.id}`}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={activationOpen} onOpenChange={setActivationOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate Activation Link</DialogTitle>
            <DialogDescription>
              Create a link for the user to set their password and activate their account.
            </DialogDescription>
          </DialogHeader>
          {!activationLink ? (
            <>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="activation-email">Email Address</Label>
                  <Input
                    id="activation-email"
                    type="email"
                    placeholder="user@example.com"
                    value={activationEmail}
                    onChange={(e) => setActivationEmail(e.target.value)}
                    data-testid="input-activation-email"
                  />
                  <p className="text-xs text-muted-foreground">
                    Update the email address if needed before generating the link.
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button 
                  onClick={() => activationMutation.mutate()} 
                  disabled={activationMutation.isPending}
                  data-testid="button-generate-activation"
                >
                  Generate Link
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Activation Link</Label>
                  <div className="flex gap-2">
                    <Input
                      value={activationLink}
                      readOnly
                      className="font-mono text-sm"
                      data-testid="input-activation-link"
                    />
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={handleCopyLink}
                      data-testid="button-copy-link"
                    >
                      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Share this link with the user. It expires in 7 days.
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setActivationOpen(false)}>
                  Done
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
