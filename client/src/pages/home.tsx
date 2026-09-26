import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { ArrowRight, Clock, Globe, Rocket, Activity, Mic, Bot, AudioLines, Settings, Radio } from "lucide-react";

export default function Home() {
  return (
    <div className="space-y-20 animate-in fade-in duration-700 pb-20">
      {/* Hero Section */}
      <section className="text-center space-y-6 pt-6 md:pt-10">
        <h1 className="text-3xl sm:text-5xl md:text-7xl font-bold tracking-tight bg-gradient-to-br from-foreground to-muted-foreground bg-clip-text text-transparent">
          Track Your Products Experience<br />Across the World
        </h1>
        <p className="text-base sm:text-lg md:text-xl text-muted-foreground max-w-3xl mx-auto leading-relaxed px-2">
          Automated evaluation testing for conversational AI products. Monitor respond latency,
          interrupt latency, network resilience, naturalness, and noise reduction across multiple regions.
        </p>
        <div className="flex flex-col sm:flex-row justify-center gap-3 sm:gap-4 pt-4 px-4 sm:px-0">
          <Link href="/realtime">
            <Button size="lg" className="gap-2 w-full sm:w-auto bg-gradient-to-r from-primary to-indigo-500 hover:from-primary/90 hover:to-indigo-500/90 shadow-lg shadow-primary/25 transition-all hover:shadow-xl hover:shadow-primary/30">
              <span className="inline-block bg-[length:200%_100%] bg-clip-text text-transparent animate-[shimmer_3s_linear_infinite] bg-gradient-to-r from-white/40 via-white via-45% to-white/40">
                Explore Real-time Dashboard
              </span>
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
          <Link href="/leaderboard">
            <Button variant="outline" size="lg" className="gap-2 w-full sm:w-auto">
              Check Leaderboard <ArrowRight className="h-5 w-5" />
            </Button>
          </Link>
        </div>
      </section>


      {/* Products — ours, as distinct from the providers we test */}
      <section className="space-y-12">
        <div className="text-center space-y-4">
          <Badge variant="secondary" className="px-4 py-1">Products</Badge>
          <h2 className="text-3xl font-bold">Three parts, one pipeline</h2>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            Vox decides what to measure and keeps the history. aeval runs the conversation
            and scores it. DialF places the call when the target is a phone.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          <Card className="relative overflow-hidden">
            <CardHeader>
              <Activity className="h-8 w-8 mb-4 text-primary" />
              <CardTitle>Real-time Eval</CardTitle>
              <CardDescription>
                Schedule evals, watch latency and turn-taking land live, and keep every run's
                frozen provenance.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/realtime">
                <Button variant="outline" size="sm" className="gap-2" data-testid="link-product-realtime">
                  Open dashboard <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </CardContent>
          </Card>

          <Card className="relative overflow-hidden">
            <CardHeader>
              <AudioLines className="h-8 w-8 mb-4 text-primary" />
              <CardTitle>aeval</CardTitle>
              <CardDescription>
                The eval engine: drives the conversation, measures response and interrupt
                latency turn by turn, and reports turn-taking success.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <a href="https://github.com/Agora-Build/aeval" target="_blank" rel="noreferrer">
                <Button variant="outline" size="sm" className="gap-2" data-testid="link-product-aeval">
                  View on GitHub <ArrowRight className="h-4 w-4" />
                </Button>
              </a>
            </CardContent>
          </Card>

          <Card className="relative overflow-hidden">
            <CardHeader>
              <Radio className="h-8 w-8 mb-4 text-primary" />
              <CardTitle>DialF</CardTitle>
              <CardDescription>
                Autonomous phone control: places and answers real PSTN calls over a handset,
                with scripted audio and voice activity detection.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <a href="https://github.com/Agora-Build/DialF" target="_blank" rel="noreferrer">
                <Button variant="outline" size="sm" className="gap-2" data-testid="link-product-dialf">
                  View on GitHub <ArrowRight className="h-4 w-4" />
                </Button>
              </a>
            </CardContent>
          </Card>
        </div>

        {/* What you can point an eval at today, and what's next. */}
        <div className="flex flex-wrap items-center justify-center gap-3 text-sm">
          <span className="text-muted-foreground">Evaluate over</span>
          <Badge variant="outline" className="gap-1.5 py-1" data-testid="badge-surface-web">Web</Badge>
          <Badge variant="outline" className="gap-1.5 py-1" data-testid="badge-surface-phone">Phone</Badge>
          <Badge variant="secondary" className="gap-1.5 py-1" data-testid="badge-surface-native">Native apps — coming</Badge>
        </div>
      </section>

      {/* Features Grid */}
      <section className="space-y-12">
        <div className="text-center space-y-4">
          <h2 className="text-3xl font-bold">Comprehensive Evaluation</h2>
          <p className="text-muted-foreground">Everything you need to understand how AI products perform in production</p>
        </div>
        
        <div className="grid md:grid-cols-2 gap-6">
          <Card className="bg-card/50 backdrop-blur-sm border-primary/10 hover:border-primary/20 transition-colors">
            <CardHeader>
              <div className="w-12 h-12 rounded-lg bg-blue-500/10 flex items-center justify-center mb-4">
                <Clock className="h-6 w-6 text-blue-500" />
              </div>
              <CardTitle>Automated Testing</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">
                Comprehensive evaluations run automatically every 8 hours across all selected products and regions.
              </p>
            </CardContent>
          </Card>

          <Card className="bg-card/50 backdrop-blur-sm border-primary/10 hover:border-primary/20 transition-colors">
            <CardHeader>
              <div className="w-12 h-12 rounded-lg bg-indigo-500/10 flex items-center justify-center mb-4">
                <Globe className="h-6 w-6 text-indigo-500" />
              </div>
              <CardTitle>Multi-Region Coverage</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">
                Test from US East, US West, Europe, Asia-Pacific, and more to understand regional performance.
              </p>
            </CardContent>
          </Card>

          <Card className="bg-card/50 backdrop-blur-sm border-primary/10 hover:border-primary/20 transition-colors">
            <CardHeader>
              <div className="w-12 h-12 rounded-lg bg-amber-500/10 flex items-center justify-center mb-4">
                <Rocket className="h-6 w-6 text-amber-500" />
              </div>
              <CardTitle>Real-Time Updates</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">
                Live data dashboard showing the latest metrics and performance trends as tests complete.
              </p>
            </CardContent>
          </Card>

          <Card className="bg-card/50 backdrop-blur-sm border-primary/10 hover:border-primary/20 transition-colors">
            <CardHeader>
              <div className="w-12 h-12 rounded-lg bg-emerald-500/10 flex items-center justify-center mb-4">
                <Activity className="h-6 w-6 text-emerald-500" />
              </div>
              <CardTitle>5 Key Metrics</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">
                Response latency, interrupt latency, network resilience, naturalness, and noise reduction analysis.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Providers we evaluate against (third-party) */}
      <section className="space-y-12">
        <div className="text-center space-y-4">
          <Badge variant="secondary" className="px-4 py-1">Supported Providers</Badge>
          <h2 className="text-3xl font-bold">Providers We Test</h2>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            Currently evaluating browser-based conversational AI products. RTC solutions coming soon.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          <Card className="relative overflow-hidden">
            <CardHeader>
              <Mic className="h-8 w-8 mb-4 text-primary" />
              <CardTitle className="text-lg">Agora ConvoAI Engine</CardTitle>
              <CardDescription>Agora's Conversational AI Engine</CardDescription>
            </CardHeader>
            <CardContent>
              <Badge variant="outline" className="text-emerald-500 border-emerald-500/20 bg-emerald-500/10">Active</Badge>
            </CardContent>
          </Card>

          <Card className="relative overflow-hidden">
            <CardHeader>
              <Bot className="h-8 w-8 mb-4 text-primary" />
              <CardTitle className="text-lg">LiveKit Agents</CardTitle>
              <CardDescription>LiveKit's Real-time Communication Agents</CardDescription>
            </CardHeader>
            <CardContent>
              <Badge variant="outline" className="text-emerald-500 border-emerald-500/20 bg-emerald-500/10">Active</Badge>
            </CardContent>
          </Card>

          <Card className="relative overflow-hidden">
            <CardHeader>
              <AudioLines className="h-8 w-8 mb-4 text-primary" />
              <CardTitle className="text-lg">ElevenLabs Agents</CardTitle>
              <CardDescription>ElevenLabs Conversational AI Agents</CardDescription>
            </CardHeader>
            <CardContent>
              <Badge variant="outline" className="text-emerald-500 border-emerald-500/20 bg-emerald-500/10">Active</Badge>
            </CardContent>
          </Card>

          <Card className="relative overflow-hidden opacity-75">
            <CardHeader>
              <Radio className="h-8 w-8 mb-4 text-muted-foreground" />
              <CardTitle className="text-lg">RTC Solutions</CardTitle>
              <CardDescription>WebRTC Providers</CardDescription>
            </CardHeader>
            <CardContent>
              <Badge variant="secondary">Future</Badge>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Metrics Detail */}
      <section className="space-y-12">
        <div className="text-center space-y-4">
          <h2 className="text-3xl font-bold">5 Key Metrics</h2>
          <p className="text-muted-foreground">We measure critical performance indicators that impact real-world user experience</p>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2 mb-2">
                <Clock className="h-5 w-5 text-amber-500" />
                <h3 className="font-bold">Response Latency</h3>
              </div>
              <p className="text-sm text-muted-foreground">Time for AI to generate initial response</p>
            </CardHeader>
            <CardContent className="space-y-4">
               <div>
                  <div className="text-xs uppercase text-muted-foreground font-bold">Unit</div>
                  <div className="font-mono">milliseconds (ms)</div>
               </div>
               <div className="pt-2">
                 <Badge className="bg-emerald-500 hover:bg-emerald-600">Lower is better</Badge>
               </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2 mb-2">
                <Clock className="h-5 w-5 text-amber-500" />
                <h3 className="font-bold">Interrupt Latency</h3>
              </div>
              <p className="text-sm text-muted-foreground">Time to process and respond to interruptions</p>
            </CardHeader>
            <CardContent className="space-y-4">
               <div>
                  <div className="text-xs uppercase text-muted-foreground font-bold">Unit</div>
                  <div className="font-mono">milliseconds (ms)</div>
               </div>
               <div className="pt-2">
                 <Badge className="bg-emerald-500 hover:bg-emerald-600">Lower is better</Badge>
               </div>
            </CardContent>
          </Card>

          <Card className="opacity-60">
            <CardHeader>
              <div className="flex items-center gap-2 mb-2">
                <Mic className="h-5 w-5 text-purple-500" />
                <h3 className="font-bold">Noise Reduction</h3>
                <Badge variant="outline" className="text-xs">Coming Soon</Badge>
              </div>
              <p className="text-sm text-muted-foreground">Ability to filter background noise while preserving voice clarity</p>
            </CardHeader>
            <CardContent className="space-y-4">
               <div>
                  <div className="text-xs uppercase text-muted-foreground font-bold">Unit</div>
                  <div className="font-mono">percentage (%)</div>
               </div>
               <div className="pt-2">
                 <Badge className="bg-emerald-500 hover:bg-emerald-600">Higher is better</Badge>
               </div>
            </CardContent>
          </Card>

          <Card className="opacity-60">
            <CardHeader>
              <div className="flex items-center gap-2 mb-2">
                <Globe className="h-5 w-5 text-blue-500" />
                <h3 className="font-bold">Network Resilience</h3>
                <Badge variant="outline" className="text-xs">Coming Soon</Badge>
              </div>
              <p className="text-sm text-muted-foreground">Stability under varying network conditions</p>
            </CardHeader>
            <CardContent className="space-y-4">
               <div>
                  <div className="text-xs uppercase text-muted-foreground font-bold">Unit</div>
                  <div className="font-mono">percentage (%)</div>
               </div>
               <div className="pt-2">
                 <Badge className="bg-emerald-500 hover:bg-emerald-600">Higher is better</Badge>
               </div>
            </CardContent>
          </Card>

          <Card className="opacity-60">
            <CardHeader>
              <div className="flex items-center gap-2 mb-2">
                <Bot className="h-5 w-5 text-green-500" />
                <h3 className="font-bold">Naturalness</h3>
                <Badge variant="outline" className="text-xs">Coming Soon</Badge>
              </div>
              <p className="text-sm text-muted-foreground">How human-like and natural the AI voice sounds</p>
            </CardHeader>
            <CardContent className="space-y-4">
               <div>
                  <div className="text-xs uppercase text-muted-foreground font-bold">Unit</div>
                  <div className="font-mono">score (0-10)</div>
               </div>
               <div className="pt-2">
                 <Badge className="bg-emerald-500 hover:bg-emerald-600">Higher is better</Badge>
               </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Where this is going — clearly labelled as not-yet-built */}
      <section className="space-y-10">
        <div className="text-center space-y-4">
          <Badge variant="secondary" className="px-4 py-1">Where this is going</Badge>
          <h2 className="text-3xl font-bold">From measuring agents to improving them</h2>
          <p className="text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Evaluation is the first half. Knowing an agent answers 400 ms slower in Mumbai, or
            drops one turn in eight, only pays off when something acts on it. The direction is a
            loop that closes itself: simulate, find where conversations fail, propose the change,
            prove it against the same evals.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          <Card className="border-dashed">
            <CardHeader>
              <Bot className="h-8 w-8 mb-4 text-muted-foreground" />
              <CardTitle className="text-lg">Simulate automatically</CardTitle>
              <CardDescription>
                Run conversations your users would have had — across regions, accents and
                interruption patterns — without writing each one by hand.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card className="border-dashed">
            <CardHeader>
              <Settings className="h-8 w-8 mb-4 text-muted-foreground" />
              <CardTitle className="text-lg">Suggest the fix</CardTitle>
              <CardDescription>
                Turn a failed turn into a concrete change to the prompt or config, tied to the
                evidence that motivated it.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card className="border-dashed">
            <CardHeader>
              <Clock className="h-8 w-8 mb-4 text-muted-foreground" />
              <CardTitle className="text-lg">Prove it moved</CardTitle>
              <CardDescription>
                Re-run the same evals against the change, so &quot;better&quot; is a number on the
                same scale as before — not a hunch.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>

        <p className="text-center text-sm text-muted-foreground">
          None of this is built yet. Today Vox measures and tracks; the self-improvement loop is
          the roadmap, and we would rather show the gap than imply it is closed.
        </p>
      </section>

      {/* CTA */}
      <section className="bg-gradient-to-r from-secondary/50 to-background border rounded-2xl p-12 text-center space-y-6">
        <h2 className="text-3xl font-bold">Ready to dive deeper?</h2>
        <p className="text-muted-foreground max-w-xl mx-auto">
          Check out our comprehensive leaderboard to compare products across all five metrics.
        </p>
        <Link href="/leaderboard">
          <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90">
            View Full Leaderboard
          </Button>
        </Link>
      </section>
    </div>
  );
}
