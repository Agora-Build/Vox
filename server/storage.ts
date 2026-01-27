import {
  type User,
  type InsertUser,
  type Organization,
  type InsertOrganization,
  type Provider,
  type InsertProvider,
  generateProviderId,
  type Project,
  type InsertProject,
  type Workflow,
  type InsertWorkflow,
  type EvalSet,
  type InsertEvalSet,
  type EvalAgentToken,
  type InsertEvalAgentToken,
  type EvalAgent,
  type InsertEvalAgent,
  type EvalSchedule,
  type InsertEvalSchedule,
  type EvalJob,
  type InsertEvalJob,
  type EvalResult,
  type InsertEvalResult,
  type ApiKey,
  type InsertApiKey,
  type PricingConfig,
  type InsertPricingConfig,
  type PaymentMethod,
  type InsertPaymentMethod,
  type PaymentHistory,
  type InsertPaymentHistory,
  type OrganizationSeat,
  type InsertOrganizationSeat,
  type SystemConfig,
  type InsertSystemConfig,
  type FundReturnRequest,
  type InsertFundReturnRequest,
  users,
  organizations,
  providers,
  projects,
  workflows,
  evalSets,
  evalAgentTokens,
  evalAgents,
  evalSchedules,
  evalJobs,
  evalResults,
  apiKeys,
  pricingConfig,
  paymentMethods,
  paymentHistories,
  organizationSeats,
  activationTokens,
  inviteTokens,
  systemConfig,
  fundReturnRequests,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import { desc, eq, and, sql } from "drizzle-orm";
import crypto from "crypto";

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateSecureToken(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

// Helper to convert snake_case SQL results to camelCase for type safety
function snakeToCamel(row: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key in row) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    result[camelKey] = row[key];
  }
  return result;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool);
export { pool };

export class DatabaseStorage {
  async getUser(id: number): Promise<User | undefined> {
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

  async getUserByGoogleId(googleId: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.googleId, googleId));
    return result[0];
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const result = await db.insert(users).values(insertUser).returning();
    return result[0];
  }

  async updateUser(id: number, data: Partial<User>): Promise<User | undefined> {
    const result = await db.update(users).set({ ...data, updatedAt: new Date() }).where(eq(users.id, id)).returning();
    return result[0];
  }

  async getAllUsers(): Promise<User[]> {
    return db.select().from(users).orderBy(desc(users.createdAt));
  }

  async getUsersByOrganization(organizationId: number): Promise<User[]> {
    return db.select().from(users).where(eq(users.organizationId, organizationId)).orderBy(desc(users.createdAt));
  }

  async createOrganization(org: InsertOrganization): Promise<Organization> {
    const result = await db.insert(organizations).values(org).returning();
    return result[0];
  }

  async getOrganization(id: number): Promise<Organization | undefined> {
    const result = await db.select().from(organizations).where(eq(organizations.id, id));
    return result[0];
  }

  async updateOrganization(id: number, data: Partial<Organization>): Promise<Organization | undefined> {
    const result = await db.update(organizations).set({ ...data, updatedAt: new Date() }).where(eq(organizations.id, id)).returning();
    return result[0];
  }

  async getAllOrganizations(): Promise<Organization[]> {
    return db.select().from(organizations).orderBy(desc(organizations.createdAt));
  }

  async createProvider(provider: Omit<InsertProvider, 'id'>): Promise<Provider> {
    const id = generateProviderId();
    const result = await db.insert(providers).values({ ...provider, id }).returning();
    return result[0];
  }

  async getProvider(id: string): Promise<Provider | undefined> {
    const result = await db.select().from(providers).where(eq(providers.id, id));
    return result[0];
  }

  async getAllProviders(): Promise<Provider[]> {
    return db.select().from(providers).where(eq(providers.isActive, true)).orderBy(desc(providers.createdAt));
  }

  async updateProvider(id: string, data: Partial<Provider>): Promise<Provider | undefined> {
    const result = await db.update(providers).set({ ...data, updatedAt: new Date() }).where(eq(providers.id, id)).returning();
    return result[0];
  }

  async createProject(project: InsertProject): Promise<Project> {
    const result = await db.insert(projects).values(project).returning();
    return result[0];
  }

  async getProject(id: number): Promise<Project | undefined> {
    const result = await db.select().from(projects).where(eq(projects.id, id));
    return result[0];
  }

  async getProjectsByOwner(ownerId: number): Promise<Project[]> {
    return db.select().from(projects).where(eq(projects.ownerId, ownerId)).orderBy(desc(projects.createdAt));
  }

  async getProjectsByOrganization(organizationId: number): Promise<Project[]> {
    return db.select().from(projects).where(eq(projects.organizationId, organizationId)).orderBy(desc(projects.createdAt));
  }

  async updateProject(id: number, data: Partial<Project>): Promise<Project | undefined> {
    const result = await db.update(projects).set({ ...data, updatedAt: new Date() }).where(eq(projects.id, id)).returning();
    return result[0];
  }

  async deleteProject(id: number): Promise<void> {
    await db.delete(projects).where(eq(projects.id, id));
  }

  async countProjectsByOwner(ownerId: number): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)` }).from(projects).where(eq(projects.ownerId, ownerId));
    return Number(result[0]?.count || 0);
  }

  async createWorkflow(workflow: InsertWorkflow): Promise<Workflow> {
    const result = await db.insert(workflows).values(workflow).returning();
    return result[0];
  }

  async getWorkflow(id: number): Promise<Workflow | undefined> {
    const result = await db.select().from(workflows).where(eq(workflows.id, id));
    return result[0];
  }

  async getWorkflowsByOwner(ownerId: number): Promise<Workflow[]> {
    return db.select().from(workflows).where(eq(workflows.ownerId, ownerId)).orderBy(desc(workflows.createdAt));
  }

  async getWorkflowsByProject(projectId: number): Promise<Workflow[]> {
    return db.select().from(workflows).where(eq(workflows.projectId, projectId)).orderBy(desc(workflows.createdAt));
  }

  async getPublicWorkflows(): Promise<Workflow[]> {
    return db.select().from(workflows).where(eq(workflows.visibility, "public")).orderBy(desc(workflows.createdAt));
  }

  async getMainlineWorkflows(): Promise<Workflow[]> {
    return db.select().from(workflows).where(eq(workflows.isMainline, true)).orderBy(desc(workflows.createdAt));
  }

  async updateWorkflow(id: number, data: Partial<Workflow>): Promise<Workflow | undefined> {
    const result = await db.update(workflows).set({ ...data, updatedAt: new Date() }).where(eq(workflows.id, id)).returning();
    return result[0];
  }

  async deleteWorkflow(id: number): Promise<void> {
    await db.delete(workflows).where(eq(workflows.id, id));
  }

  async countWorkflowsByProject(projectId: number): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)` }).from(workflows).where(eq(workflows.projectId, projectId));
    return Number(result[0]?.count || 0);
  }

  async countWorkflowsByOwner(ownerId: number): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)` }).from(workflows).where(eq(workflows.ownerId, ownerId));
    return Number(result[0]?.count || 0);
  }

  async createEvalSet(evalSet: InsertEvalSet): Promise<EvalSet> {
    const result = await db.insert(evalSets).values(evalSet).returning();
    return result[0];
  }

  async getEvalSet(id: number): Promise<EvalSet | undefined> {
    const result = await db.select().from(evalSets).where(eq(evalSets.id, id));
    return result[0];
  }

  async getEvalSetsByOwner(ownerId: number): Promise<EvalSet[]> {
    return db.select().from(evalSets).where(eq(evalSets.ownerId, ownerId)).orderBy(desc(evalSets.createdAt));
  }

  async getPublicEvalSets(): Promise<EvalSet[]> {
    return db.select().from(evalSets).where(eq(evalSets.visibility, "public")).orderBy(desc(evalSets.createdAt));
  }

  async updateEvalSet(id: number, data: Partial<EvalSet>): Promise<EvalSet | undefined> {
    const result = await db.update(evalSets).set({ ...data, updatedAt: new Date() }).where(eq(evalSets.id, id)).returning();
    return result[0];
  }

  async deleteEvalSet(id: number): Promise<void> {
    await db.delete(evalSets).where(eq(evalSets.id, id));
  }

  async createEvalAgentToken(token: InsertEvalAgentToken): Promise<EvalAgentToken> {
    const result = await db.insert(evalAgentTokens).values(token).returning();
    return result[0];
  }

  async getEvalAgentToken(id: number): Promise<EvalAgentToken | undefined> {
    const result = await db.select().from(evalAgentTokens).where(eq(evalAgentTokens.id, id));
    return result[0];
  }

  async getEvalAgentTokenByHash(tokenHash: string): Promise<EvalAgentToken | undefined> {
    const result = await db.select().from(evalAgentTokens).where(eq(evalAgentTokens.tokenHash, tokenHash));
    return result[0];
  }

  async getAllEvalAgentTokens(): Promise<EvalAgentToken[]> {
    return db.select().from(evalAgentTokens).orderBy(desc(evalAgentTokens.createdAt));
  }

  async revokeEvalAgentToken(id: number): Promise<void> {
    await db.update(evalAgentTokens).set({ isRevoked: true }).where(eq(evalAgentTokens.id, id));
  }

  async updateEvalAgentTokenLastUsed(id: number): Promise<void> {
    await db.update(evalAgentTokens).set({ lastUsedAt: new Date() }).where(eq(evalAgentTokens.id, id));
  }

  async createEvalAgent(agent: InsertEvalAgent): Promise<EvalAgent> {
    const result = await db.insert(evalAgents).values(agent).returning();
    return result[0];
  }

  async getEvalAgent(id: number): Promise<EvalAgent | undefined> {
    const result = await db.select().from(evalAgents).where(eq(evalAgents.id, id));
    return result[0];
  }

  async getEvalAgentsByRegion(region: "na" | "apac" | "eu"): Promise<EvalAgent[]> {
    return db.select().from(evalAgents).where(eq(evalAgents.region, region)).orderBy(desc(evalAgents.createdAt));
  }

  async getAllEvalAgents(): Promise<EvalAgent[]> {
    return db.select().from(evalAgents).orderBy(desc(evalAgents.createdAt));
  }

  async updateEvalAgent(id: number, data: Partial<EvalAgent>): Promise<EvalAgent | undefined> {
    const result = await db.update(evalAgents).set({ ...data, updatedAt: new Date() }).where(eq(evalAgents.id, id)).returning();
    return result[0];
  }

  async updateEvalAgentHeartbeat(id: number): Promise<void> {
    await db.update(evalAgents).set({ lastSeenAt: new Date(), state: "idle", updatedAt: new Date() }).where(eq(evalAgents.id, id));
  }

  async createEvalJob(job: InsertEvalJob): Promise<EvalJob> {
    const result = await db.insert(evalJobs).values(job).returning();
    return result[0];
  }

  async getEvalJob(id: number): Promise<EvalJob | undefined> {
    const result = await db.select().from(evalJobs).where(eq(evalJobs.id, id));
    return result[0];
  }

  async getPendingEvalJobsByRegion(region: "na" | "apac" | "eu"): Promise<EvalJob[]> {
    return db.select().from(evalJobs).where(
      and(eq(evalJobs.region, region), eq(evalJobs.status, "pending"))
    ).orderBy(desc(evalJobs.priority), evalJobs.createdAt);
  }

  async getEvalJobsByAgent(agentId: number): Promise<EvalJob[]> {
    return db.select().from(evalJobs).where(eq(evalJobs.evalAgentId, agentId)).orderBy(desc(evalJobs.createdAt));
  }

  async updateEvalJob(id: number, data: Partial<EvalJob>): Promise<EvalJob | undefined> {
    const result = await db.update(evalJobs).set({ ...data, updatedAt: new Date() }).where(eq(evalJobs.id, id)).returning();
    return result[0];
  }

  async claimEvalJob(jobId: number, agentId: number): Promise<EvalJob | undefined> {
    // Use atomic claim with SELECT FOR UPDATE SKIP LOCKED to prevent race conditions
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Try to lock and select the specific job
      const selectResult = await client.query(
        `SELECT * FROM eval_jobs
         WHERE id = $1 AND status = 'pending'::eval_job_status
         FOR UPDATE SKIP LOCKED`,
        [jobId]
      );

      if (selectResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return undefined;
      }

      // Update the job
      const updateResult = await client.query(
        `UPDATE eval_jobs
         SET eval_agent_id = $1, status = 'running'::eval_job_status, started_at = NOW(), updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [agentId, jobId]
      );

      await client.query('COMMIT');
      return snakeToCamel(updateResult.rows[0]) as EvalJob;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Atomic claim for next available job in region
  async claimNextAvailableJob(agentId: number, region: "na" | "apac" | "eu"): Promise<EvalJob | undefined> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Select and lock the next available job, skipping locked rows
      const selectResult = await client.query(
        `SELECT * FROM eval_jobs
         WHERE status = 'pending'::eval_job_status AND region = $1
         ORDER BY priority DESC, created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [region]
      );

      if (selectResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return undefined;
      }

      const job = selectResult.rows[0];

      // Update the job
      const updateResult = await client.query(
        `UPDATE eval_jobs
         SET eval_agent_id = $1, status = 'running'::eval_job_status, started_at = NOW(), updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [agentId, job.id]
      );

      await client.query('COMMIT');
      return snakeToCamel(updateResult.rows[0]) as EvalJob;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Release stale jobs where agent hasn't sent heartbeat
  async releaseStaleJobs(staleThresholdMinutes: number = 5): Promise<number> {
    const staleThreshold = new Date(Date.now() - staleThresholdMinutes * 60 * 1000);

    // Find running jobs where agent last_seen_at is older than threshold
    // Cast string literals to eval_job_status enum type for PostgreSQL compatibility
    const result = await db.execute(sql`
      UPDATE eval_jobs
      SET
        status = CASE
          WHEN retry_count >= max_retries THEN 'failed'::eval_job_status
          ELSE 'pending'::eval_job_status
        END,
        retry_count = retry_count + 1,
        eval_agent_id = NULL,
        started_at = NULL,
        error = CASE
          WHEN retry_count >= max_retries THEN 'Agent timeout - max retries exceeded'
          ELSE NULL
        END,
        updated_at = NOW()
      WHERE id IN (
        SELECT ej.id FROM eval_jobs ej
        INNER JOIN eval_agents ea ON ej.eval_agent_id = ea.id
        WHERE ej.status = 'running'::eval_job_status
        AND ea.last_seen_at < ${staleThreshold}
      )
    `);

    return (result as unknown as { rowCount: number }).rowCount || 0;
  }

  // Get all jobs with optional filters
  async getEvalJobs(filters?: {
    status?: "pending" | "running" | "completed" | "failed";
    region?: "na" | "apac" | "eu";
    workflowId?: number;
    agentId?: number;
    ownerId?: number;
    limit?: number;
    offset?: number;
  }): Promise<EvalJob[]> {
    const conditions = [];
    if (filters?.status) {
      conditions.push(eq(evalJobs.status, filters.status));
    }
    if (filters?.region) {
      conditions.push(eq(evalJobs.region, filters.region));
    }
    if (filters?.workflowId) {
      conditions.push(eq(evalJobs.workflowId, filters.workflowId));
    }
    if (filters?.agentId) {
      conditions.push(eq(evalJobs.evalAgentId, filters.agentId));
    }

    // If filtering by owner, need to join with workflows
    if (filters?.ownerId) {
      let query = db.select({
        id: evalJobs.id,
        scheduleId: evalJobs.scheduleId,
        workflowId: evalJobs.workflowId,
        evalSetId: evalJobs.evalSetId,
        evalAgentId: evalJobs.evalAgentId,
        status: evalJobs.status,
        region: evalJobs.region,
        priority: evalJobs.priority,
        retryCount: evalJobs.retryCount,
        maxRetries: evalJobs.maxRetries,
        error: evalJobs.error,
        startedAt: evalJobs.startedAt,
        completedAt: evalJobs.completedAt,
        createdAt: evalJobs.createdAt,
        updatedAt: evalJobs.updatedAt,
      })
        .from(evalJobs)
        .innerJoin(workflows, eq(evalJobs.workflowId, workflows.id));

      conditions.push(eq(workflows.ownerId, filters.ownerId));

      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as typeof query;
      }

      query = query.orderBy(desc(evalJobs.createdAt)) as typeof query;

      if (filters?.limit) {
        query = query.limit(filters.limit) as typeof query;
      }
      if (filters?.offset) {
        query = query.offset(filters.offset) as typeof query;
      }

      return query;
    }

    // Simple query without join
    let query = db.select().from(evalJobs);

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    query = query.orderBy(desc(evalJobs.createdAt)) as typeof query;

    if (filters?.limit) {
      query = query.limit(filters.limit) as typeof query;
    }
    if (filters?.offset) {
      query = query.offset(filters.offset) as typeof query;
    }

    return query;
  }

  // Cancel a pending job
  async cancelEvalJob(jobId: number): Promise<EvalJob | undefined> {
    const job = await this.getEvalJob(jobId);
    if (!job || job.status !== 'pending') {
      return undefined;
    }

    const result = await db.update(evalJobs)
      .set({
        status: "failed",
        error: "Cancelled by user",
        completedAt: new Date(),
        updatedAt: new Date()
      })
      .where(and(eq(evalJobs.id, jobId), eq(evalJobs.status, "pending")))
      .returning();

    return result[0];
  }

  // Get jobs that are running but agent is offline
  async getStaleRunningJobs(staleThresholdMinutes: number = 5): Promise<EvalJob[]> {
    const staleThreshold = new Date(Date.now() - staleThresholdMinutes * 60 * 1000);

    const result = await db.execute(sql`
      SELECT ej.* FROM eval_jobs ej
      INNER JOIN eval_agents ea ON ej.eval_agent_id = ea.id
      WHERE ej.status = 'running'::eval_job_status
      AND ea.last_seen_at < ${staleThreshold}
    `);

    return (result as unknown as { rows: EvalJob[] }).rows || [];
  }

  // Mark offline agents
  async markOfflineAgents(staleThresholdMinutes: number = 5): Promise<number> {
    const staleThreshold = new Date(Date.now() - staleThresholdMinutes * 60 * 1000);

    const result = await db.update(evalAgents)
      .set({ state: "offline", updatedAt: new Date() })
      .where(and(
        sql`${evalAgents.lastSeenAt} < ${staleThreshold}`,
        sql`${evalAgents.state} != 'offline'::eval_agent_state`
      ));

    return (result as unknown as { rowCount: number }).rowCount || 0;
  }

  async completeEvalJob(jobId: number, error?: string): Promise<EvalJob | undefined> {
    const result = await db.update(evalJobs)
      .set({ 
        status: error ? "failed" : "completed", 
        completedAt: new Date(),
        error: error || null,
        updatedAt: new Date(),
      })
      .where(eq(evalJobs.id, jobId))
      .returning();
    return result[0];
  }

  async createEvalResult(result: InsertEvalResult): Promise<EvalResult> {
    const inserted = await db.insert(evalResults).values(result).returning();
    return inserted[0];
  }

  async getEvalResult(id: number): Promise<EvalResult | undefined> {
    const result = await db.select().from(evalResults).where(eq(evalResults.id, id));
    return result[0];
  }

  async getEvalResultsByJob(jobId: number): Promise<EvalResult[]> {
    return db.select().from(evalResults).where(eq(evalResults.evalJobId, jobId)).orderBy(desc(evalResults.createdAt));
  }

  async getEvalResultsByProvider(providerId: string): Promise<EvalResult[]> {
    return db.select().from(evalResults).where(eq(evalResults.providerId, providerId)).orderBy(desc(evalResults.createdAt));
  }

  async getRecentEvalResults(limit: number = 50): Promise<EvalResult[]> {
    return db.select().from(evalResults).orderBy(desc(evalResults.createdAt)).limit(limit);
  }

  async getEvalResults(filters?: {
    ownerId?: number;
    workflowId?: number;
    jobId?: number;
    limit?: number;
    offset?: number;
  }): Promise<EvalResult[]> {
    const conditions = [];

    if (filters?.jobId) {
      conditions.push(eq(evalResults.evalJobId, filters.jobId));
    }

    if (filters?.workflowId || filters?.ownerId) {
      // Need to join with evalJobs and workflows for these filters
      let query = db.select({
        id: evalResults.id,
        evalJobId: evalResults.evalJobId,
        providerId: evalResults.providerId,
        region: evalResults.region,
        responseLatencyMedian: evalResults.responseLatencyMedian,
        responseLatencySd: evalResults.responseLatencySd,
        interruptLatencyMedian: evalResults.interruptLatencyMedian,
        interruptLatencySd: evalResults.interruptLatencySd,
        networkResilience: evalResults.networkResilience,
        naturalness: evalResults.naturalness,
        noiseReduction: evalResults.noiseReduction,
        rawData: evalResults.rawData,
        createdAt: evalResults.createdAt,
      })
        .from(evalResults)
        .innerJoin(evalJobs, eq(evalResults.evalJobId, evalJobs.id))
        .innerJoin(workflows, eq(evalJobs.workflowId, workflows.id));

      if (filters.workflowId) {
        conditions.push(eq(evalJobs.workflowId, filters.workflowId));
      }

      if (filters.ownerId) {
        conditions.push(eq(workflows.ownerId, filters.ownerId));
      }

      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as typeof query;
      }

      return query
        .orderBy(desc(evalResults.createdAt))
        .limit(filters?.limit || 50)
        .offset(filters?.offset || 0);
    }

    // Simple query without joins
    let simpleQuery = db.select().from(evalResults);
    if (conditions.length > 0) {
      simpleQuery = simpleQuery.where(and(...conditions)) as typeof simpleQuery;
    }
    return simpleQuery
      .orderBy(desc(evalResults.createdAt))
      .limit(filters?.limit || 50)
      .offset(filters?.offset || 0);
  }

  async getMainlineEvalResults(limit: number = 50): Promise<EvalResult[]> {
    return db.select()
      .from(evalResults)
      .innerJoin(evalJobs, eq(evalResults.evalJobId, evalJobs.id))
      .innerJoin(workflows, eq(evalJobs.workflowId, workflows.id))
      .where(eq(workflows.isMainline, true))
      .orderBy(desc(evalResults.createdAt))
      .limit(limit)
      .then(rows => rows.map(r => r.eval_results));
  }

  async createApiKey(apiKey: InsertApiKey): Promise<ApiKey> {
    const result = await db.insert(apiKeys).values(apiKey).returning();
    return result[0];
  }

  async getApiKey(id: number): Promise<ApiKey | undefined> {
    const result = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    return result[0];
  }

  async getApiKeyByHash(keyHash: string): Promise<ApiKey | undefined> {
    const result = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));
    return result[0];
  }

  async getApiKeysByUser(userId: number): Promise<ApiKey[]> {
    return db.select().from(apiKeys).where(eq(apiKeys.createdBy, userId)).orderBy(desc(apiKeys.createdAt));
  }

  async revokeApiKey(id: number): Promise<void> {
    await db.update(apiKeys).set({ isRevoked: true }).where(eq(apiKeys.id, id));
  }

  async incrementApiKeyUsage(id: number): Promise<void> {
    await db.update(apiKeys).set({
      usageCount: sql`${apiKeys.usageCount} + 1`,
      lastUsedAt: new Date()
    }).where(eq(apiKeys.id, id));
  }

  async deleteApiKey(id: number): Promise<void> {
    await db.delete(apiKeys).where(eq(apiKeys.id, id));
  }

  async getPricingConfig(id: number): Promise<PricingConfig | undefined> {
    const result = await db.select().from(pricingConfig).where(eq(pricingConfig.id, id));
    return result[0];
  }

  async getAllPricingConfig(): Promise<PricingConfig[]> {
    return db.select().from(pricingConfig).where(eq(pricingConfig.isActive, true)).orderBy(pricingConfig.minSeats);
  }

  async setPricingConfig(config: InsertPricingConfig): Promise<PricingConfig> {
    const inserted = await db.insert(pricingConfig).values(config).returning();
    return inserted[0];
  }

  async updatePricingConfig(id: number, data: Partial<PricingConfig>): Promise<PricingConfig | undefined> {
    const result = await db.update(pricingConfig).set({ ...data, updatedAt: new Date() }).where(eq(pricingConfig.id, id)).returning();
    return result[0];
  }

  async createPaymentMethod(method: InsertPaymentMethod): Promise<PaymentMethod> {
    const result = await db.insert(paymentMethods).values(method).returning();
    return result[0];
  }

  async getPaymentMethod(id: number): Promise<PaymentMethod | undefined> {
    const result = await db.select().from(paymentMethods).where(eq(paymentMethods.id, id));
    return result[0];
  }

  async getPaymentMethodsByUser(userId: number): Promise<PaymentMethod[]> {
    return db.select().from(paymentMethods).where(eq(paymentMethods.userId, userId)).orderBy(desc(paymentMethods.createdAt));
  }

  async getPaymentMethodsByOrganization(organizationId: number): Promise<PaymentMethod[]> {
    return db.select().from(paymentMethods).where(eq(paymentMethods.organizationId, organizationId)).orderBy(desc(paymentMethods.createdAt));
  }

  async updatePaymentMethod(id: number, data: Partial<PaymentMethod>): Promise<PaymentMethod | undefined> {
    const result = await db.update(paymentMethods).set({ ...data, updatedAt: new Date() }).where(eq(paymentMethods.id, id)).returning();
    return result[0];
  }

  async deletePaymentMethod(id: number): Promise<void> {
    await db.delete(paymentMethods).where(eq(paymentMethods.id, id));
  }

  async createPaymentHistory(history: InsertPaymentHistory): Promise<PaymentHistory> {
    const result = await db.insert(paymentHistories).values(history).returning();
    return result[0];
  }

  async getPaymentHistoriesByUser(userId: number): Promise<PaymentHistory[]> {
    return db.select().from(paymentHistories).where(eq(paymentHistories.userId, userId)).orderBy(desc(paymentHistories.createdAt));
  }

  async getPaymentHistoriesByOrganization(organizationId: number): Promise<PaymentHistory[]> {
    return db.select().from(paymentHistories).where(eq(paymentHistories.organizationId, organizationId)).orderBy(desc(paymentHistories.createdAt));
  }

  async createOrganizationSeat(seat: InsertOrganizationSeat): Promise<OrganizationSeat> {
    const result = await db.insert(organizationSeats).values(seat).returning();
    return result[0];
  }

  async getOrganizationSeat(organizationId: number): Promise<OrganizationSeat | undefined> {
    const result = await db.select().from(organizationSeats).where(eq(organizationSeats.organizationId, organizationId));
    return result[0];
  }

  async updateOrganizationSeat(organizationId: number, data: Partial<OrganizationSeat>): Promise<OrganizationSeat | undefined> {
    const result = await db.update(organizationSeats).set({ ...data, updatedAt: new Date() }).where(eq(organizationSeats.organizationId, organizationId)).returning();
    return result[0];
  }

  async createActivationToken(userId: number, tokenHash: string, expiresAt: Date): Promise<void> {
    await db.insert(activationTokens).values({ userId, tokenHash, expiresAt });
  }

  async getActivationTokenByHash(tokenHash: string): Promise<{ userId: number; expiresAt: Date; usedAt: Date | null } | undefined> {
    const result = await db.select().from(activationTokens).where(eq(activationTokens.tokenHash, tokenHash));
    if (result[0]) {
      return { userId: result[0].userId, expiresAt: result[0].expiresAt, usedAt: result[0].usedAt };
    }
    return undefined;
  }

  async markActivationTokenUsed(tokenHash: string): Promise<void> {
    await db.update(activationTokens).set({ usedAt: new Date() }).where(eq(activationTokens.tokenHash, tokenHash));
  }

  async createInviteToken(email: string, plan: "basic" | "premium" | "principal" | "fellow", isAdmin: boolean, tokenHash: string, createdBy: number | null, expiresAt: Date, organizationId?: number): Promise<void> {
    await db.insert(inviteTokens).values({ 
      email, 
      plan, 
      isAdmin, 
      tokenHash, 
      createdBy, 
      expiresAt,
      organizationId,
    });
  }

  async getInviteTokenByHash(tokenHash: string): Promise<{ email: string; plan: string; isAdmin: boolean; expiresAt: Date; usedAt: Date | null; organizationId: number | null } | undefined> {
    const result = await db.select().from(inviteTokens).where(eq(inviteTokens.tokenHash, tokenHash));
    if (result[0]) {
      return { 
        email: result[0].email, 
        plan: result[0].plan, 
        isAdmin: result[0].isAdmin, 
        expiresAt: result[0].expiresAt,
        usedAt: result[0].usedAt,
        organizationId: result[0].organizationId,
      };
    }
    return undefined;
  }

  async markInviteTokenUsed(tokenHash: string): Promise<void> {
    await db.update(inviteTokens).set({ usedAt: new Date() }).where(eq(inviteTokens.tokenHash, tokenHash));
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

  async createFundReturnRequest(request: InsertFundReturnRequest): Promise<FundReturnRequest> {
    const result = await db.insert(fundReturnRequests).values(request).returning();
    return result[0];
  }

  async getFundReturnRequest(id: number): Promise<FundReturnRequest | undefined> {
    const result = await db.select().from(fundReturnRequests).where(eq(fundReturnRequests.id, id));
    return result[0];
  }

  async getPendingFundReturnRequests(): Promise<FundReturnRequest[]> {
    return db.select().from(fundReturnRequests).where(eq(fundReturnRequests.status, "pending")).orderBy(desc(fundReturnRequests.createdAt));
  }

  async getFundReturnRequestsByUser(userId: number): Promise<FundReturnRequest[]> {
    return db.select().from(fundReturnRequests).where(eq(fundReturnRequests.userId, userId)).orderBy(desc(fundReturnRequests.createdAt));
  }

  async reviewFundReturnRequest(id: number, reviewedBy: number, status: "approved" | "rejected"): Promise<FundReturnRequest | undefined> {
    const result = await db.update(fundReturnRequests)
      .set({ status, reviewedBy, reviewedAt: new Date() })
      .where(eq(fundReturnRequests.id, id))
      .returning();
    return result[0];
  }

  // Organization helper methods
  async countOrgAdmins(organizationId: number): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)` })
      .from(users)
      .where(and(eq(users.organizationId, organizationId), eq(users.isOrgAdmin, true)));
    return Number(result[0]?.count || 0);
  }

  async getOrganizationMemberCount(organizationId: number): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)` })
      .from(users)
      .where(eq(users.organizationId, organizationId));
    return Number(result[0]?.count || 0);
  }

  async removeUserFromOrganization(userId: number): Promise<User | undefined> {
    const result = await db.update(users)
      .set({ organizationId: null, isOrgAdmin: false, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    return result[0];
  }

  async getDefaultPaymentMethod(organizationId: number): Promise<PaymentMethod | undefined> {
    const result = await db.select()
      .from(paymentMethods)
      .where(and(eq(paymentMethods.organizationId, organizationId), eq(paymentMethods.isDefault, true)));
    return result[0];
  }

  async setDefaultPaymentMethod(organizationId: number, paymentMethodId: number): Promise<void> {
    // Clear current default
    await db.update(paymentMethods)
      .set({ isDefault: false })
      .where(eq(paymentMethods.organizationId, organizationId));
    // Set new default
    await db.update(paymentMethods)
      .set({ isDefault: true })
      .where(eq(paymentMethods.id, paymentMethodId));
  }

  async getAllFundReturnRequests(): Promise<FundReturnRequest[]> {
    return db.select().from(fundReturnRequests).orderBy(desc(fundReturnRequests.createdAt));
  }

  // ==================== EVAL SCHEDULES ====================

  async createEvalSchedule(schedule: InsertEvalSchedule): Promise<EvalSchedule> {
    const result = await db.insert(evalSchedules).values(schedule).returning();
    return result[0];
  }

  async getEvalSchedule(id: number): Promise<EvalSchedule | undefined> {
    const result = await db.select().from(evalSchedules).where(eq(evalSchedules.id, id));
    return result[0];
  }

  async getEvalSchedulesByUser(userId: number): Promise<EvalSchedule[]> {
    return db.select().from(evalSchedules).where(eq(evalSchedules.createdBy, userId)).orderBy(desc(evalSchedules.createdAt));
  }

  async getEvalSchedulesByWorkflow(workflowId: number): Promise<EvalSchedule[]> {
    return db.select().from(evalSchedules).where(eq(evalSchedules.workflowId, workflowId)).orderBy(desc(evalSchedules.createdAt));
  }

  async updateEvalSchedule(id: number, data: Partial<EvalSchedule>): Promise<EvalSchedule | undefined> {
    const result = await db.update(evalSchedules).set({ ...data, updatedAt: new Date() }).where(eq(evalSchedules.id, id)).returning();
    return result[0];
  }

  async deleteEvalSchedule(id: number): Promise<void> {
    await db.delete(evalSchedules).where(eq(evalSchedules.id, id));
  }

  // Get schedules that are due to run (isEnabled=true, nextRunAt <= now)
  async getDueSchedules(): Promise<EvalSchedule[]> {
    const now = new Date();
    return db.select()
      .from(evalSchedules)
      .where(
        and(
          eq(evalSchedules.isEnabled, true),
          sql`${evalSchedules.nextRunAt} <= ${now}`
        )
      )
      .orderBy(evalSchedules.nextRunAt);
  }

  // Update schedule after a job is created from it
  async markScheduleRun(scheduleId: number, nextRunAt: Date | null): Promise<EvalSchedule | undefined> {
    const result = await db.update(evalSchedules)
      .set({
        lastRunAt: new Date(),
        runCount: sql`${evalSchedules.runCount} + 1`,
        nextRunAt: nextRunAt,
        updatedAt: new Date(),
      })
      .where(eq(evalSchedules.id, scheduleId))
      .returning();
    return result[0];
  }

  // Disable schedule (e.g., when maxRuns reached or one-time completed)
  async disableSchedule(scheduleId: number): Promise<void> {
    await db.update(evalSchedules)
      .set({ isEnabled: false, nextRunAt: null, updatedAt: new Date() })
      .where(eq(evalSchedules.id, scheduleId));
  }

  // Get all enabled schedules for a user
  async getActiveSchedulesByUser(userId: number): Promise<EvalSchedule[]> {
    return db.select()
      .from(evalSchedules)
      .where(and(eq(evalSchedules.createdBy, userId), eq(evalSchedules.isEnabled, true)))
      .orderBy(evalSchedules.nextRunAt);
  }

  // Get schedules with their workflow info (for listing)
  async getEvalSchedulesWithWorkflow(userId: number): Promise<(EvalSchedule & { workflowName: string })[]> {
    const results = await db.select({
      id: evalSchedules.id,
      name: evalSchedules.name,
      workflowId: evalSchedules.workflowId,
      evalSetId: evalSchedules.evalSetId,
      region: evalSchedules.region,
      scheduleType: evalSchedules.scheduleType,
      cronExpression: evalSchedules.cronExpression,
      timezone: evalSchedules.timezone,
      isEnabled: evalSchedules.isEnabled,
      nextRunAt: evalSchedules.nextRunAt,
      lastRunAt: evalSchedules.lastRunAt,
      runCount: evalSchedules.runCount,
      maxRuns: evalSchedules.maxRuns,
      createdBy: evalSchedules.createdBy,
      createdAt: evalSchedules.createdAt,
      updatedAt: evalSchedules.updatedAt,
      workflowName: workflows.name,
    })
      .from(evalSchedules)
      .innerJoin(workflows, eq(evalSchedules.workflowId, workflows.id))
      .where(eq(evalSchedules.createdBy, userId))
      .orderBy(desc(evalSchedules.createdAt));

    return results;
  }
}

export const storage = new DatabaseStorage();
