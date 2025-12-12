import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Mic, Square, Play, Loader2, BarChart2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import generatedImage from '@assets/generated_images/abstract_digital_network_visualization_dark_blue.png';

export default function SelfTest() {
  const [isTesting, setIsTesting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const { toast } = useToast();
  const [results, setResults] = useState<{latency: number, quality: number} | null>(null);

  useEffect(() => {
    if (isTesting) {
      const interval = setInterval(() => {
        setProgress(prev => {
          if (prev >= 100) {
            clearInterval(interval);
            finishTest();
            return 100;
          }
          return prev + 2;
        });
      }, 100);

      // Simulate logs
      const logInterval = setInterval(() => {
        const messages = [
            "Connecting to nearest edge node...",
            "Establishing WebRTC connection...",
            "Sending audio packet...",
            "Measuring VAD response...",
            "Analyzing jitter buffer...",
            "Calculating MOS score..."
        ];
        const randomMsg = messages[Math.floor(Math.random() * messages.length)];
        setLogs(prev => [...prev.slice(-4), `[${new Date().toLocaleTimeString()}] ${randomMsg}`]);
      }, 800);

      return () => {
        clearInterval(interval);
        clearInterval(logInterval);
      };
    }
  }, [isTesting]);

  const startTest = () => {
    setIsTesting(true);
    setResults(null);
    setLogs(["Starting benchmark sequence..."]);
    setProgress(0);
  };

  const finishTest = () => {
    setIsTesting(false);
    setResults({
        latency: Math.floor(Math.random() * 200) + 300,
        quality: 4.5
    });
    toast({
        title: "Benchmark Complete",
        description: "Your local connection performance has been recorded."
    });
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8 animate-in zoom-in-95 duration-500">
      <div className="text-center">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Run Self-Initiated Benchmark</h1>
        <p className="text-sm sm:text-base text-muted-foreground mt-2">Test your current connection quality against our reference agents.</p>
      </div>

      <Card className="border-primary/20 shadow-lg relative overflow-hidden">
        {/* Background decorative image with overlay */}
        <div className="absolute inset-0 z-0 opacity-10 pointer-events-none">
            <img src={generatedImage} className="w-full h-full object-cover" alt="" />
        </div>
        
        <CardHeader className="relative z-10">
          <CardTitle>Interactive Test Session</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 relative z-10">
          <div className="bg-black/40 rounded-lg p-6 min-h-[200px] font-mono text-sm text-green-400 border border-white/10 flex flex-col justify-end">
            {logs.map((log, i) => (
                <div key={i} className="animate-in fade-in slide-in-from-left-2">{log}</div>
            ))}
            {isTesting && <div className="animate-pulse">_</div>}
            {!isTesting && logs.length === 0 && <div className="text-muted-foreground text-center self-center my-auto">Ready to start benchmark...</div>}
          </div>

          {isTesting && (
            <div className="space-y-2">
                <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Progress</span>
                    <span>{progress}%</span>
                </div>
                <Progress value={progress} className="h-2" />
            </div>
          )}

          {results && (
             <div className="grid grid-cols-2 gap-4 pt-4 animate-in fade-in slide-in-from-bottom-4">
                <div className="bg-secondary p-4 rounded-lg text-center">
                    <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Response Latency</div>
                    <div className="text-2xl font-bold font-mono text-primary">{results.latency}ms</div>
                </div>
                <div className="bg-secondary p-4 rounded-lg text-center">
                    <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Quality Score</div>
                    <div className="text-2xl font-bold font-mono text-primary">{results.quality}/5.0</div>
                </div>
             </div>
          )}
        </CardContent>
        <CardFooter className="flex flex-col sm:flex-row gap-3 sm:justify-between relative z-10">
            <div className="text-xs sm:text-sm text-muted-foreground text-center sm:text-left">
                Target: <strong>Agora ConvoAI (North America)</strong>
            </div>
          {!isTesting ? (
            <Button onClick={startTest} size="lg" className="gap-2">
                <Play className="h-4 w-4" /> Start Benchmark
            </Button>
          ) : (
            <Button disabled variant="secondary" size="lg" className="gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Running...
            </Button>
          )}
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
            <CardTitle>Rate your experience</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
            <div className="space-y-2">
                <div className="flex flex-col sm:flex-row sm:justify-between gap-1">
                    <Label>Naturalness</Label>
                    <span className="text-xs sm:text-sm text-muted-foreground">How human-like was the interaction?</span>
                </div>
                <Slider defaultValue={[3]} max={5} step={1} />
            </div>
             <div className="space-y-2">
                <div className="flex flex-col sm:flex-row sm:justify-between gap-1">
                    <Label>Responsiveness</Label>
                    <span className="text-xs sm:text-sm text-muted-foreground">Did it feel instantaneous?</span>
                </div>
                <Slider defaultValue={[4]} max={5} step={1} />
            </div>
        </CardContent>
        <CardFooter>
            <Button variant="outline" className="w-full">Submit Feedback</Button>
        </CardFooter>
      </Card>
    </div>
  );
}
