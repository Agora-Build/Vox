import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { UserPlus, Shield, UserMinus, Copy } from "lucide-react";

interface AuthStatus {
  user: {
    organizationId: number | null;
    isOrgAdmin: boolean;
  } | null;
}

interface Member {
  id: number;
  username: string;
  email: string;
  plan: string;
  isOrgAdmin: boolean;
  createdAt: string;
}

interface Organization {
  id: number;
  totalSeats: number;
  usedSeats: number;
  isOrgAdmin: boolean;
}

export default function ConsoleOrganizationMembers() {
  const { toast } = useToast();
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviteToken, setInviteToken] = useState<string | null>(null);

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const { data: org } = useQuery<Organization>({
    queryKey: ["/api/user/organization"],
    enabled: !!authStatus?.user?.organizationId,
  });

  const { data: members, isLoading } = useQuery<Member[]>({
    queryKey: ["/api/organizations", authStatus?.user?.organizationId, "members"],
    queryFn: async () => {
      const response = await fetch(`/api/organizations/${authStatus?.user?.organizationId}/members`);
      if (!response.ok) throw new Error("Failed to fetch members");
      return response.json();
    },
    enabled: !!authStatus?.user?.organizationId,
  });

  const inviteMutation = useMutation({
    mutationFn: async (email: string): Promise<{ token: string; expiresAt: string }> => {
      const res = await apiRequest("POST", `/api/organizations/${authStatus?.user?.organizationId}/invite`, { email });
      return res.json();
    },
    onSuccess: (data) => {
      setInviteToken(data.token);
      queryClient.invalidateQueries({ queryKey: ["/api/organizations"] });
      toast({ title: "Invite sent", description: "Invitation created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to invite", description: error.message, variant: "destructive" });
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: async ({ userId, isOrgAdmin }: { userId: number; isOrgAdmin: boolean }) => {
      return apiRequest("PATCH", `/api/organizations/${authStatus?.user?.organizationId}/members/${userId}`, { isOrgAdmin });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/organizations"] });
      toast({ title: "Role updated", description: "Member role updated successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update role", description: error.message, variant: "destructive" });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: async (userId: number) => {
      return apiRequest("DELETE", `/api/organizations/${authStatus?.user?.organizationId}/members/${userId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/organizations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/organization"] });
      toast({ title: "Member removed", description: "Member removed from organization" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to remove member", description: error.message, variant: "destructive" });
    },
  });

  const handleInvite = () => {
    if (!inviteEmail) return;
    inviteMutation.mutate(inviteEmail);
  };

  const copyInviteLink = () => {
    if (!inviteToken) return;
    const link = `${window.location.origin}/activate/${inviteToken}`;
    navigator.clipboard.writeText(link);
    toast({ title: "Copied", description: "Invite link copied to clipboard" });
  };

  const isOrgAdmin = authStatus?.user?.isOrgAdmin || false;
  const availableSeats = org ? Math.max(0, org.totalSeats - org.usedSeats) : 0;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Organization Members</h1>
          <p className="text-muted-foreground">
            {members?.length || 0} members - {availableSeats} seats available
          </p>
        </div>
        {isOrgAdmin && (
          <Dialog open={inviteDialogOpen} onOpenChange={setInviteDialogOpen}>
            <DialogTrigger asChild>
              <Button disabled={availableSeats <= 0}>
                <UserPlus className="mr-2 h-4 w-4" />
                Invite Member
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Invite New Member</DialogTitle>
                <DialogDescription>
                  Send an invitation to join your organization
                </DialogDescription>
              </DialogHeader>
              {inviteToken ? (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Share this invite link with the new member:
                  </p>
                  <div className="flex gap-2">
                    <Input
                      readOnly
                      value={`${window.location.origin}/activate/${inviteToken}`}
                      className="font-mono text-xs"
                    />
                    <Button variant="outline" onClick={copyInviteLink}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <Button
                    className="w-full"
                    onClick={() => {
                      setInviteToken(null);
                      setInviteEmail("");
                      setInviteDialogOpen(false);
                    }}
                  >
                    Done
                  </Button>
                </div>
              ) : (
                <>
                  <div className="space-y-4">
                    <Input
                      placeholder="Email address"
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                    />
                  </div>
                  <DialogFooter>
                    <Button
                      onClick={handleInvite}
                      disabled={!inviteEmail || inviteMutation.isPending}
                    >
                      {inviteMutation.isPending ? "Sending..." : "Send Invite"}
                    </Button>
                  </DialogFooter>
                </>
              )}
            </DialogContent>
          </Dialog>
        )}
      </div>

      {availableSeats <= 0 && isOrgAdmin && (
        <Card className="border-yellow-500/50 bg-yellow-500/10">
          <CardContent className="pt-6">
            <p className="text-sm">
              No seats available. <a href="/console/organization/billing" className="text-primary underline">Purchase more seats</a> to invite new members.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Team Members</CardTitle>
          <CardDescription>
            All members of your organization
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Username</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Plan</TableHead>
                {isOrgAdmin && <TableHead className="w-24">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members?.map((member) => (
                <TableRow key={member.id}>
                  <TableCell className="font-medium">{member.username}</TableCell>
                  <TableCell>{member.email}</TableCell>
                  <TableCell>
                    {member.isOrgAdmin ? (
                      <Badge variant="default" className="gap-1">
                        <Shield className="h-3 w-3" />
                        Admin
                      </Badge>
                    ) : (
                      <Badge variant="secondary">Member</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{member.plan}</Badge>
                  </TableCell>
                  {isOrgAdmin && (
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => updateRoleMutation.mutate({
                            userId: member.id,
                            isOrgAdmin: !member.isOrgAdmin
                          })}
                          disabled={updateRoleMutation.isPending}
                          title={member.isOrgAdmin ? "Demote to member" : "Promote to admin"}
                        >
                          <Shield className="h-4 w-4" />
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="sm" title="Remove member">
                              <UserMinus className="h-4 w-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Remove Member</AlertDialogTitle>
                              <AlertDialogDescription>
                                Are you sure you want to remove {member.username} from the organization?
                                This action cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => removeMemberMutation.mutate(member.id)}
                              >
                                Remove
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
