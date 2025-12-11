import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { liveMetrics } from "@/lib/mockData";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Clock, Zap, Activity, Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export default function Dashboard() {
  const agoraData = liveMetrics.filter(d => d.provider === "Agora ConvoAI");
  const liveKitData = liveMetrics.filter(d => d.provider === "LiveKIT Agent");
  
  // Combine for charts
  const combinedData = agoraData.map((d, i) => ({
    timestamp: d.timestamp,
    agoraResponse: d.responseLatency,
    agoraInterrupt: d.interruptLatency,
    liveKitResponse: liveKitData[i]?.responseLatency,
    liveKitInterrupt: liveKitData[i]?.interruptLatency,
  }));

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Real-time</h1>
        <p className="text-muted-foreground flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
          </span>
          System Status: Operational • Updating every 8 hours • Latest test happened 3 minutes ago
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Response Latency</CardTitle>
            <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <Popover>
                    <PopoverTrigger asChild>
                        <Info className="h-3 w-3 text-muted-foreground cursor-pointer hover:text-foreground transition-colors" />
                    </PopoverTrigger>
                    <PopoverContent className="w-80">
                        <div className="space-y-2">
                            <h4 className="font-medium leading-none">Latency Metrics</h4>
                            <p className="text-sm text-muted-foreground">
                                <strong>Response Latency:</strong> Time from user speech end to first audio packet received.
                            </p>
                            <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
                                <p><strong>MED (Median):</strong> The middle value separating the higher half from the lower half of data samples.</p>
                                <p><strong>SD (Standard Deviation):</strong> A measure of the amount of variation or dispersion of the latency values.</p>
                            </div>
                        </div>
                    </PopoverContent>
                </Popover>
            </div>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex justify-between items-baseline">
                <span className="text-sm text-muted-foreground font-mono">MED</span>
                <span className="text-2xl font-bold font-mono">1,200ms</span>
            </div>
            <div className="flex justify-between items-baseline">
                <span className="text-sm text-muted-foreground font-mono">SD</span>
                <span className="text-lg font-mono text-muted-foreground">180ms</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Interrupt Latency</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex justify-between items-baseline">
                <span className="text-sm text-muted-foreground font-mono">MED</span>
                <span className="text-2xl font-bold font-mono">480ms</span>
            </div>
            <div className="flex justify-between items-baseline">
                <span className="text-sm text-muted-foreground font-mono">SD</span>
                <span className="text-lg font-mono text-muted-foreground">200ms</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Tests Run</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono mt-2">1,284</div>
            <p className="text-xs text-muted-foreground">Last 24 hours</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Response Latency (ms)</CardTitle>
            <CardDescription>Time to First Audio (TTFA)</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={combinedData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis 
                    dataKey="timestamp" 
                    stroke="hsl(var(--muted-foreground))" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false} 
                  />
                  <YAxis 
                    stroke="hsl(var(--muted-foreground))" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false} 
                    tickFormatter={(value) => `${value}ms`} 
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                    itemStyle={{ color: 'hsl(var(--popover-foreground))' }}
                  />
                  <Legend />
                  <Line 
                    type="monotone" 
                    dataKey="agoraResponse" 
                    name="Agora ConvoAI" 
                    stroke="hsl(var(--chart-1))" 
                    strokeWidth={2} 
                    dot={false}
                    activeDot={{ r: 6 }} 
                  />
                  <Line 
                    type="monotone" 
                    dataKey="liveKitResponse" 
                    name="LiveKIT Agent" 
                    stroke="hsl(var(--chart-2))" 
                    strokeWidth={2} 
                    dot={false} 
                    activeDot={{ r: 6 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Interrupt Latency (ms)</CardTitle>
            <CardDescription>Time to stop generation after user speech</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={combinedData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis 
                    dataKey="timestamp" 
                    stroke="hsl(var(--muted-foreground))" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false} 
                  />
                  <YAxis 
                    stroke="hsl(var(--muted-foreground))" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false} 
                    tickFormatter={(value) => `${value}ms`} 
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                    itemStyle={{ color: 'hsl(var(--popover-foreground))' }}
                  />
                  <Legend />
                  <Line 
                    type="monotone" 
                    dataKey="agoraInterrupt" 
                    name="Agora ConvoAI" 
                    stroke="hsl(var(--chart-1))" 
                    strokeWidth={2} 
                    dot={false}
                    activeDot={{ r: 6 }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="liveKitInterrupt" 
                    name="LiveKIT Agent" 
                    stroke="hsl(var(--chart-2))" 
                    strokeWidth={2} 
                    dot={false}
                    activeDot={{ r: 6 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
