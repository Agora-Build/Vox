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
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Users, Workflow, FileText, LogOut, Shield, Gem, Sparkles, Zap, Server, Key, Building2, CreditCard, Settings, FolderKanban } from "lucide-react";
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
    organizationId: number | null;
    isOrgAdmin: boolean;
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

  const getRoleLabel = (user: { plan: string; isAdmin: boolean }) => {
    if (user.isAdmin) return "Admin";
    switch (user.plan) {
      case "principal": return "Principal";
      case "fellow": return "Fellow";
      case "premium": return "Premium";
      default: return "Basic";
    }
  };

  const getRoleIcon = (role: string) => {
    switch (role) {
      case "Admin": return <Shield className="h-3 w-3" />;
      case "Principal": return <Gem className="h-3 w-3" />;
      case "Premium": return <Sparkles className="h-3 w-3" />;
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
    title: "Projects",
    url: "/console/projects",
    icon: FolderKanban,
    active: location === "/console/projects",
  });

  navItems.push({
    title: "Workflows",
    url: "/console/workflows",
    icon: Workflow,
    active: location === "/console/workflows",
  });

  navItems.push({
    title: "Eval Sets",
    url: "/console/eval-sets",
    icon: FileText,
    active: location === "/console/eval-sets",
  });

  navItems.push({
    title: "Eval Agents",
    url: "/console/eval-agents",
    icon: Server,
    active: location === "/console/eval-agents",
  });

  if (user?.isAdmin) {
    navItems.push({
      title: "Agent Tokens",
      url: "/console/eval-agent-tokens",
      icon: Key,
      active: location === "/console/eval-agent-tokens",
    });
  }

  // Organization section
  const orgNavItems = [];

  if (user?.organizationId) {
    orgNavItems.push({
      title: "Organization",
      url: "/console/organization",
      icon: Building2,
      active: location === "/console/organization",
    });
    orgNavItems.push({
      title: "Members",
      url: "/console/organization/members",
      icon: Users,
      active: location === "/console/organization/members",
    });
    if (user.isOrgAdmin) {
      orgNavItems.push({
        title: "Billing",
        url: "/console/organization/billing",
        icon: CreditCard,
        active: location === "/console/organization/billing",
      });
      orgNavItems.push({
        title: "Settings",
        url: "/console/organization/settings",
        icon: Settings,
        active: location === "/console/organization/settings",
      });
    }
  } else {
    orgNavItems.push({
      title: "Create Organization",
      url: "/console/organization/create",
      icon: Building2,
      active: location === "/console/organization/create",
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
            <SidebarGroup>
              <SidebarGroupLabel>Organization</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {orgNavItems.map((item) => (
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
                    {(() => {
                      const role = getRoleLabel(user);
                      return (
                        <Badge variant={user.isAdmin ? "default" : "outline"} className="text-xs gap-1">
                          {getRoleIcon(role)}
                          {role}
                        </Badge>
                      );
                    })()}
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
