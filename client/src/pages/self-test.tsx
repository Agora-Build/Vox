import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardFooter, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Play, Loader2, XCircle, CheckCircle, Clock, AlertCircle, Rocket, Zap } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Link } from "wouter";
import generatedImage from '@assets/generated_images/abstract_digital_network_visualization_dark_blue.png';

interface AuthStatus {
  user: {
    id: string;
    plan: string;
  } | null;
}

interface Provider {
  id: string;
  name: string;
  sku: string;
}

interface Workflow {
  id: number;
  name: string;
  providerId: string;
}

interface EvalJob {
  id: number;
  status: "pending" | "running" | "completed" | "failed";
  region: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export default function SelfTest() {
  const { toast } = useToast();
  const [productType, setProductType] = useState<string>("convoai");
  const [productName, setProductName] = useState("");
  const [productUrl, setProductUrl] = useState("");
  const [region, setRegion] = useState<string>("na");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("");
  const [activeJobId, setActiveJobId] = useState<number | null>(null);

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const { data: providers } = useQuery<Provider[]>({
    queryKey: ["/api/providers"],
  });

  const { data: workflows } = useQuery<Workflow[]>({
    queryKey: ["/api/workflows"],
    enabled: !!authStatus?.user,
  });

  const { data: activeJob, refetch: refetchJob } = useQuery<EvalJob>({
    queryKey: ["/api/eval-jobs", activeJobId],
    queryFn: async () => {
      if (!activeJobId) throw new Error("No job ID");
      const res = await fetch(`/api/eval-jobs/${activeJobId}`);
      if (!res.ok) throw new Error("Failed to fetch job");
      return res.json();
    },
    enabled: !!activeJobId && !!authStatus?.user,
    refetchInterval: activeJobId ? 3000 : false, // Poll every 3 seconds when job is active
  });

  const createWorkflowMutation = useMutation({
    mutationFn: async () => {
      const provider = providers?.find(p => p.sku === productType);
      const res = await apiRequest("POST", "/api/workflows", {
        name: productName,
        description: `Self-test workflow for ${productName}`,
        providerId: provider?.id,
        visibility: "private",
        config: { url: productUrl },
      });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/workflows"] });
      setSelectedWorkflowId(data.id.toString());
      toast({ title: "Product registered", description: "You can now run benchmarks" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to register product", description: error.message, variant: "destructive" });
    },
  });

  const runBenchmarkMutation = useMutation({
    mutationFn: async (workflowId: number) => {
      const res = await apiRequest("POST", `/api/workflows/${workflowId}/run`, { region });
      return res.json();
    },
    onSuccess: (data) => {
      setActiveJobId(data.job.id);
      toast({ title: "Benchmark started", description: "Your test is now running" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to start benchmark", description: error.message, variant: "destructive" });
    },
  });

  const cancelJobMutation = useMutation({
    mutationFn: async (jobId: number) => {
      const res = await apiRequest("DELETE", `/api/eval-jobs/${jobId}`);
      return res.json();
    },
    onSuccess: () => {
      setActiveJobId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/eval-jobs"] });
      toast({ title: "Job cancelled" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to cancel job", description: error.message, variant: "destructive" });
    },
  });

  const handleRegisterProduct = () => {
    if (!productName) {
      toast({ title: "Product name required", variant: "destructive" });
      return;
    }
    createWorkflowMutation.mutate();
  };

  const handleRunBenchmark = () => {
    const workflowId = parseInt(selectedWorkflowId);
    if (!workflowId) {
      toast({ title: "Please select or register a product first", variant: "destructive" });
      return;
    }
    runBenchmarkMutation.mutate(workflowId);
  };

  const isLoggedIn = !!authStatus?.user;
  const isJobRunning = activeJob?.status === "pending" || activeJob?.status === "running";

  const getJobStatusIcon = (status: string) => {
    switch (status) {
      case "pending": return <Clock className="h-5 w-5 text-yellow-500" />;
      case "running": return <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />;
      case "completed": return <CheckCircle className="h-5 w-5 text-green-500" />;
      case "failed": return <XCircle className="h-5 w-5 text-red-500" />;
      default: return <AlertCircle className="h-5 w-5" />;
    }
  };

  const getJobStatusLabel = (status: string) => {
    switch (status) {
      case "pending": return "Waiting for agent...";
      case "running": return "Benchmark in progress...";
      case "completed": return "Benchmark complete!";
      case "failed": return "Benchmark failed";
      default: return status;
    }
  };

  const regionLabels: Record<string, string> = {
    na: "North America",
    apac: "Asia Pacific",
    eu: "Europe",
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-in zoom-in-95 duration-500">
      <div className="text-center space-y-4">
        <div className="inline-flex items-center gap-2 px-4 py-2 bg-primary/10 rounded-full text-primary font-medium">
          <Rocket className="h-4 w-4" />
          Run Your Own Benchmark
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
          Test Your Voice AI Product
        </h1>
        <p className="text-muted-foreground max-w-2xl mx-auto">
          Register your ConvoAI or RTC product and run real-world benchmarks across multiple regions.
          Compare your performance against industry standards.
        </p>
      </div>

      {!isLoggedIn ? (
        <Card className="border-primary/20">
          <CardContent className="pt-6">
            <div className="text-center space-y-4">
              <AlertCircle className="h-12 w-12 mx-auto text-muted-foreground" />
              <h3 className="text-lg font-semibold">Sign in to run benchmarks</h3>
              <p className="text-muted-foreground">
                Create a free account to register your products and run benchmarks.
              </p>
              <Button asChild>
                <Link href="/login">Sign In</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Configuration Panel */}
          <Card className="border-primary/20 relative overflow-hidden">
            <div className="absolute inset-0 z-0 opacity-5 pointer-events-none">
              <img src={generatedImage} className="w-full h-full object-cover" alt="" />
            </div>
            <CardHeader className="relative z-10">
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5" />
                Configure Benchmark
              </CardTitle>
              <CardDescription>
                Set up your product for testing
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6 relative z-10">
              <Tabs defaultValue="new" className="w-full">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="new">New Product</TabsTrigger>
                  <TabsTrigger value="existing">Existing</TabsTrigger>
                </TabsList>

                <TabsContent value="new" className="space-y-4 mt-4">
                  <div className="space-y-2">
                    <Label>Product Type</Label>
                    <Select value={productType} onValueChange={setProductType}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="convoai">ConvoAI Engine</SelectItem>
                        <SelectItem value="rtc">RTC Engine</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Product Name</Label>
                    <Input
                      placeholder="My Voice AI Product"
                      value={productName}
                      onChange={(e) => setProductName(e.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Product URL (optional)</Label>
                    <Input
                      placeholder="https://your-product.com/api"
                      value={productUrl}
                      onChange={(e) => setProductUrl(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      URL to your product's API endpoint for testing
                    </p>
                  </div>

                  <Button
                    onClick={handleRegisterProduct}
                    disabled={createWorkflowMutation.isPending || !productName}
                    className="w-full"
                  >
                    {createWorkflowMutation.isPending ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Registering...</>
                    ) : (
                      "Register Product"
                    )}
                  </Button>
                </TabsContent>

                <TabsContent value="existing" className="space-y-4 mt-4">
                  <div className="space-y-2">
                    <Label>Select Product</Label>
                    <Select value={selectedWorkflowId} onValueChange={setSelectedWorkflowId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a registered product" />
                      </SelectTrigger>
                      <SelectContent>
                        {workflows?.map((w) => (
                          <SelectItem key={w.id} value={w.id.toString()}>
                            {w.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {workflows?.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No products registered yet. Create one in the "New Product" tab.
                    </p>
                  )}
                </TabsContent>
              </Tabs>

              <div className="space-y-2 pt-4 border-t">
                <Label>Target Region</Label>
                <Select value={region} onValueChange={setRegion}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="na">North America</SelectItem>
                    <SelectItem value="apac">Asia Pacific</SelectItem>
                    <SelectItem value="eu">Europe</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
            <CardFooter className="relative z-10">
              <Button
                className="w-full"
                size="lg"
                onClick={handleRunBenchmark}
                disabled={runBenchmarkMutation.isPending || isJobRunning || !selectedWorkflowId}
              >
                {runBenchmarkMutation.isPending ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Starting...</>
                ) : isJobRunning ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Job Running...</>
                ) : (
                  <><Play className="mr-2 h-4 w-4" /> Start Benchmark</>
                )}
              </Button>
            </CardFooter>
          </Card>

          {/* Status Panel */}
          <Card>
            <CardHeader>
              <CardTitle>Benchmark Status</CardTitle>
              <CardDescription>
                Monitor your running benchmarks
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {activeJob ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {getJobStatusIcon(activeJob.status)}
                      <div>
                        <div className="font-medium">{getJobStatusLabel(activeJob.status)}</div>
                        <div className="text-sm text-muted-foreground">
                          Region: {regionLabels[activeJob.region] || activeJob.region}
                        </div>
                      </div>
                    </div>
                    <Badge variant={activeJob.status === "completed" ? "default" : "secondary"}>
                      {activeJob.status}
                    </Badge>
                  </div>

                  {(activeJob.status === "pending" || activeJob.status === "running") && (
                    <div className="space-y-2">
                      <Progress value={activeJob.status === "pending" ? 10 : 60} className="h-2" />
                      <p className="text-xs text-muted-foreground text-center">
                        {activeJob.status === "pending"
                          ? "Waiting for available eval agent..."
                          : "Running benchmark tests..."}
                      </p>
                    </div>
                  )}

                  {activeJob.error && (
                    <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
                      <p className="text-sm text-destructive">{activeJob.error}</p>
                    </div>
                  )}

                  {activeJob.status === "completed" && (
                    <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-md text-center">
                      <CheckCircle className="h-8 w-8 mx-auto text-green-500 mb-2" />
                      <p className="font-medium">Benchmark Complete!</p>
                      <p className="text-sm text-muted-foreground">
                        View results in the Leaderboard
                      </p>
                      <Button asChild variant="link" className="mt-2">
                        <Link href="/leaderboard">View Leaderboard</Link>
                      </Button>
                    </div>
                  )}

                  <div className="flex gap-2">
                    {activeJob.status === "pending" && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => cancelJobMutation.mutate(activeJob.id)}
                        disabled={cancelJobMutation.isPending}
                      >
                        <XCircle className="mr-2 h-4 w-4" />
                        Cancel
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => refetchJob()}
                    >
                      Refresh Status
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Clock className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No active benchmark</p>
                  <p className="text-sm">Configure and start a benchmark to see status here</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Info Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <h3 className="font-semibold mb-2">Real Infrastructure</h3>
            <p className="text-sm text-muted-foreground">
              Tests run on our distributed eval agents across NA, APAC, and EU regions.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <h3 className="font-semibold mb-2">Comprehensive Metrics</h3>
            <p className="text-sm text-muted-foreground">
              Measure response latency, interrupt latency, network resilience, and more.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <h3 className="font-semibold mb-2">Compare & Improve</h3>
            <p className="text-sm text-muted-foreground">
              See how your product stacks up against industry benchmarks.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
