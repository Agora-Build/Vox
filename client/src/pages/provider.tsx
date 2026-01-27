import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowRight, Code, Terminal, Clock, Zap, Wifi, Mic, Volume2, Globe, Server, Shield } from "lucide-react";
import { Link } from "wouter";

export default function ProviderGuide() {
  return (
    <div className="max-w-4xl mx-auto space-y-12 animate-in fade-in duration-500">
      <div className="text-center space-y-4">
        <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight">Integration & Evaluation Guide</h1>
        <p className="text-base sm:text-lg md:text-xl text-muted-foreground">How we measure performance and how to integrate your own product.</p>
      </div>

      {/* Key Metrics Overview */}
      <section className="space-y-6">
        <h2 className="text-2xl font-bold border-b pb-2">Key Performance Metrics</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4 text-blue-500" />
                Response Latency
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Time from user speech end (VAD inactive) to first audio byte received. Target: &lt;500ms.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Zap className="h-4 w-4 text-yellow-500" />
                Interrupt Latency
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Time from user speech detection during playback to audio stream stop. Target: &lt;200ms.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Wifi className="h-4 w-4 text-green-500" />
                Network Resilience
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Ability to maintain quality under packet loss (up to 40%) and variable jitter conditions.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Mic className="h-4 w-4 text-purple-500" />
                Naturalness
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">AI-evaluated score for turn-taking fluidity, tone consistency, and prosody (1-5 scale).</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Volume2 className="h-4 w-4 text-orange-500" />
                Noise Reduction
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Percentage of background noise suppressed while maintaining speech clarity.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Globe className="h-4 w-4 text-cyan-500" />
                Multi-Region
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Tests run across NA, APAC, and EU regions to measure global performance consistency.</p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Test Environment */}
      <section className="space-y-6">
        <h2 className="text-2xl font-bold border-b pb-2">Test Environment</h2>
        <div className="grid md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Server className="h-5 w-5" />
                Infrastructure
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>All evaluations run on standardized cloud instances:</p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li>AWS c5.large (2 vCPU, 4GB RAM)</li>
                <li>Dedicated network interface</li>
                <li>Ubuntu 22.04 LTS</li>
                <li>Chrome 120+ headless browser</li>
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Network Simulation
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>Real-world conditions simulated using <code className="bg-muted px-1 rounded">tc-netem</code>:</p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li>Packet loss: 0-40% (configurable)</li>
                <li>Jitter: 0-100ms (variable)</li>
                <li>Latency injection: regional simulation</li>
                <li>Bandwidth throttling support</li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Evaluation Workflow */}
      <section className="space-y-6">
        <h2 className="text-2xl font-bold border-b pb-2">Evaluation Workflow</h2>
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Badge variant="outline" className="h-8 w-8 rounded-full flex items-center justify-center">1</Badge>
                <div>
                  <p className="font-medium">Schedule</p>
                  <p className="text-sm text-muted-foreground">Create workflow with cron schedule</p>
                </div>
              </div>
              <ArrowRight className="hidden md:block h-4 w-4 text-muted-foreground" />
              <div className="flex items-center gap-3">
                <Badge variant="outline" className="h-8 w-8 rounded-full flex items-center justify-center">2</Badge>
                <div>
                  <p className="font-medium">Execute</p>
                  <p className="text-sm text-muted-foreground">Agents run tests in region</p>
                </div>
              </div>
              <ArrowRight className="hidden md:block h-4 w-4 text-muted-foreground" />
              <div className="flex items-center gap-3">
                <Badge variant="outline" className="h-8 w-8 rounded-full flex items-center justify-center">3</Badge>
                <div>
                  <p className="font-medium">Measure</p>
                  <p className="text-sm text-muted-foreground">Capture all latency metrics</p>
                </div>
              </div>
              <ArrowRight className="hidden md:block h-4 w-4 text-muted-foreground" />
              <div className="flex items-center gap-3">
                <Badge variant="outline" className="h-8 w-8 rounded-full flex items-center justify-center">4</Badge>
                <div>
                  <p className="font-medium">Report</p>
                  <p className="text-sm text-muted-foreground">Results on leaderboard</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Integration SDK */}
      <section className="space-y-6">
        <h2 className="text-2xl font-bold border-b pb-2">Integration SDK</h2>
        <p className="text-muted-foreground">
          To integrate your conversational AI agent into our leaderboard, use our standardized SDK.
        </p>

        <div className="bg-card border rounded-lg overflow-hidden">
          <div className="bg-muted px-4 py-2 border-b flex items-center gap-2">
            <Terminal className="h-4 w-4" />
            <span className="text-sm font-mono">bash</span>
          </div>
          <div className="p-4 font-mono text-sm overflow-x-auto">
            npm install @ai-latency/eval-sdk
          </div>
        </div>

        <div className="bg-card border rounded-lg overflow-hidden">
          <div className="bg-muted px-4 py-2 border-b flex items-center gap-2">
            <Code className="h-4 w-4" />
            <span className="text-sm font-mono">typescript</span>
          </div>
          <div className="p-4 font-mono text-sm overflow-x-auto whitespace-pre">
{`import { Evaluator } from "@ai-latency/eval-sdk";

const evaluator = new Evaluator({
  apiKey: "YOUR_API_KEY",
  endpoint: "wss://api.your-agent.com/v1/stream"
});

// Run a standardized test suite
const results = await evaluator.runSuite({
  duration: 60, // seconds
  scenarios: ["support", "sales", "casual"],
  networkConditions: {
    packetLoss: 0.05,  // 5%
    jitter: 20,        // ms
  }
});

console.log(results.responseLatency.median);
console.log(results.interruptLatency.median);`}
          </div>
        </div>
      </section>

      {/* API Keys */}
      <section className="space-y-6">
        <h2 className="text-2xl font-bold border-b pb-2">API Access</h2>
        <Card>
          <CardHeader>
            <CardTitle>REST API</CardTitle>
            <CardDescription>Programmatic access to evaluation results and job management</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-card border rounded-lg overflow-hidden">
              <div className="bg-muted px-4 py-2 border-b flex items-center gap-2">
                <Terminal className="h-4 w-4" />
                <span className="text-sm font-mono">bash</span>
              </div>
              <div className="p-4 font-mono text-sm overflow-x-auto whitespace-pre">
{`# Get evaluation results
curl -H "Authorization: Bearer vox_live_xxx" \\
  https://api.vox.ai/v1/results

# Trigger evaluation job
curl -X POST -H "Authorization: Bearer vox_live_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"workflowId": 1, "region": "na"}' \\
  https://api.vox.ai/v1/jobs`}
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <Link href="/console/api-keys">
                <Button variant="outline" className="gap-2 w-full sm:w-auto">
                  Manage API Keys <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <Button size="default" className="gap-2">
                View Full Documentation <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Get Started CTA */}
      <section className="text-center space-y-4 py-8 border-t">
        <h2 className="text-xl font-bold">Ready to benchmark your agent?</h2>
        <p className="text-muted-foreground">Create an account to get started with evaluations.</p>
        <div className="flex justify-center gap-3">
          <Link href="/run-your-own">
            <Button size="lg" variant="outline">
              Quick Test
            </Button>
          </Link>
          <Link href="/console/workflows">
            <Button size="lg" className="gap-2">
              Create Workflow <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </section>
    </div>
  );
}
