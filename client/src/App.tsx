import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";
import Layout from "@/components/layout";
import Home from "@/pages/home";
import Dashboard from "@/pages/dashboard";
import Leaderboard from "@/pages/leaderboard";
import ProviderGuide from "@/pages/provider";
import SelfTest from "@/pages/self-test";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/realtime" component={Dashboard} />
        <Route path="/leaderboard" component={Leaderboard} />
        <Route path="/dive" component={ProviderGuide} />
        <Route path="/run-your-own" component={SelfTest} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
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
