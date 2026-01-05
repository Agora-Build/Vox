import { Switch, Route, useLocation, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";
import Layout from "@/components/layout";
import Home from "@/pages/home";
import Dashboard from "@/pages/dashboard";
import Leaderboard from "@/pages/leaderboard";
import ProviderGuide from "@/pages/provider";
import SelfTest from "@/pages/self-test";
import Login from "@/pages/login";
import Console from "@/pages/console";
import ConsoleInit from "@/pages/console-init";
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
  } | null;
}

function ConsoleWrapper() {
  const [, setLocation] = useLocation();
  const { data: authStatus, isLoading } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  if (isLoading) {
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
    setLocation("/login");
    return null;
  }

  return <Console />;
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/console">
        <ConsoleWrapper />
      </Route>
      <Route path="/console/init" component={ConsoleInit} />
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
      <Route>
        <Layout>
          <NotFound />
        </Layout>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Router />
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
