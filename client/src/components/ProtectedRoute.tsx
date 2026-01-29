import { useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";

interface AuthStatus {
  initialized: boolean;
  user: {
    id: string;
    isAdmin: boolean;
  } | null;
}

interface ProtectedRouteProps {
  requireAdmin?: boolean;
  children: React.ReactNode;
}

export default function ProtectedRoute({ requireAdmin, children }: ProtectedRouteProps) {
  const [, setLocation] = useLocation();
  const { data: authStatus, isLoading, isFetching } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  useEffect(() => {
    if (!isLoading && !isFetching) {
      if (!authStatus?.initialized) {
        return;
      }

      if (!authStatus.user) {
        setLocation(requireAdmin ? "/admin/login" : "/login");
      } else if (requireAdmin && !authStatus.user.isAdmin) {
        setLocation("/console");
      }
    }
  }, [isLoading, isFetching, authStatus, requireAdmin, setLocation]);

  if (
    (isLoading || isFetching) && !authStatus?.user
  ) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (
    !authStatus?.initialized ||
    !authStatus.user ||
    (requireAdmin && !authStatus.user.isAdmin)
  ) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return <>{children}</>;
}
