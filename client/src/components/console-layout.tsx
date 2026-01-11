import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, Link } from "wouter";
import { 
  SidebarProvider, 
  Sidebar, 
  SidebarContent, 
  SidebarHeader,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Users, Workflow, FileText, LogOut, Home, Shield, Crown, Sparkles, Zap, Server, Key } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

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

interface ConsoleLayoutProps {
  children: React.ReactNode;
}

export default function ConsoleLayout({ children }: ConsoleLayoutProps) {
  const [location, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: authStatus, isLoading } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/logout");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
      setLocation("/login");
    },
    onError: (error: Error) => {
      toast({ title: "Logout failed", description: error.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  const user = authStatus?.user;

  const getPlanIcon = (plan: string) => {
    switch (plan) {
      case "principal": return <Crown className="h-3 w-3" />;
      case "premium": return <Sparkles className="h-3 w-3" />;
      default: return <Zap className="h-3 w-3" />;
    }
  };

  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  const navItems = [];

  if (user?.isAdmin) {
    navItems.push({
      title: "User Management",
      url: "/console",
      icon: Users,
      active: location === "/console",
    });
  }

  navItems.push({
    title: "Workflows",
    url: "/console/workflows",
    icon: Workflow,
    active: location === "/console/workflows",
  });

  navItems.push({
    title: "Test Sets",
    url: "/console/test-sets",
    icon: FileText,
    active: location === "/console/test-sets",
  });

  navItems.push({
    title: "Workers",
    url: "/console/workers",
    icon: Server,
    active: location === "/console/workers",
  });

  if (user?.isAdmin) {
    navItems.push({
      title: "Worker Tokens",
      url: "/console/worker-tokens",
      icon: Key,
      active: location === "/console/worker-tokens",
    });
  }

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <Sidebar>
          <SidebarHeader className="p-4 border-b">
            <Link href="/" className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-md bg-primary flex items-center justify-center">
                <span className="text-primary-foreground font-bold text-sm">V</span>
              </div>
              <span className="font-semibold text-lg">Vox Console</span>
            </Link>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Management</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {navItems.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton asChild isActive={item.active}>
                        <Link href={item.url}>
                          <item.icon className="h-4 w-4" />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter className="p-4 border-t">
            {user && (
              <div className="flex items-center gap-3">
                <Avatar className="h-8 w-8">
                  <AvatarFallback>{user.username[0].toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{user.username}</div>
                  <div className="flex items-center gap-1">
                    <Badge variant="outline" className="text-xs gap-1">
                      {getPlanIcon(user.plan)}
                      {user.plan}
                    </Badge>
                    {user.isAdmin && (
                      <Badge variant="secondary" className="text-xs gap-1">
                        <Shield className="h-2 w-2" />
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            )}
          </SidebarFooter>
        </Sidebar>
        <div className="flex flex-col flex-1 overflow-hidden">
          <header className="flex items-center justify-between gap-4 p-4 border-b bg-background">
            <div className="flex items-center gap-2">
              <SidebarTrigger data-testid="button-sidebar-toggle" />
            </div>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => logoutMutation.mutate()}
                disabled={logoutMutation.isPending}
                data-testid="button-logout"
              >
                <LogOut className="mr-2 h-4 w-4" />
                Sign Out
              </Button>
            </div>
          </header>
          <main className="flex-1 overflow-auto p-6">
            {children}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
