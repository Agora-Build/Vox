import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { ArrowRight, Clock, Globe, Zap, Activity, Mic, Bot, Settings, Radio } from "lucide-react";

export default function Home() {
  return (
    <div className="space-y-20 animate-in fade-in duration-700 pb-20">
      {/* Hero Section */}
      <section className="text-center space-y-6 pt-6 md:pt-10">
        <h1 className="text-3xl sm:text-5xl md:text-7xl font-bold tracking-tight bg-gradient-to-br from-foreground to-muted-foreground bg-clip-text text-transparent">
          Track AI Performance<br />Across the World
        </h1>
        <p className="text-base sm:text-lg md:text-xl text-muted-foreground max-w-3xl mx-auto leading-relaxed px-2">
          Automated benchmark testing for conversational AI products. Monitor respond latency, 
          interrupt latency, network resilience, naturalness, and noise reduction across multiple regions.
        </p>
        <div className="flex flex-col sm:flex-row justify-center gap-3 sm:gap-4 pt-4 px-4 sm:px-0">
          <Link href="/realtime">
            <Button size="lg" className="gap-2 w-full sm:w-auto">
              <Activity className="h-5 w-5" /> View Real-Time Data
            </Button>
          </Link>
          <Link href="/leaderboard">
            <Button variant="outline" size="lg" className="gap-2 w-full sm:w-auto">
              <ArrowRight className="h-5 w-5" /> Check Leaderboard
            </Button>
          </Link>
        </div>
      </section>

      {/* Features Grid */}
      <section className="space-y-12">
        <div className="text-center space-y-4">
          <h2 className="text-3xl font-bold">Comprehensive Benchmarking</h2>
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
                Comprehensive benchmarks run automatically every 8 hours across all selected products and regions.
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
                <Zap className="h-6 w-6 text-amber-500" />
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

      {/* Supported Products */}
      <section className="space-y-12">
        <div className="text-center space-y-4">
          <Badge variant="secondary" className="px-4 py-1">Supported Products</Badge>
          <h2 className="text-3xl font-bold">Products We Test</h2>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            Currently benchmarking browser-based conversational AI products. RTC solutions coming soon.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          <Card className="relative overflow-hidden">
            <CardHeader>
              <Mic className="h-8 w-8 mb-4 text-primary" />
              <CardTitle className="text-lg">Agora ConvoAI</CardTitle>
              <CardDescription>ConvoAI Engine</CardDescription>
            </CardHeader>
            <CardContent>
              <Badge variant="outline" className="text-emerald-500 border-emerald-500/20 bg-emerald-500/10">Active</Badge>
            </CardContent>
          </Card>

          <Card className="relative overflow-hidden">
            <CardHeader>
              <Bot className="h-8 w-8 mb-4 text-primary" />
              <CardTitle className="text-lg">LiveKIT Agent</CardTitle>
              <CardDescription>LiveKit</CardDescription>
            </CardHeader>
            <CardContent>
              <Badge variant="outline" className="text-emerald-500 border-emerald-500/20 bg-emerald-500/10">Active</Badge>
            </CardContent>
          </Card>

          <Card className="relative overflow-hidden opacity-75">
            <CardHeader>
              <Settings className="h-8 w-8 mb-4 text-muted-foreground" />
              <CardTitle className="text-lg">Custom ConvoAI</CardTitle>
              <CardDescription>Custom Solutions</CardDescription>
            </CardHeader>
            <CardContent>
              <Badge variant="secondary">Coming Soon</Badge>
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
                <Zap className="h-5 w-5 text-amber-500" />
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
                <Activity className="h-5 w-5 text-red-500" />
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

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2 mb-2">
                <Globe className="h-5 w-5 text-blue-500" />
                <h3 className="font-bold">Network Resilience</h3>
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
        </div>
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
