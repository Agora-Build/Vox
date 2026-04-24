import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowRight, Clock, Wifi, Mic, Volume2, Globe, Server, Shield, ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";

interface Provider {
  id: string;
  name: string;
  sku: string;
  description: string | null;
}

interface ProviderGuideContent {
  approach: string;
  description: string;
  docsUrl: string;
  docsLabel: string;
  features: string[];
}

const PROVIDER_GUIDES: Record<string, ProviderGuideContent> = {
  "Agora ConvoAI Engine": {
    approach: "REST API + SDKs",
    description: "Agora provides a managed Conversational AI Engine accessible via REST API. Create and control voice agents within Agora's RTC channels using your App ID and API credentials. The platform handles the full STT-LLM-TTS pipeline with built-in voice activity detection and interruption handling.",
    docsUrl: "https://docs.agora.io/en/conversational-ai/overview/product-overview",
    docsLabel: "Agora ConvoAI Docs",
    features: [
      "REST API for starting/stopping agents in RTC channels",
      "Multiple LLM provider support (OpenAI, custom endpoints)",
      "Built-in VAD and barge-in handling",
      "Server-side SDKs (Python, Go, Node.js)",
    ],
  },
  "LiveKit Agents": {
    approach: "Open-Source SDK Framework",
    description: "LiveKit Agents is an open-source framework for building real-time voice AI agents. Install the SDK, define your voice pipeline (STT → LLM → TTS), and deploy on LiveKit's infrastructure or self-host. Supports both multimodal and custom pipeline architectures.",
    docsUrl: "https://docs.livekit.io/agents/",
    docsLabel: "LiveKit Agents Docs",
    features: [
      "Open-source Python and Node.js SDKs",
      "VoicePipelineAgent for custom STT-LLM-TTS chains",
      "MultimodalAgent for OpenAI Realtime API",
      "Plugin system for major AI providers",
    ],
  },
  "ElevenLabs Agents": {
    approach: "Web Console + REST API + SDKs",
    description: "ElevenLabs offers conversational AI agents through a web dashboard (no-code), REST API, or client SDKs. Build agents with 10,000+ voices, 70+ languages, and built-in RAG. Connect via WebRTC for low-latency voice interactions.",
    docsUrl: "https://elevenlabs.io/docs/agents-platform/overview",
    docsLabel: "ElevenLabs Agents Docs",
    features: [
      "No-code agent builder via web dashboard",
      "REST API and CLI for programmatic control",
      "Client SDKs: JavaScript, React, Python, iOS",
      "Built-in RAG and tool integration",
    ],
  },
};

export default function ProviderGuide() {
  const { data: providers, isLoading: providersLoading } = useQuery<Provider[]>({
    queryKey: ["/api/providers"],
  });

  // Filter to convoai providers only
  const convoaiProviders = providers?.filter(p => p.sku === "convoai") ?? [];

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
              <p className="text-sm text-muted-foreground">Time from user speech end (VAD inactive) to first audio byte received. Ideal: &lt;1600ms.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4 text-blue-500" />
                Interrupt Latency
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Time from user speech detection during playback to audio stream stop. Ideal: &lt;600ms.</p>
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
              <p className="text-sm text-muted-foreground">Tests run across North America, Asia Pacific, Europe, and South America to measure global performance consistency.</p>
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

      {/* Build Your Agent — Dynamic Provider Tabs */}
      <section className="space-y-6">
        <h2 className="text-2xl font-bold border-b pb-2">Build Your Agent</h2>
        <p className="text-muted-foreground">
          Choose a provider to build your conversational AI agent, then evaluate it on Vox.
        </p>

        {providersLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-80" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : convoaiProviders.length > 0 ? (
          <Tabs defaultValue={convoaiProviders[0].name}>
            <TabsList className="flex-wrap h-auto gap-1">
              {convoaiProviders.map(p => (
                <TabsTrigger key={p.id} value={p.name}>{p.name}</TabsTrigger>
              ))}
            </TabsList>

            {convoaiProviders.map(p => {
              const guide = PROVIDER_GUIDES[p.name];
              return (
                <TabsContent key={p.id} value={p.name} className="mt-4">
                  <Card>
                    <CardHeader>
                      <CardTitle>{p.name}</CardTitle>
                      <CardDescription>{guide?.approach ?? "Conversational AI Platform"}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <p className="text-sm text-muted-foreground">
                        {guide?.description ?? p.description ?? "Build conversational AI agents with this provider."}
                      </p>
                      {guide?.features && (
                        <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground ml-2">
                          {guide.features.map((f, i) => <li key={i}>{f}</li>)}
                        </ul>
                      )}
                      {guide ? (
                        <a href={guide.docsUrl} target="_blank" rel="noopener noreferrer">
                          <Button variant="outline" className="gap-2">
                            {guide.docsLabel} <ExternalLink className="h-4 w-4" />
                          </Button>
                        </a>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">Visit the provider's website for integration documentation.</p>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>
              );
            })}
          </Tabs>
        ) : (
          <p className="text-sm text-muted-foreground">No providers available.</p>
        )}
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
