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
  type Vendor,
  type InsertVendor,
  type TestCase,
  type InsertTestCase,
  type WorkerToken,
  type InsertWorkerToken,
  type Worker,
  type InsertWorker,
  type Job,
  type InsertJob,
  users,
  benchmarkResults,
  systemConfig,
  workflows,
  testSets,
  emailVerificationTokens,
  inviteTokens,
  activationTokens,
  vendors,
  testCases,
  workerTokens,
  workers,
  jobs,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import { desc, eq, and, or, isNull, lt } from "drizzle-orm";

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
  
  // Vendor methods
  createVendor(vendor: InsertVendor): Promise<Vendor>;
  getVendor(id: number): Promise<Vendor | undefined>;
  getVendorsByWorkflow(workflowId: number): Promise<Vendor[]>;
  updateVendor(id: number, data: Partial<Vendor>): Promise<Vendor | undefined>;
  deleteVendor(id: number): Promise<void>;
  
  // Test case methods
  createTestCase(testCase: InsertTestCase): Promise<TestCase>;
  getTestCase(id: number): Promise<TestCase | undefined>;
  getTestCasesByWorkflow(workflowId: number): Promise<TestCase[]>;
  getTestCasesByRegion(region: string): Promise<TestCase[]>;
  updateTestCase(id: number, data: Partial<TestCase>): Promise<TestCase | undefined>;
  deleteTestCase(id: number): Promise<void>;
  
  // Worker token methods
  createWorkerToken(workerToken: InsertWorkerToken): Promise<WorkerToken>;
  getWorkerToken(id: number): Promise<WorkerToken | undefined>;
  getWorkerTokenByToken(token: string): Promise<WorkerToken | undefined>;
  getAllWorkerTokens(): Promise<WorkerToken[]>;
  revokeWorkerToken(id: number): Promise<void>;
  updateWorkerTokenLastUsed(id: number): Promise<void>;
  
  // Worker methods
  createWorker(worker: InsertWorker): Promise<Worker>;
  getWorker(id: number): Promise<Worker | undefined>;
  getWorkersByRegion(region: string): Promise<Worker[]>;
  getAllWorkers(): Promise<Worker[]>;
  updateWorker(id: number, data: Partial<Worker>): Promise<Worker | undefined>;
  updateWorkerHeartbeat(id: number): Promise<void>;
  
  // Job methods
  createJob(job: InsertJob): Promise<Job>;
  getJob(id: number): Promise<Job | undefined>;
  getPendingJobsByRegion(region: string): Promise<Job[]>;
  getJobsByWorker(workerId: number): Promise<Job[]>;
  updateJob(id: number, data: Partial<Job>): Promise<Job | undefined>;
  claimJob(jobId: number, workerId: number): Promise<Job | undefined>;
  completeJob(jobId: number, error?: string): Promise<Job | undefined>;
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

  // Vendor methods
  async createVendor(vendor: InsertVendor): Promise<Vendor> {
    const result = await db.insert(vendors).values(vendor).returning();
    return result[0];
  }

  async getVendor(id: number): Promise<Vendor | undefined> {
    const result = await db.select().from(vendors).where(eq(vendors.id, id));
    return result[0];
  }

  async getVendorsByWorkflow(workflowId: number): Promise<Vendor[]> {
    return db.select().from(vendors).where(eq(vendors.workflowId, workflowId)).orderBy(desc(vendors.createdAt));
  }

  async updateVendor(id: number, data: Partial<Vendor>): Promise<Vendor | undefined> {
    const result = await db.update(vendors).set({ ...data, updatedAt: new Date() }).where(eq(vendors.id, id)).returning();
    return result[0];
  }

  async deleteVendor(id: number): Promise<void> {
    await db.delete(vendors).where(eq(vendors.id, id));
  }

  // Test case methods
  async createTestCase(testCase: InsertTestCase): Promise<TestCase> {
    const result = await db.insert(testCases).values(testCase).returning();
    return result[0];
  }

  async getTestCase(id: number): Promise<TestCase | undefined> {
    const result = await db.select().from(testCases).where(eq(testCases.id, id));
    return result[0];
  }

  async getTestCasesByWorkflow(workflowId: number): Promise<TestCase[]> {
    return db.select().from(testCases).where(eq(testCases.workflowId, workflowId)).orderBy(desc(testCases.createdAt));
  }

  async getTestCasesByRegion(region: string): Promise<TestCase[]> {
    return db.select().from(testCases).where(
      and(eq(testCases.region, region as "na" | "apac" | "eu"), eq(testCases.isEnabled, true))
    ).orderBy(desc(testCases.createdAt));
  }

  async updateTestCase(id: number, data: Partial<TestCase>): Promise<TestCase | undefined> {
    const result = await db.update(testCases).set({ ...data, updatedAt: new Date() }).where(eq(testCases.id, id)).returning();
    return result[0];
  }

  async deleteTestCase(id: number): Promise<void> {
    await db.delete(testCases).where(eq(testCases.id, id));
  }

  // Worker token methods
  async createWorkerToken(workerToken: InsertWorkerToken): Promise<WorkerToken> {
    const result = await db.insert(workerTokens).values(workerToken).returning();
    return result[0];
  }

  async getWorkerToken(id: number): Promise<WorkerToken | undefined> {
    const result = await db.select().from(workerTokens).where(eq(workerTokens.id, id));
    return result[0];
  }

  async getWorkerTokenByToken(token: string): Promise<WorkerToken | undefined> {
    const result = await db.select().from(workerTokens).where(eq(workerTokens.token, token));
    return result[0];
  }

  async getAllWorkerTokens(): Promise<WorkerToken[]> {
    return db.select().from(workerTokens).orderBy(desc(workerTokens.createdAt));
  }

  async revokeWorkerToken(id: number): Promise<void> {
    await db.update(workerTokens).set({ isRevoked: true }).where(eq(workerTokens.id, id));
  }

  async updateWorkerTokenLastUsed(id: number): Promise<void> {
    await db.update(workerTokens).set({ lastUsedAt: new Date() }).where(eq(workerTokens.id, id));
  }

  // Worker methods
  async createWorker(worker: InsertWorker): Promise<Worker> {
    const result = await db.insert(workers).values(worker).returning();
    return result[0];
  }

  async getWorker(id: number): Promise<Worker | undefined> {
    const result = await db.select().from(workers).where(eq(workers.id, id));
    return result[0];
  }

  async getWorkersByRegion(region: string): Promise<Worker[]> {
    return db.select().from(workers).where(eq(workers.region, region as "na" | "apac" | "eu")).orderBy(desc(workers.createdAt));
  }

  async getAllWorkers(): Promise<Worker[]> {
    return db.select().from(workers).orderBy(desc(workers.createdAt));
  }

  async updateWorker(id: number, data: Partial<Worker>): Promise<Worker | undefined> {
    const result = await db.update(workers).set(data).where(eq(workers.id, id)).returning();
    return result[0];
  }

  async updateWorkerHeartbeat(id: number): Promise<void> {
    await db.update(workers).set({ lastHeartbeat: new Date(), status: "online" }).where(eq(workers.id, id));
  }

  // Job methods
  async createJob(job: InsertJob): Promise<Job> {
    const result = await db.insert(jobs).values(job).returning();
    return result[0];
  }

  async getJob(id: number): Promise<Job | undefined> {
    const result = await db.select().from(jobs).where(eq(jobs.id, id));
    return result[0];
  }

  async getPendingJobsByRegion(region: string): Promise<Job[]> {
    return db.select().from(jobs).where(
      and(eq(jobs.region, region as "na" | "apac" | "eu"), eq(jobs.status, "pending"))
    ).orderBy(jobs.createdAt);
  }

  async getJobsByWorker(workerId: number): Promise<Job[]> {
    return db.select().from(jobs).where(eq(jobs.workerId, workerId)).orderBy(desc(jobs.createdAt));
  }

  async updateJob(id: number, data: Partial<Job>): Promise<Job | undefined> {
    const result = await db.update(jobs).set(data).where(eq(jobs.id, id)).returning();
    return result[0];
  }

  async claimJob(jobId: number, workerId: number): Promise<Job | undefined> {
    const result = await db.update(jobs)
      .set({ workerId, status: "running", startedAt: new Date() })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "pending")))
      .returning();
    return result[0];
  }

  async completeJob(jobId: number, error?: string): Promise<Job | undefined> {
    const result = await db.update(jobs)
      .set({ 
        status: error ? "failed" : "completed", 
        completedAt: new Date(),
        error: error || null,
      })
      .where(eq(jobs.id, jobId))
      .returning();
    return result[0];
  }
}

export const storage = new DatabaseStorage();
