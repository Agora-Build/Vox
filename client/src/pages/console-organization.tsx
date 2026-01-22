import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, Users, CreditCard, CheckCircle, XCircle } from "lucide-react";

interface Organization {
  id: number;
  name: string;
  address: string | null;
  verified: boolean;
  memberCount: number;
  totalSeats: number;
  usedSeats: number;
  isOrgAdmin: boolean;
  createdAt: string;
}

export default function ConsoleOrganization() {
  const { data: org, isLoading, error } = useQuery<Organization>({
    queryKey: ["/api/user/organization"],
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    );
  }

  if (error || !org) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">No organization found</p>
      </div>
    );
  }

  const availableSeats = Math.max(0, org.totalSeats - org.usedSeats);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{org.name}</h1>
          <p className="text-muted-foreground">Organization Dashboard</p>
        </div>
        <div className="flex items-center gap-2">
          {org.verified ? (
            <Badge variant="default" className="gap-1">
              <CheckCircle className="h-3 w-3" />
              Verified
            </Badge>
          ) : (
            <Badge variant="secondary" className="gap-1">
              <XCircle className="h-3 w-3" />
              Pending Verification
            </Badge>
          )}
          {org.isOrgAdmin && (
            <Badge variant="outline">Admin</Badge>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Members</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{org.memberCount}</div>
            <p className="text-xs text-muted-foreground">
              Active organization members
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Seats</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {org.usedSeats} / {org.totalSeats}
            </div>
            <p className="text-xs text-muted-foreground">
              {availableSeats} seats available
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Status</CardTitle>
            <Building2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {org.verified ? "Active" : "Pending"}
            </div>
            <p className="text-xs text-muted-foreground">
              Organization status
            </p>
          </CardContent>
        </Card>
      </div>

      {org.address && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Address</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{org.address}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Quick Actions</CardTitle>
          <CardDescription>Common organization tasks</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Use the sidebar navigation to manage your organization:
          </p>
          <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
            <li>View and manage team members</li>
            {org.isOrgAdmin && (
              <>
                <li>Purchase additional seats</li>
                <li>Manage billing and payment methods</li>
                <li>Update organization settings</li>
              </>
            )}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
