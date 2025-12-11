import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import Layout from "@/components/layout";
import Dashboard from "@/pages/dashboard";
import Leaderboard from "@/pages/leaderboard";
import ProviderGuide from "@/pages/provider";
import SelfTest from "@/pages/self-test";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/leaderboard" component={Leaderboard} />
        <Route path="/provider" component={ProviderGuide} />
        <Route path="/test" component={SelfTest} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
        <Router />
        <Toaster />
    </QueryClientProvider>
  );
}

export default App;
