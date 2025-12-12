import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool } from "@neondatabase/serverless";
import { benchmarkResults, systemConfig } from "@shared/schema";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

async function seed() {
  console.log("Seeding database...");
  
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
  
  console.log(`Seeded ${results.length} benchmark results`);
  console.log("Seeding complete!");
  
  await pool.end();
}

seed().catch(console.error);
