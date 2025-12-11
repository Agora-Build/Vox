import { addHours, subHours, format } from "date-fns";

export interface MetricPoint {
  timestamp: string;
  provider: "Agora ConvoAI" | "LiveKIT Agent";
  responseLatency: number; // ms
  interruptLatency: number; // ms
}

export interface LeaderboardEntry {
  rank: number;
  provider: string;
  region: string;
  responseLatency: number; // ms
  interruptLatency: number; // ms
  networkResilience: number; // score 0-100
  naturalness: number; // score 0-5
  noiseReduction: number; // score 0-100
}

const generateLiveMetrics = (): MetricPoint[] => {
  const data: MetricPoint[] = [];
  const now = new Date();
  
  // Generate 24 hours of data points (every 8 hours per request, but let's show hourly for chart smoothness)
  for (let i = 24; i >= 0; i--) {
    const time = subHours(now, i);
    
    // Agora Mock Data 
    // Response Latency: MED ~1200ms
    // Interrupt Latency: MED ~480ms
    data.push({
      timestamp: format(time, "HH:mm"),
      provider: "Agora ConvoAI",
      responseLatency: 1200 + (Math.random() - 0.5) * 360, // 1200 +/- 180 (approx SD range)
      interruptLatency: 480 + (Math.random() - 0.5) * 400, // 480 +/- 200 (approx SD range)
    });

    // LiveKIT Mock Data
    data.push({
      timestamp: format(time, "HH:mm"),
      provider: "LiveKIT Agent",
      responseLatency: 1250 + (Math.random() - 0.5) * 400,
      interruptLatency: 520 + (Math.random() - 0.5) * 450,
    });
  }
  return data;
};

export const liveMetrics = generateLiveMetrics();

export const leaderboardData: LeaderboardEntry[] = [
  {
    rank: 1,
    provider: "Agora ConvoAI",
    region: "North America (East)",
    responseLatency: 1180,
    interruptLatency: 450,
    networkResilience: 98,
    naturalness: 4.8,
    noiseReduction: 95,
  },
  {
    rank: 2,
    provider: "LiveKIT Agent",
    region: "North America (East)",
    responseLatency: 1220,
    interruptLatency: 490,
    networkResilience: 96,
    naturalness: 4.7,
    noiseReduction: 92,
  },
  {
    rank: 3,
    provider: "Agora ConvoAI",
    region: "Europe (Frankfurt)",
    responseLatency: 1250,
    interruptLatency: 510,
    networkResilience: 97,
    naturalness: 4.8,
    noiseReduction: 94,
  },
  {
    rank: 4,
    provider: "LiveKIT Agent",
    region: "Europe (Frankfurt)",
    responseLatency: 1300,
    interruptLatency: 540,
    networkResilience: 94,
    naturalness: 4.6,
    noiseReduction: 90,
  },
  {
    rank: 5,
    provider: "Agora ConvoAI",
    region: "Asia (Singapore)",
    responseLatency: 1350,
    interruptLatency: 580,
    networkResilience: 95,
    naturalness: 4.7,
    noiseReduction: 93,
  },
  {
    rank: 6,
    provider: "LiveKIT Agent",
    region: "Asia (Singapore)",
    responseLatency: 1420,
    interruptLatency: 620,
    networkResilience: 92,
    naturalness: 4.5,
    noiseReduction: 89,
  },
];
