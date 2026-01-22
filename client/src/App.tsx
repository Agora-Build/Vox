import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";
import Layout from "@/components/layout";
import ConsoleLayout from "@/components/console-layout";
import Home from "@/pages/home";
import Dashboard from "@/pages/dashboard";
import Leaderboard from "@/pages/leaderboard";
import ProviderGuide from "@/pages/provider";
import SelfTest from "@/pages/self-test";
import Login from "@/pages/login";
import AdminLogin from "@/pages/login-admin";
import AdminConsolePage from "@/pages/admin-console";
import Console from "@/pages/console";
import ConsoleInit from "@/pages/console-init";
import ConsoleWorkflows from "@/pages/console-workflows";
import ConsoleWorkflowDetail from "@/pages/console-workflow-detail";
import ConsoleTestSets from "@/pages/console-testsets";
import ConsoleWorkerTokens from "@/pages/console-worker-tokens";
import ConsoleWorkers from "@/pages/console-workers";
import ConsoleOrganization from "@/pages/console-organization";
import ConsoleOrganizationMembers from "@/pages/console-organization-members";
import ConsoleOrganizationBilling from "@/pages/console-organization-billing";
import ConsoleOrganizationSettings from "@/pages/console-organization-settings";
import ConsoleOrganizationCreate from "@/pages/console-organization-create";
import AdminOrganizations from "@/pages/admin-organizations";
import AdminFundReturns from "@/pages/admin-fund-returns";
import Activate from "@/pages/activate";
import NotFound from "@/pages/not-found";

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

function ConsoleWrapper() {
  const [, setLocation] = useLocation();
  const { data: authStatus, isLoading, isFetching } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  useEffect(() => {
    if (!isLoading && !isFetching && authStatus?.initialized && !authStatus.user) {
      setLocation("/login");
    }
  }, [isLoading, isFetching, authStatus, setLocation]);

  if ((isLoading || isFetching) && !authStatus?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!authStatus?.initialized) {
    return <ConsoleInit />;
  }

  if (!authStatus.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Redirecting...</div>
      </div>
    );
  }

  return (
    <ConsoleLayout>
      <Console />
    </ConsoleLayout>
  );
}

function ConsoleWorkflowsWrapper() {
  const [, setLocation] = useLocation();
  const { data: authStatus, isLoading, isFetching } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  useEffect(() => {
    if (!isLoading && !isFetching && authStatus?.initialized && !authStatus.user) {
      setLocation("/login");
    }
  }, [isLoading, isFetching, authStatus, setLocation]);

  if ((isLoading || isFetching) && !authStatus?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!authStatus?.initialized) {
    return <ConsoleInit />;
  }

  if (!authStatus.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Redirecting...</div>
      </div>
    );
  }

  return (
    <ConsoleLayout>
      <ConsoleWorkflows />
    </ConsoleLayout>
  );
}

function ConsoleTestSetsWrapper() {
  const [, setLocation] = useLocation();
  const { data: authStatus, isLoading, isFetching } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  useEffect(() => {
    if (!isLoading && !isFetching && authStatus?.initialized && !authStatus.user) {
      setLocation("/login");
    }
  }, [isLoading, isFetching, authStatus, setLocation]);

  if ((isLoading || isFetching) && !authStatus?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!authStatus?.initialized) {
    return <ConsoleInit />;
  }

  if (!authStatus.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Redirecting...</div>
      </div>
    );
  }

  return (
    <ConsoleLayout>
      <ConsoleTestSets />
    </ConsoleLayout>
  );
}

function ConsoleWorkflowDetailWrapper() {
  const [, setLocation] = useLocation();
  const { data: authStatus, isLoading, isFetching } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  useEffect(() => {
    if (!isLoading && !isFetching && authStatus?.initialized && !authStatus.user) {
      setLocation("/login");
    }
  }, [isLoading, isFetching, authStatus, setLocation]);

  if ((isLoading || isFetching) && !authStatus?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!authStatus?.initialized) {
    return <ConsoleInit />;
  }

  if (!authStatus.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Redirecting...</div>
      </div>
    );
  }

  return (
    <ConsoleLayout>
      <ConsoleWorkflowDetail />
    </ConsoleLayout>
  );
}

function ConsoleWorkerTokensWrapper() {
  const [, setLocation] = useLocation();
  const { data: authStatus, isLoading, isFetching } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  useEffect(() => {
    if (!isLoading && !isFetching && authStatus?.initialized && !authStatus.user) {
      setLocation("/login");
    }
  }, [isLoading, isFetching, authStatus, setLocation]);

  if ((isLoading || isFetching) && !authStatus?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!authStatus?.initialized) {
    return <ConsoleInit />;
  }

  if (!authStatus.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Redirecting...</div>
      </div>
    );
  }

  if (!authStatus.user.isAdmin) {
    setLocation("/console/workflows");
    return null;
  }

  return (
    <ConsoleLayout>
      <ConsoleWorkerTokens />
    </ConsoleLayout>
  );
}

function ConsoleWorkersWrapper() {
  const [, setLocation] = useLocation();
  const { data: authStatus, isLoading, isFetching } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  useEffect(() => {
    if (!isLoading && !isFetching && authStatus?.initialized && !authStatus.user) {
      setLocation("/login");
    }
  }, [isLoading, isFetching, authStatus, setLocation]);

  if ((isLoading || isFetching) && !authStatus?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!authStatus?.initialized) {
    return <ConsoleInit />;
  }

  if (!authStatus.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Redirecting...</div>
      </div>
    );
  }

  return (
    <ConsoleLayout>
      <ConsoleWorkers />
    </ConsoleLayout>
  );
}

function ConsoleOrganizationWrapper() {
  const [, setLocation] = useLocation();
  const { data: authStatus, isLoading, isFetching } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  useEffect(() => {
    if (!isLoading && !isFetching && authStatus?.initialized && !authStatus.user) {
      setLocation("/login");
    }
  }, [isLoading, isFetching, authStatus, setLocation]);

  if ((isLoading || isFetching) && !authStatus?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!authStatus?.initialized) {
    return <ConsoleInit />;
  }

  if (!authStatus.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Redirecting...</div>
      </div>
    );
  }

  if (!authStatus.user.organizationId) {
    setLocation("/console/organization/create");
    return null;
  }

  return (
    <ConsoleLayout>
      <ConsoleOrganization />
    </ConsoleLayout>
  );
}

function ConsoleOrganizationMembersWrapper() {
  const [, setLocation] = useLocation();
  const { data: authStatus, isLoading, isFetching } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  useEffect(() => {
    if (!isLoading && !isFetching && authStatus?.initialized && !authStatus.user) {
      setLocation("/login");
    }
  }, [isLoading, isFetching, authStatus, setLocation]);

  if ((isLoading || isFetching) && !authStatus?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!authStatus?.initialized) {
    return <ConsoleInit />;
  }

  if (!authStatus.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Redirecting...</div>
      </div>
    );
  }

  if (!authStatus.user.organizationId) {
    setLocation("/console/organization/create");
    return null;
  }

  return (
    <ConsoleLayout>
      <ConsoleOrganizationMembers />
    </ConsoleLayout>
  );
}

function ConsoleOrganizationBillingWrapper() {
  const [, setLocation] = useLocation();
  const { data: authStatus, isLoading, isFetching } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  useEffect(() => {
    if (!isLoading && !isFetching && authStatus?.initialized && !authStatus.user) {
      setLocation("/login");
    }
  }, [isLoading, isFetching, authStatus, setLocation]);

  if ((isLoading || isFetching) && !authStatus?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!authStatus?.initialized) {
    return <ConsoleInit />;
  }

  if (!authStatus.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Redirecting...</div>
      </div>
    );
  }

  if (!authStatus.user.organizationId || !authStatus.user.isOrgAdmin) {
    setLocation("/console/organization");
    return null;
  }

  return (
    <ConsoleLayout>
      <ConsoleOrganizationBilling />
    </ConsoleLayout>
  );
}

function ConsoleOrganizationSettingsWrapper() {
  const [, setLocation] = useLocation();
  const { data: authStatus, isLoading, isFetching } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  useEffect(() => {
    if (!isLoading && !isFetching && authStatus?.initialized && !authStatus.user) {
      setLocation("/login");
    }
  }, [isLoading, isFetching, authStatus, setLocation]);

  if ((isLoading || isFetching) && !authStatus?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!authStatus?.initialized) {
    return <ConsoleInit />;
  }

  if (!authStatus.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Redirecting...</div>
      </div>
    );
  }

  if (!authStatus.user.organizationId || !authStatus.user.isOrgAdmin) {
    setLocation("/console/organization");
    return null;
  }

  return (
    <ConsoleLayout>
      <ConsoleOrganizationSettings />
    </ConsoleLayout>
  );
}

function ConsoleOrganizationCreateWrapper() {
  const [, setLocation] = useLocation();
  const { data: authStatus, isLoading, isFetching } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  useEffect(() => {
    if (!isLoading && !isFetching && authStatus?.initialized && !authStatus.user) {
      setLocation("/login");
    }
  }, [isLoading, isFetching, authStatus, setLocation]);

  if ((isLoading || isFetching) && !authStatus?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!authStatus?.initialized) {
    return <ConsoleInit />;
  }

  if (!authStatus.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Redirecting...</div>
      </div>
    );
  }

  if (authStatus.user.organizationId) {
    setLocation("/console/organization");
    return null;
  }

  return (
    <ConsoleLayout>
      <ConsoleOrganizationCreate />
    </ConsoleLayout>
  );
}

function AdminOrganizationsWrapper() {
  const [, setLocation] = useLocation();
  const { data: authStatus, isLoading, isFetching } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  useEffect(() => {
    if (!isLoading && !isFetching && authStatus?.initialized && !authStatus.user) {
      setLocation("/admin/login");
    }
  }, [isLoading, isFetching, authStatus, setLocation]);

  if ((isLoading || isFetching) && !authStatus?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!authStatus?.initialized) {
    return <ConsoleInit />;
  }

  if (!authStatus.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Redirecting...</div>
      </div>
    );
  }

  if (!authStatus.user.isAdmin) {
    setLocation("/console/workflows");
    return null;
  }

  return (
    <ConsoleLayout>
      <AdminOrganizations />
    </ConsoleLayout>
  );
}

function AdminFundReturnsWrapper() {
  const [, setLocation] = useLocation();
  const { data: authStatus, isLoading, isFetching } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  useEffect(() => {
    if (!isLoading && !isFetching && authStatus?.initialized && !authStatus.user) {
      setLocation("/admin/login");
    }
  }, [isLoading, isFetching, authStatus, setLocation]);

  if ((isLoading || isFetching) && !authStatus?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!authStatus?.initialized) {
    return <ConsoleInit />;
  }

  if (!authStatus.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Redirecting...</div>
      </div>
    );
  }

  if (!authStatus.user.isAdmin) {
    setLocation("/console/workflows");
    return null;
  }

  return (
    <ConsoleLayout>
      <AdminFundReturns />
    </ConsoleLayout>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/admin/login" component={AdminLogin} />
      <Route path="/activate/:token" component={Activate} />
      <Route path="/console">
        <ConsoleWrapper />
      </Route>
      <Route path="/console/workflows">
        <ConsoleWorkflowsWrapper />
      </Route>
      <Route path="/console/workflows/:id">
        <ConsoleWorkflowDetailWrapper />
      </Route>
      <Route path="/console/test-sets">
        <ConsoleTestSetsWrapper />
      </Route>
      <Route path="/console/workers">
        <ConsoleWorkersWrapper />
      </Route>
      <Route path="/console/worker-tokens">
        <ConsoleWorkerTokensWrapper />
      </Route>
      <Route path="/console/organization">
        <ConsoleOrganizationWrapper />
      </Route>
      <Route path="/console/organization/members">
        <ConsoleOrganizationMembersWrapper />
      </Route>
      <Route path="/console/organization/billing">
        <ConsoleOrganizationBillingWrapper />
      </Route>
      <Route path="/console/organization/settings">
        <ConsoleOrganizationSettingsWrapper />
      </Route>
      <Route path="/console/organization/create">
        <ConsoleOrganizationCreateWrapper />
      </Route>
      <Route path="/admin/console/organizations">
        <AdminOrganizationsWrapper />
      </Route>
      <Route path="/admin/console/fund-returns">
        <AdminFundReturnsWrapper />
      </Route>
      <Route path="/admin/console" component={AdminConsolePage} />
      <Route path="/setup" component={ConsoleInit} />
      <Route path="/">
        <Layout>
          <Home />
        </Layout>
      </Route>
      <Route path="/realtime">
        <Layout>
          <Dashboard />
        </Layout>
      </Route>
      <Route path="/leaderboard">
        <Layout>
          <Leaderboard />
        </Layout>
      </Route>
      <Route path="/dive">
        <Layout>
          <ProviderGuide />
        </Layout>
      </Route>
      <Route path="/run-your-own">
        <Layout>
          <SelfTest />
        </Layout>
      </Route>
      <Route path="/not-found" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AppGuard() {
  const [location, setLocation] = useLocation();
  const { data: authStatus, isLoading, isFetching } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  useEffect(() => {
    if (isLoading || isFetching) {
      return;
    }

    if (!authStatus?.initialized) {
      if (location === "/setup") return;

      if (location !== "/not-found") {
        setLocation("/not-found");
      }
    }
  }, [isLoading, isFetching, authStatus, location, setLocation]);

  useEffect(() => {
    if (isLoading || isFetching) {
      return;
    }

    if (authStatus?.initialized && location === "/setup") {
      setLocation("/");
    }
  }, [isLoading, isFetching, authStatus, location, setLocation]);

  if ((isLoading || isFetching) && !authStatus) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!authStatus?.initialized) {
    if (location === "/setup") {
      return <ConsoleInit />;
    }

    return <NotFound />;
  }

  return <Router />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AppGuard />
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
