import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowRight, Code, Terminal } from "lucide-react";

export default function ProviderGuide() {
  return (
    <div className="max-w-4xl mx-auto space-y-12 animate-in fade-in duration-500">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold tracking-tight">Integration & Evaluation Guide</h1>
        <p className="text-xl text-muted-foreground">How we measure performance and how to integrate your own product.</p>
      </div>

      <section className="space-y-6">
        <h2 className="text-2xl font-bold border-b pb-2">Evaluation Methodology</h2>
        <div className="grid md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Latency Measurement</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground">
              We measure <strong>Response Latency</strong> as the time delta between the end of user speech (VAD active false) and the first byte of audio response received.
              <br/><br/>
              <strong>Interrupt Latency</strong> is measured from the moment user speech is detected during agent playback to the moment the agent audio stream stops.
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Environment</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground">
              All tests are conducted on standardized cloud instances (AWS c5.large) simulating real-world network conditions using `tc-netem` for jitter and packet loss injection.
            </CardContent>
          </Card>
        </div>
      </section>

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
            npm install @ai-latency/benchmark-sdk
          </div>
        </div>

        <div className="bg-card border rounded-lg overflow-hidden">
          <div className="bg-muted px-4 py-2 border-b flex items-center gap-2">
            <Code className="h-4 w-4" />
            <span className="text-sm font-mono">typescript</span>
          </div>
          <div className="p-4 font-mono text-sm overflow-x-auto">
{`import { Benchmark } from "@ai-latency/benchmark-sdk";

const benchmark = new Benchmark({
  apiKey: "YOUR_API_KEY",
  endpoint: "wss://api.your-agent.com/v1/stream"
});

// Run a standardized test suite
await benchmark.runSuite({
  duration: 60, // seconds
  scenarios: ["support", "sales", "casual"]
});`}
          </div>
        </div>
        
        <div className="flex justify-center pt-4">
            <Button size="lg" className="gap-2">
                View Full Documentation <ArrowRight className="h-4 w-4" />
            </Button>
        </div>
      </section>
    </div>
  );
}
