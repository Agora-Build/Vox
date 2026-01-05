import { 
  type User, 
  type InsertUser, 
  type BenchmarkResult, 
  type InsertBenchmarkResult,
  type SystemConfig,
  type InsertSystemConfig,
  type Workflow,
  type InsertWorkflow,
  type TestSet,
  type InsertTestSet,
  users,
  benchmarkResults,
  systemConfig,
  workflows,
  testSets,
  emailVerificationTokens,
  inviteTokens,
  activationTokens,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import { desc, eq, and, or, isNull } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, data: Partial<User>): Promise<User | undefined>;
  getAllUsers(): Promise<User[]>;
  
  getBenchmarkResults(limit?: number): Promise<BenchmarkResult[]>;
  getMainlineBenchmarkResults(limit?: number): Promise<BenchmarkResult[]>;
  getLeaderboardData(): Promise<BenchmarkResult[]>;
  createBenchmarkResult(result: InsertBenchmarkResult): Promise<BenchmarkResult>;
  
  getConfig(key: string): Promise<SystemConfig | undefined>;
  getAllConfig(): Promise<SystemConfig[]>;
  setConfig(config: InsertSystemConfig): Promise<SystemConfig>;
  
  createWorkflow(workflow: InsertWorkflow): Promise<Workflow>;
  getWorkflow(id: number): Promise<Workflow | undefined>;
  getWorkflows(userId?: string): Promise<Workflow[]>;
  updateWorkflow(id: number, data: Partial<Workflow>): Promise<Workflow | undefined>;
  
  createTestSet(testSet: InsertTestSet): Promise<TestSet>;
  getTestSet(id: number): Promise<TestSet | undefined>;
  getTestSets(userId?: string): Promise<TestSet[]>;
  updateTestSet(id: number, data: Partial<TestSet>): Promise<TestSet | undefined>;
  
  createEmailVerificationToken(userId: string, token: string, expiresAt: Date): Promise<void>;
  getEmailVerificationToken(token: string): Promise<{ userId: string; expiresAt: Date } | undefined>;
  deleteEmailVerificationToken(token: string): Promise<void>;
  
  createInviteToken(email: string, plan: string, isAdmin: boolean, token: string, createdBy: string | null, expiresAt: Date): Promise<void>;
  getInviteToken(token: string): Promise<{ email: string; plan: string; isAdmin: boolean; expiresAt: Date; usedAt: Date | null } | undefined>;
  markInviteTokenUsed(token: string): Promise<void>;
  
  createActivationToken(userId: string, token: string, expiresAt: Date): Promise<void>;
  getActivationToken(token: string): Promise<{ userId: string; expiresAt: Date; usedAt: Date | null } | undefined>;
  markActivationTokenUsed(token: string): Promise<void>;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool);

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.username, username));
    return result[0];
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.email, email));
    return result[0];
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const result = await db.insert(users).values(insertUser).returning();
    return result[0];
  }

  async updateUser(id: string, data: Partial<User>): Promise<User | undefined> {
    const result = await db.update(users).set(data).where(eq(users.id, id)).returning();
    return result[0];
  }

  async getAllUsers(): Promise<User[]> {
    return db.select().from(users).orderBy(desc(users.createdAt));
  }

  async getBenchmarkResults(limit: number = 50): Promise<BenchmarkResult[]> {
    return db.select().from(benchmarkResults).orderBy(desc(benchmarkResults.timestamp)).limit(limit);
  }

  async getMainlineBenchmarkResults(limit: number = 50): Promise<BenchmarkResult[]> {
    return db.select()
      .from(benchmarkResults)
      .leftJoin(workflows, eq(benchmarkResults.workflowId, workflows.id))
      .where(or(isNull(benchmarkResults.workflowId), eq(workflows.isMainline, true)))
      .orderBy(desc(benchmarkResults.timestamp))
      .limit(limit)
      .then(rows => rows.map(r => r.benchmark_results));
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

  async createWorkflow(workflow: InsertWorkflow): Promise<Workflow> {
    const result = await db.insert(workflows).values(workflow).returning();
    return result[0];
  }

  async getWorkflow(id: number): Promise<Workflow | undefined> {
    const result = await db.select().from(workflows).where(eq(workflows.id, id));
    return result[0];
  }

  async getWorkflows(userId?: string): Promise<Workflow[]> {
    if (userId) {
      return db.select().from(workflows).where(
        or(eq(workflows.ownerId, userId), eq(workflows.visibility, "public"))
      ).orderBy(desc(workflows.createdAt));
    }
    return db.select().from(workflows).where(eq(workflows.visibility, "public")).orderBy(desc(workflows.createdAt));
  }

  async updateWorkflow(id: number, data: Partial<Workflow>): Promise<Workflow | undefined> {
    const result = await db.update(workflows).set({ ...data, updatedAt: new Date() }).where(eq(workflows.id, id)).returning();
    return result[0];
  }

  async createTestSet(testSet: InsertTestSet): Promise<TestSet> {
    const result = await db.insert(testSets).values(testSet).returning();
    return result[0];
  }

  async getTestSet(id: number): Promise<TestSet | undefined> {
    const result = await db.select().from(testSets).where(eq(testSets.id, id));
    return result[0];
  }

  async getTestSets(userId?: string): Promise<TestSet[]> {
    if (userId) {
      return db.select().from(testSets).where(
        or(eq(testSets.ownerId, userId), eq(testSets.visibility, "public"))
      ).orderBy(desc(testSets.createdAt));
    }
    return db.select().from(testSets).where(eq(testSets.visibility, "public")).orderBy(desc(testSets.createdAt));
  }

  async updateTestSet(id: number, data: Partial<TestSet>): Promise<TestSet | undefined> {
    const result = await db.update(testSets).set({ ...data, updatedAt: new Date() }).where(eq(testSets.id, id)).returning();
    return result[0];
  }

  async createEmailVerificationToken(userId: string, token: string, expiresAt: Date): Promise<void> {
    await db.insert(emailVerificationTokens).values({ userId, token, expiresAt });
  }

  async getEmailVerificationToken(token: string): Promise<{ userId: string; expiresAt: Date } | undefined> {
    const result = await db.select().from(emailVerificationTokens).where(eq(emailVerificationTokens.token, token));
    if (result[0]) {
      return { userId: result[0].userId, expiresAt: result[0].expiresAt };
    }
    return undefined;
  }

  async deleteEmailVerificationToken(token: string): Promise<void> {
    await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.token, token));
  }

  async createInviteToken(email: string, plan: string, isAdmin: boolean, token: string, createdBy: string | null, expiresAt: Date): Promise<void> {
    await db.insert(inviteTokens).values({ 
      email, 
      plan: plan as "basic" | "premium" | "principal", 
      isAdmin, 
      token, 
      createdBy, 
      expiresAt 
    });
  }

  async getInviteToken(token: string): Promise<{ email: string; plan: string; isAdmin: boolean; expiresAt: Date; usedAt: Date | null } | undefined> {
    const result = await db.select().from(inviteTokens).where(eq(inviteTokens.token, token));
    if (result[0]) {
      return { 
        email: result[0].email, 
        plan: result[0].plan, 
        isAdmin: result[0].isAdmin, 
        expiresAt: result[0].expiresAt,
        usedAt: result[0].usedAt,
      };
    }
    return undefined;
  }

  async markInviteTokenUsed(token: string): Promise<void> {
    await db.update(inviteTokens).set({ usedAt: new Date() }).where(eq(inviteTokens.token, token));
  }

  async createActivationToken(userId: string, token: string, expiresAt: Date): Promise<void> {
    await db.insert(activationTokens).values({ userId, token, expiresAt });
  }

  async getActivationToken(token: string): Promise<{ userId: string; expiresAt: Date; usedAt: Date | null } | undefined> {
    const result = await db.select().from(activationTokens).where(eq(activationTokens.token, token));
    if (result[0]) {
      return { userId: result[0].userId, expiresAt: result[0].expiresAt, usedAt: result[0].usedAt };
    }
    return undefined;
  }

  async markActivationTokenUsed(token: string): Promise<void> {
    await db.update(activationTokens).set({ usedAt: new Date() }).where(eq(activationTokens.token, token));
  }
}

export const storage = new DatabaseStorage();
