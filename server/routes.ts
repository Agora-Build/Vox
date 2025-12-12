import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import { benchmarkResults, systemConfig } from "@shared/schema";
import { count } from "drizzle-orm";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.get("/api/metrics/realtime", async (req, res) => {
    try {
      const results = await storage.getBenchmarkResults(50);
      res.json(results);
    } catch (error) {
      console.error("Error fetching realtime metrics:", error);
      res.status(500).json({ error: "Failed to fetch metrics" });
    }
  });

  app.get("/api/metrics/leaderboard", async (req, res) => {
    try {
      const results = await storage.getLeaderboardData();
      
      const providerRegionMap = new Map<string, { 
        provider: string; 
        region: string; 
        responseLatencies: number[]; 
        interruptLatencies: number[];
        networkResiliences: number[];
        naturalnesses: number[];
        noiseReductions: number[];
      }>();
      
      for (const result of results) {
        const key = `${result.provider}-${result.region}`;
        if (!providerRegionMap.has(key)) {
          providerRegionMap.set(key, {
            provider: result.provider,
            region: result.region,
            responseLatencies: [],
            interruptLatencies: [],
            networkResiliences: [],
            naturalnesses: [],
            noiseReductions: [],
          });
        }
        const group = providerRegionMap.get(key)!;
        group.responseLatencies.push(result.responseLatency);
        group.interruptLatencies.push(result.interruptLatency);
        group.networkResiliences.push(result.networkResilience);
        group.naturalnesses.push(result.naturalness);
        group.noiseReductions.push(result.noiseReduction);
      }
      
      const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      
      const leaderboard = Array.from(providerRegionMap.values())
        .map((group) => ({
          provider: group.provider,
          region: group.region,
          responseLatency: Math.round(avg(group.responseLatencies)),
          interruptLatency: Math.round(avg(group.interruptLatencies)),
          networkResilience: Math.round(avg(group.networkResiliences)),
          naturalness: Math.round(avg(group.naturalnesses) * 10) / 10,
          noiseReduction: Math.round(avg(group.noiseReductions)),
        }))
        .sort((a, b) => a.responseLatency - b.responseLatency)
        .map((entry, index) => ({
          rank: index + 1,
          ...entry,
        }));
      
      res.json(leaderboard);
    } catch (error) {
      console.error("Error fetching leaderboard:", error);
      res.status(500).json({ error: "Failed to fetch leaderboard" });
    }
  });

  app.get("/api/config", async (req, res) => {
    try {
      const configs = await storage.getAllConfig();
      const configObject: Record<string, string> = {};
      for (const config of configs) {
        configObject[config.key] = config.value;
      }
      res.json(configObject);
    } catch (error) {
      console.error("Error fetching config:", error);
      res.status(500).json({ error: "Failed to fetch config" });
    }
  });

  app.post("/api/seed", async (req, res) => {
    try {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      const db = drizzle(pool);
      
      const existingCount = await db.select({ count: count() }).from(benchmarkResults);
      if (existingCount[0].count > 0) {
        res.json({ message: "Database already seeded", count: existingCount[0].count });
        return;
      }
      
      await db.insert(systemConfig).values([
        { key: "test_interval_hours", value: "8" },
        { key: "total_tests_24h", value: "1284" },
      ]).onConflictDoNothing();
      
      const providers = ["Agora ConvoAI", "LiveKIT Agent"];
      const regions = ["North America (East)", "Europe (Frankfurt)", "Asia (Singapore)"];
      
      const baseMetrics: Record<string, Record<string, { response: number; interrupt: number; network: number; natural: number; noise: number }>> = {
        "Agora ConvoAI": {
          "North America (East)": { response: 1180, interrupt: 450, network: 98, natural: 4.8, noise: 95 },
          "Europe (Frankfurt)": { response: 1250, interrupt: 510, network: 97, natural: 4.8, noise: 94 },
          "Asia (Singapore)": { response: 1350, interrupt: 580, network: 95, natural: 4.7, noise: 93 },
        },
        "LiveKIT Agent": {
          "North America (East)": { response: 1220, interrupt: 490, network: 96, natural: 4.7, noise: 92 },
          "Europe (Frankfurt)": { response: 1300, interrupt: 540, network: 94, natural: 4.6, noise: 90 },
          "Asia (Singapore)": { response: 1420, interrupt: 620, network: 92, natural: 4.5, noise: 89 },
        },
      };
      
      const now = new Date();
      const results = [];
      
      for (let hoursAgo = 24; hoursAgo >= 0; hoursAgo -= 1) {
        const timestamp = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
        
        for (const provider of providers) {
          for (const region of regions) {
            const base = baseMetrics[provider][region];
            const variation = () => (Math.random() - 0.5) * 0.1;
            
            results.push({
              provider,
              region,
              responseLatency: Math.round(base.response * (1 + variation())),
              interruptLatency: Math.round(base.interrupt * (1 + variation())),
              networkResilience: Math.round(base.network * (1 + variation() * 0.5)),
              naturalness: Math.round((base.natural * (1 + variation() * 0.2)) * 10) / 10,
              noiseReduction: Math.round(base.noise * (1 + variation() * 0.5)),
              timestamp,
            });
          }
        }
      }
      
      await db.insert(benchmarkResults).values(results);
      
      res.json({ message: "Database seeded successfully", count: results.length });
    } catch (error) {
      console.error("Error seeding database:", error);
      res.status(500).json({ error: "Failed to seed database" });
    }
  });

  return httpServer;
}
