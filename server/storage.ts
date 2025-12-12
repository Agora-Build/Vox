import { 
  type User, 
  type InsertUser, 
  type BenchmarkResult, 
  type InsertBenchmarkResult,
  type SystemConfig,
  type InsertSystemConfig,
  users,
  benchmarkResults,
  systemConfig
} from "@shared/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import { desc, eq } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  getBenchmarkResults(limit?: number): Promise<BenchmarkResult[]>;
  getLeaderboardData(): Promise<BenchmarkResult[]>;
  createBenchmarkResult(result: InsertBenchmarkResult): Promise<BenchmarkResult>;
  
  getConfig(key: string): Promise<SystemConfig | undefined>;
  getAllConfig(): Promise<SystemConfig[]>;
  setConfig(config: InsertSystemConfig): Promise<SystemConfig>;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.username, username));
    return result[0];
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const result = await db.insert(users).values(insertUser).returning();
    return result[0];
  }

  async getBenchmarkResults(limit: number = 50): Promise<BenchmarkResult[]> {
    return db.select().from(benchmarkResults).orderBy(desc(benchmarkResults.timestamp)).limit(limit);
  }

  async getLeaderboardData(): Promise<BenchmarkResult[]> {
    return db.select().from(benchmarkResults).orderBy(desc(benchmarkResults.timestamp));
  }

  async createBenchmarkResult(result: InsertBenchmarkResult): Promise<BenchmarkResult> {
    const inserted = await db.insert(benchmarkResults).values(result).returning();
    return inserted[0];
  }

  async getConfig(key: string): Promise<SystemConfig | undefined> {
    const result = await db.select().from(systemConfig).where(eq(systemConfig.key, key));
    return result[0];
  }

  async getAllConfig(): Promise<SystemConfig[]> {
    return db.select().from(systemConfig);
  }

  async setConfig(config: InsertSystemConfig): Promise<SystemConfig> {
    const existing = await this.getConfig(config.key);
    if (existing) {
      const updated = await db.update(systemConfig).set({ value: config.value }).where(eq(systemConfig.key, config.key)).returning();
      return updated[0];
    }
    const inserted = await db.insert(systemConfig).values(config).returning();
    return inserted[0];
  }
}

export const storage = new DatabaseStorage();
