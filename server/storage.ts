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
  type Secret,
  type InsertSecret,
  type ClashAgentProfile,
  type InsertClashAgentProfile,
  type ClashMatch,
  type InsertClashMatch,
  type ClashResult,
  type InsertClashResult,
  type ClashEloRating,
  type ClashEvent,
  type InsertClashEvent,
  type ClashRunner,
  type ClashTranscript,
  type ClashSchedule,
  type InsertClashSchedule,
  type ClashRunnerIssuedToken,
  type InsertClashRunnerIssuedToken,
  type UserStorageConfig,
  type InsertUserStorageConfig,
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
  secrets,
  clashAgentProfiles,
  clashMatches,
  clashResults,
  clashEloRatings,
  clashEvents,
  clashRunnerPool,
  clashRunnerIssuedTokens,
  clashTranscripts,
  clashSchedules,
  userStorageConfig,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import { desc, eq, and, or, not, sql, gte, inArray } from "drizzle-orm";
import crypto from "crypto";

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateSecureToken(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

export function generateEvalAgentToken(): string {
  return "ev" + crypto.randomBytes(15).toString('hex');
}

// AES-256-GCM encryption for secrets
// CREDENTIAL_ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars)
// Ciphertext format: v1:iv:authTag:data (versioned for future key rotation)

const CIPHER_VERSION = "v1";
let _cachedKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (_cachedKey) return _cachedKey;
  const keyHex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!keyHex || !/^[0-9a-f]{64}$/i.test(keyHex)) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a valid 64-char hex string (32 bytes)");
  }
  _cachedKey = Buffer.from(keyHex, "hex");
  return _cachedKey;
}

export function isEncryptionConfigured(): boolean {
  const keyHex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  return !!keyHex && /^[0-9a-f]{64}$/i.test(keyHex);
}

export function encryptValue(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${CIPHER_VERSION}:${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptValue(stored: string): string {
  const parts = stored.split(":");
  // Support versioned format (v1:iv:tag:data) and legacy unversioned (iv:tag:data)
  let ivB64: string, tagB64: string, dataB64: string;
  if (parts[0] === "v1") {
    [, ivB64, tagB64, dataB64] = parts;
  } else {
    // Legacy format: iv:tag:data (no version prefix)
    [ivB64, tagB64, dataB64] = parts;
  }
  const key = getEncryptionKey();
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

const MAX_CONFIG_SIZE = 100_000; // 100KB

export function validateEvalConfig(config: unknown): { valid: boolean; error?: string } {
  if (config === null || config === undefined) {
    return { valid: true };
  }
  if (typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, error: "Config must be an object" };
  }
  const c = config as Record<string, unknown>;
  if (c.framework !== undefined && c.framework !== "aeval" && c.framework !== "voice-agent-tester") {
    return { valid: false, error: "Framework must be 'aeval' or 'voice-agent-tester'" };
  }
  if (c.app !== undefined && typeof c.app !== "string") {
    return { valid: false, error: "Config app must be a string" };
  }
  if (c.scenario !== undefined && typeof c.scenario !== "string") {
    return { valid: false, error: "Config scenario must be a string" };
  }
  if (JSON.stringify(config).length > MAX_CONFIG_SIZE) {
    return { valid: false, error: "Config too large (max 100KB)" };
  }
  return { valid: true };
}

export function mergeEvalConfig(
  workflowConfig: unknown,
  evalSetConfig: unknown,
): Record<string, unknown> {
  return {
    ...((workflowConfig as Record<string, unknown>) || {}),
    ...((evalSetConfig as Record<string, unknown>) || {}),
  };
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

  async getUserByGithubId(githubId: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.githubId, githubId));
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

  async getEvalJobsByEvalSetId(evalSetId: number): Promise<EvalJob[]> {
    return db.select().from(evalJobs).where(eq(evalJobs.evalSetId, evalSetId));
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

  async getEvalAgentTokensByUser(userId: number): Promise<EvalAgentToken[]> {
    return db.select().from(evalAgentTokens).where(eq(evalAgentTokens.createdBy, userId)).orderBy(desc(evalAgentTokens.createdAt));
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

  async getEvalAgentsByTokenId(tokenId: number): Promise<EvalAgent[]> {
    return db.select().from(evalAgents).where(eq(evalAgents.tokenId, tokenId)).orderBy(desc(evalAgents.createdAt)).limit(1);
  }

  async getAllEvalAgents(): Promise<EvalAgent[]> {
    return db.select().from(evalAgents).orderBy(desc(evalAgents.createdAt));
  }

  async getEvalAgentsWithTokenVisibility(): Promise<(EvalAgent & { tokenVisibility: string; tokenCreatedBy: number })[]> {
    const results = await db.select({
      id: evalAgents.id,
      name: evalAgents.name,
      tokenId: evalAgents.tokenId,
      region: evalAgents.region,
      state: evalAgents.state,
      lastSeenAt: evalAgents.lastSeenAt,
      lastJobAt: evalAgents.lastJobAt,
      metadata: evalAgents.metadata,
      createdAt: evalAgents.createdAt,
      updatedAt: evalAgents.updatedAt,
      tokenVisibility: evalAgentTokens.visibility,
      tokenCreatedBy: evalAgentTokens.createdBy,
    })
      .from(evalAgents)
      .innerJoin(evalAgentTokens, eq(evalAgents.tokenId, evalAgentTokens.id))
      .orderBy(desc(evalAgents.createdAt));
    return results as (EvalAgent & { tokenVisibility: string; tokenCreatedBy: number })[];
  }

  async updateEvalAgent(id: number, data: Partial<EvalAgent>): Promise<EvalAgent | undefined> {
    const result = await db.update(evalAgents).set({ ...data, updatedAt: new Date() }).where(eq(evalAgents.id, id)).returning();
    return result[0];
  }

  async updateEvalAgentHeartbeat(id: number): Promise<void> {
    await db.update(evalAgents).set({ lastSeenAt: new Date(), state: "idle", updatedAt: new Date() }).where(eq(evalAgents.id, id));
  }

  async countTodayJobsByOwner(ownerId: number): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const result = await db.select({ count: sql<number>`count(*)::int` })
      .from(evalJobs)
      .innerJoin(workflows, eq(evalJobs.workflowId, workflows.id))
      .where(and(eq(workflows.ownerId, ownerId), gte(evalJobs.createdAt, startOfDay)));
    return result[0]?.count ?? 0;
  }

  async createEvalJob(job: InsertEvalJob): Promise<EvalJob> {
    const result = await db.insert(evalJobs).values(job).returning();
    return result[0];
  }

  async getEvalJob(id: number): Promise<EvalJob | undefined> {
    const result = await db.select().from(evalJobs).where(eq(evalJobs.id, id));
    return result[0];
  }

  async getPendingEvalJobsByRegion(region: "na" | "apac" | "eu" | "sa"): Promise<EvalJob[]> {
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
    region?: "na" | "apac" | "eu" | "sa";
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
        createdBy: evalJobs.createdBy,
        status: evalJobs.status,
        region: evalJobs.region,
        priority: evalJobs.priority,
        retryCount: evalJobs.retryCount,
        maxRetries: evalJobs.maxRetries,
        config: evalJobs.config,
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
        responseLatencyP95: evalResults.responseLatencyP95,
        interruptLatencyMedian: evalResults.interruptLatencyMedian,
        interruptLatencySd: evalResults.interruptLatencySd,
        interruptLatencyP95: evalResults.interruptLatencyP95,
        networkResilience: evalResults.networkResilience,
        naturalness: evalResults.naturalness,
        noiseReduction: evalResults.noiseReduction,
        rawData: evalResults.rawData,
        artifactStatus: evalResults.artifactStatus,
        artifactUrl: evalResults.artifactUrl,
        artifactFiles: evalResults.artifactFiles,
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

  async getMainlineEvalResults(limit: number = 50, hoursBack?: number): Promise<EvalResult[]> {
    const conditions = [
      eq(workflows.isMainline, true),
      eq(workflows.visibility, "public"),
      eq(evalSets.isMainline, true),
      eq(evalSets.visibility, "public"),
      eq(evalAgentTokens.visibility, "public"),
      // Only principal/fellow users' jobs qualify as mainline
      inArray(users.plan, ["principal", "fellow"]),
    ];

    if (hoursBack) {
      const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
      conditions.push(gte(evalResults.createdAt, cutoff));
    }

    return db.select()
      .from(evalResults)
      .innerJoin(evalJobs, eq(evalResults.evalJobId, evalJobs.id))
      .innerJoin(users, eq(evalJobs.createdBy, users.id))
      .innerJoin(workflows, eq(evalJobs.workflowId, workflows.id))
      .innerJoin(evalSets, eq(evalJobs.evalSetId, evalSets.id))
      .innerJoin(evalAgents, eq(evalJobs.evalAgentId, evalAgents.id))
      .innerJoin(evalAgentTokens, eq(evalAgents.tokenId, evalAgentTokens.id))
      .where(and(...conditions))
      .orderBy(desc(evalResults.createdAt))
      .limit(limit)
      .then(rows => rows.map(r => r.eval_results));
  }

  async getCommunityEvalResults(limit: number = 50, hoursBack?: number): Promise<EvalResult[]> {
    const conditions = [
      eq(workflows.visibility, "public"),
      eq(evalSets.visibility, "public"),
      // Exclude fully mainline results (all 4 conditions must be true to be mainline)
      or(
        not(eq(workflows.isMainline, true)),
        not(eq(evalSets.isMainline, true)),
        sql`${evalAgentTokens.visibility} IS NULL OR ${evalAgentTokens.visibility} != 'public'`,
        sql`${users.plan} IS NULL OR ${users.plan} NOT IN ('principal', 'fellow')`,
      ),
    ];

    if (hoursBack) {
      const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
      conditions.push(gte(evalResults.createdAt, cutoff));
    }

    return db.select()
      .from(evalResults)
      .innerJoin(evalJobs, eq(evalResults.evalJobId, evalJobs.id))
      .innerJoin(workflows, eq(evalJobs.workflowId, workflows.id))
      .innerJoin(evalSets, eq(evalJobs.evalSetId, evalSets.id))
      .leftJoin(users, eq(evalJobs.createdBy, users.id))
      .leftJoin(evalAgents, eq(evalJobs.evalAgentId, evalAgents.id))
      .leftJoin(evalAgentTokens, eq(evalAgents.tokenId, evalAgentTokens.id))
      .where(and(...conditions))
      .orderBy(desc(evalResults.createdAt))
      .limit(limit)
      .then(rows => rows.map(r => r.eval_results));
  }

  async getMyEvalResults(userId: number, limit: number = 50, hoursBack?: number): Promise<EvalResult[]> {
    const conditions = [
      or(
        and(eq(workflows.visibility, "private"), eq(workflows.ownerId, userId)),
        and(eq(evalSets.visibility, "private"), eq(evalSets.ownerId, userId)),
      ),
    ];

    if (hoursBack) {
      const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
      conditions.push(gte(evalResults.createdAt, cutoff));
    }

    return db.select()
      .from(evalResults)
      .innerJoin(evalJobs, eq(evalResults.evalJobId, evalJobs.id))
      .innerJoin(workflows, eq(evalJobs.workflowId, workflows.id))
      .innerJoin(evalSets, eq(evalJobs.evalSetId, evalSets.id))
      .where(and(...conditions))
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

  async getPaymentHistoryByStripeId(stripePaymentIntentId: string): Promise<PaymentHistory | undefined> {
    const result = await db.select().from(paymentHistories).where(eq(paymentHistories.stripePaymentIntentId, stripePaymentIntentId));
    return result[0];
  }

  async updatePaymentHistoryStatus(id: number, status: string): Promise<PaymentHistory | undefined> {
    const result = await db.update(paymentHistories).set({ status }).where(eq(paymentHistories.id, id)).returning();
    return result[0];
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
  private buildScheduleQuery() {
    return {
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
      creatorName: users.username,
    };
  }

  async getEvalSchedulesWithWorkflow(userId: number): Promise<(EvalSchedule & { workflowName: string; creatorName: string })[]> {
    return db.select(this.buildScheduleQuery())
      .from(evalSchedules)
      .innerJoin(workflows, eq(evalSchedules.workflowId, workflows.id))
      .innerJoin(users, eq(evalSchedules.createdBy, users.id))
      .where(eq(evalSchedules.createdBy, userId))
      .orderBy(desc(evalSchedules.createdAt));
  }

  async getAllEvalSchedulesWithWorkflow(): Promise<(EvalSchedule & { workflowName: string; creatorName: string })[]> {
    return db.select(this.buildScheduleQuery())
      .from(evalSchedules)
      .innerJoin(workflows, eq(evalSchedules.workflowId, workflows.id))
      .innerJoin(users, eq(evalSchedules.createdBy, users.id))
      .orderBy(desc(evalSchedules.createdAt));
  }

  // ==================== SECRETS ====================

  async createOrUpdateSecret(userId: number, name: string, encryptedValue: string): Promise<Secret> {
    const existing = await db.select().from(secrets)
      .where(and(eq(secrets.userId, userId), eq(secrets.name, name)));
    if (existing[0]) {
      const result = await db.update(secrets)
        .set({ encryptedValue, updatedAt: new Date() })
        .where(eq(secrets.id, existing[0].id))
        .returning();
      return result[0];
    }
    const result = await db.insert(secrets).values({ userId, name, encryptedValue }).returning();
    return result[0];
  }

  async getSecretsByUserId(userId: number): Promise<Secret[]> {
    return db.select().from(secrets).where(eq(secrets.userId, userId)).orderBy(desc(secrets.createdAt));
  }

  async deleteSecret(userId: number, name: string): Promise<boolean> {
    const result = await db.delete(secrets)
      .where(and(eq(secrets.userId, userId), eq(secrets.name, name)))
      .returning();
    return result.length > 0;
  }

  async getSecretsForJob(jobId: number): Promise<Secret[]> {
    // Find the workflow owner for this job, then return their secrets
    const job = await this.getEvalJob(jobId);
    if (!job) { console.log(`[Secrets] getSecretsForJob: job ${jobId} not found`); return []; }
    const workflow = await this.getWorkflow(job.workflowId);
    if (!workflow) { console.log(`[Secrets] getSecretsForJob: workflow ${job.workflowId} not found`); return []; }
    console.log(`[Secrets] getSecretsForJob: job ${jobId} → workflow ${workflow.id} → owner ${workflow.ownerId}`);
    return this.getSecretsByUserId(workflow.ownerId);
  }

  // ==================== CLASH AGENT PROFILES ====================

  async getClashAgentProfile(id: number): Promise<ClashAgentProfile | undefined> {
    const result = await db.select().from(clashAgentProfiles).where(eq(clashAgentProfiles.id, id));
    return result[0];
  }

  async getClashAgentProfilesByOwner(ownerId: number): Promise<ClashAgentProfile[]> {
    return db.select().from(clashAgentProfiles)
      .where(eq(clashAgentProfiles.ownerId, ownerId))
      .orderBy(desc(clashAgentProfiles.createdAt));
  }

  async getPublicClashAgentProfiles(): Promise<ClashAgentProfile[]> {
    return db.select().from(clashAgentProfiles)
      .where(eq(clashAgentProfiles.visibility, "public"))
      .orderBy(desc(clashAgentProfiles.createdAt));
  }

  async createClashAgentProfile(data: InsertClashAgentProfile): Promise<ClashAgentProfile> {
    const result = await db.insert(clashAgentProfiles).values(data).returning();
    return result[0];
  }

  async updateClashAgentProfile(id: number, data: Partial<InsertClashAgentProfile>): Promise<ClashAgentProfile | undefined> {
    const result = await db.update(clashAgentProfiles)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(clashAgentProfiles.id, id))
      .returning();
    return result[0];
  }

  async deleteClashAgentProfile(id: number): Promise<boolean> {
    const result = await db.delete(clashAgentProfiles).where(eq(clashAgentProfiles.id, id)).returning();
    return result.length > 0;
  }

  // ==================== CLASH EVENTS ====================

  async getClashEvent(id: number): Promise<ClashEvent | undefined> {
    const result = await db.select().from(clashEvents).where(eq(clashEvents.id, id));
    return result[0];
  }

  async getClashEventsByUser(userId: number): Promise<ClashEvent[]> {
    return db.select().from(clashEvents)
      .where(eq(clashEvents.createdBy, userId))
      .orderBy(desc(clashEvents.createdAt));
  }

  async getClashEventsByStatus(status: string): Promise<ClashEvent[]> {
    return db.select().from(clashEvents)
      .where(eq(clashEvents.status, status as any))
      .orderBy(desc(clashEvents.createdAt));
  }

  async getClashEventFeed(): Promise<ClashEvent[]> {
    return db.select().from(clashEvents)
      .where(or(
        eq(clashEvents.status, "live"),
        eq(clashEvents.status, "upcoming"),
        eq(clashEvents.status, "completed"),
      ))
      .orderBy(desc(clashEvents.createdAt))
      .limit(50);
  }

  async createClashEvent(data: InsertClashEvent): Promise<ClashEvent> {
    const result = await db.insert(clashEvents).values(data).returning();
    return result[0];
  }

  async updateClashEvent(id: number, data: Partial<ClashEvent>): Promise<ClashEvent | undefined> {
    const result = await db.update(clashEvents).set(data).where(eq(clashEvents.id, id)).returning();
    return result[0];
  }

  // ==================== CLASH MATCHES ====================

  async getClashMatch(id: number): Promise<ClashMatch | undefined> {
    const result = await db.select().from(clashMatches).where(eq(clashMatches.id, id));
    return result[0];
  }

  async getClashMatchesByEvent(eventId: number): Promise<ClashMatch[]> {
    return db.select().from(clashMatches)
      .where(eq(clashMatches.eventId, eventId))
      .orderBy(clashMatches.matchOrder);
  }

  async getClashMatchesByStatus(status: string): Promise<ClashMatch[]> {
    return db.select().from(clashMatches)
      .where(eq(clashMatches.status, status as any))
      .orderBy(desc(clashMatches.createdAt));
  }

  async createClashMatch(data: InsertClashMatch): Promise<ClashMatch> {
    const result = await db.insert(clashMatches).values(data).returning();
    return result[0];
  }

  async updateClashMatch(id: number, data: Partial<ClashMatch>): Promise<ClashMatch | undefined> {
    const result = await db.update(clashMatches)
      .set(data)
      .where(eq(clashMatches.id, id))
      .returning();
    return result[0];
  }

  // ==================== CLASH RESULTS ====================

  async getClashResultsByMatch(matchId: number): Promise<ClashResult[]> {
    return db.select().from(clashResults)
      .where(eq(clashResults.clashMatchId, matchId));
  }

  async createClashResult(data: InsertClashResult): Promise<ClashResult> {
    const result = await db.insert(clashResults).values(data).returning();
    return result[0];
  }

  // ==================== CLASH ELO RATINGS ====================

  async getClashEloRating(agentProfileId: number): Promise<ClashEloRating | undefined> {
    const result = await db.select().from(clashEloRatings)
      .where(eq(clashEloRatings.agentProfileId, agentProfileId));
    return result[0];
  }

  async getClashLeaderboard(limit: number = 50): Promise<(ClashEloRating & { profileName: string; providerName: string | null })[]> {
    const result = await db.select({
      id: clashEloRatings.id,
      agentProfileId: clashEloRatings.agentProfileId,
      rating: clashEloRatings.rating,
      matchCount: clashEloRatings.matchCount,
      winCount: clashEloRatings.winCount,
      lossCount: clashEloRatings.lossCount,
      drawCount: clashEloRatings.drawCount,
      updatedAt: clashEloRatings.updatedAt,
      profileName: clashAgentProfiles.name,
      providerName: providers.name,
    })
    .from(clashEloRatings)
    .innerJoin(clashAgentProfiles, eq(clashEloRatings.agentProfileId, clashAgentProfiles.id))
    .leftJoin(providers, eq(clashAgentProfiles.providerId, providers.id))
    .where(eq(clashAgentProfiles.visibility, "public"))
    .orderBy(desc(clashEloRatings.rating))
    .limit(limit);
    return result;
  }

  async upsertClashEloRating(agentProfileId: number, updates: { rating: number; matchCount: number; winCount: number; lossCount: number; drawCount: number }): Promise<ClashEloRating> {
    const existing = await this.getClashEloRating(agentProfileId);
    if (existing) {
      const result = await db.update(clashEloRatings)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(clashEloRatings.agentProfileId, agentProfileId))
        .returning();
      return result[0];
    }
    const result = await db.insert(clashEloRatings)
      .values({ agentProfileId, ...updates })
      .returning();
    return result[0];
  }

  // ==================== CLASH RUNNER POOL ====================

  async getClashRunner(id: number): Promise<ClashRunner | undefined> {
    const result = await db.select().from(clashRunnerPool).where(eq(clashRunnerPool.id, id));
    return result[0];
  }

  async getClashRunnerByTokenHash(tokenHash: string): Promise<ClashRunner | undefined> {
    const result = await db.select().from(clashRunnerPool).where(eq(clashRunnerPool.tokenHash, tokenHash));
    return result[0];
  }

  async getIdleClashRunner(region: string): Promise<ClashRunner | undefined> {
    const result = await db.select().from(clashRunnerPool)
      .where(and(eq(clashRunnerPool.state, "idle"), eq(clashRunnerPool.region, region as any)))
      .limit(1);
    return result[0];
  }

  async registerClashRunner(data: { runnerId: string; tokenHash: string; region: string }): Promise<ClashRunner> {
    // Upsert on tokenHash — one token = one runner slot; runnerId updates on restart
    const existing = await db.select().from(clashRunnerPool).where(eq(clashRunnerPool.tokenHash, data.tokenHash));
    if (existing[0]) {
      // Reset orphaned match only if it still belongs to THIS runner's old runnerId.
      // With multiple runners, another runner may have already claimed the match.
      if (existing[0].currentMatchId && existing[0].runnerId) {
        const orphanedMatch = await this.getClashMatch(existing[0].currentMatchId);
        if (orphanedMatch
            && (orphanedMatch.status === "starting" || orphanedMatch.status === "live")
            && orphanedMatch.runnerId === existing[0].runnerId) {
          await db.update(clashMatches)
            .set({ status: "pending", runnerId: null, startedAt: null })
            .where(eq(clashMatches.id, existing[0].currentMatchId));
          console.log(`[ClashRunner] Reset orphaned match #${existing[0].currentMatchId} to pending (runner ${existing[0].runnerId} re-registered as ${data.runnerId})`);
        }
      }
      const result = await db.update(clashRunnerPool)
        .set({ runnerId: data.runnerId, state: "idle", lastHeartbeatAt: new Date(), currentMatchId: null })
        .where(eq(clashRunnerPool.tokenHash, data.tokenHash)).returning();
      return result[0];
    }
    const result = await db.insert(clashRunnerPool).values({ ...data, region: data.region as any, state: "idle", lastHeartbeatAt: new Date() }).returning();
    return result[0];
  }

  async updateClashRunner(id: number, data: Partial<ClashRunner>): Promise<ClashRunner | undefined> {
    const result = await db.update(clashRunnerPool).set(data).where(eq(clashRunnerPool.id, id)).returning();
    return result[0];
  }

  async getAllClashRunners(): Promise<ClashRunner[]> {
    return db.select().from(clashRunnerPool).orderBy(desc(clashRunnerPool.createdAt));
  }

  async markStaleRunnersDraining(staleThresholdMs: number = 45000): Promise<number> {
    const cutoff = new Date(Date.now() - staleThresholdMs);
    const result = await db.update(clashRunnerPool)
      .set({ state: "draining" })
      .where(and(not(eq(clashRunnerPool.state, "draining")), sql`${clashRunnerPool.lastHeartbeatAt} < ${cutoff}`))
      .returning();
    return result.length;
  }

  async removeStaleRunners(drainingThresholdMs: number = 3600_000): Promise<number> {
    const cutoff = new Date(Date.now() - drainingThresholdMs);
    const result = await db.delete(clashRunnerPool)
      .where(and(eq(clashRunnerPool.state, "draining"), sql`${clashRunnerPool.lastHeartbeatAt} < ${cutoff}`))
      .returning();
    return result.length;
  }

  async failStuckMatches(stuckThresholdMs: number = 300_000): Promise<number> {
    const cutoff = new Date(Date.now() - stuckThresholdMs);
    const result = await db.update(clashMatches)
      .set({ status: "failed", error: "Match timed out — runner did not complete", completedAt: new Date() })
      .where(and(eq(clashMatches.status, "starting"), sql`${clashMatches.startedAt} < ${cutoff}`))
      .returning();
    // Reset any runners stuck on these matches
    for (const match of result) {
      await db.update(clashRunnerPool)
        .set({ state: "idle", currentMatchId: null })
        .where(eq(clashRunnerPool.currentMatchId, match.id));
    }
    return result.length;
  }

  // ==================== CLASH RUNNER ISSUED TOKENS ====================

  async createClashRunnerIssuedToken(token: InsertClashRunnerIssuedToken): Promise<ClashRunnerIssuedToken> {
    const result = await db.insert(clashRunnerIssuedTokens).values(token).returning();
    return result[0];
  }

  async getAllClashRunnerIssuedTokens(): Promise<ClashRunnerIssuedToken[]> {
    return db.select().from(clashRunnerIssuedTokens).orderBy(desc(clashRunnerIssuedTokens.createdAt));
  }

  async getClashRunnerIssuedTokenByHash(tokenHash: string): Promise<ClashRunnerIssuedToken | undefined> {
    const result = await db.select().from(clashRunnerIssuedTokens).where(eq(clashRunnerIssuedTokens.tokenHash, tokenHash));
    return result[0];
  }

  async revokeClashRunnerIssuedToken(id: number): Promise<void> {
    await db.update(clashRunnerIssuedTokens).set({ isRevoked: true }).where(eq(clashRunnerIssuedTokens.id, id));
  }

  async updateClashRunnerIssuedTokenLastUsed(id: number): Promise<void> {
    await db.update(clashRunnerIssuedTokens).set({ lastUsedAt: new Date() }).where(eq(clashRunnerIssuedTokens.id, id));
  }

  // ==================== CLASH TRANSCRIPTS ====================

  async createClashTranscript(data: { clashMatchId: number; speakerLabel: string; text: string; startMs: number; endMs?: number; confidence?: number }): Promise<ClashTranscript> {
    const result = await db.insert(clashTranscripts).values(data).returning();
    return result[0];
  }

  async getClashTranscriptsByMatch(matchId: number): Promise<ClashTranscript[]> {
    return db.select().from(clashTranscripts)
      .where(eq(clashTranscripts.clashMatchId, matchId))
      .orderBy(clashTranscripts.startMs);
  }

  // ==================== CLASH SCHEDULES ====================

  async getClashSchedule(id: number): Promise<ClashSchedule | undefined> {
    const result = await db.select().from(clashSchedules).where(eq(clashSchedules.id, id));
    return result[0];
  }

  async getClashSchedulesByUser(userId: number): Promise<ClashSchedule[]> {
    return db.select().from(clashSchedules)
      .where(eq(clashSchedules.createdBy, userId))
      .orderBy(desc(clashSchedules.createdAt));
  }

  async createClashSchedule(data: InsertClashSchedule): Promise<ClashSchedule> {
    const result = await db.insert(clashSchedules).values(data).returning();
    return result[0];
  }

  async updateClashSchedule(id: number, data: Partial<InsertClashSchedule>): Promise<ClashSchedule | undefined> {
    const result = await db.update(clashSchedules)
      .set({ ...data })
      .where(eq(clashSchedules.id, id))
      .returning();
    return result[0];
  }

  async deleteClashSchedule(id: number): Promise<boolean> {
    const result = await db.delete(clashSchedules).where(eq(clashSchedules.id, id)).returning();
    return result.length > 0;
  }

  async getDueClashSchedules(): Promise<ClashSchedule[]> {
    return db.select().from(clashSchedules)
      .where(
        and(
          eq(clashSchedules.isEnabled, true),
          sql`${clashSchedules.scheduledAt} IS NOT NULL`,
          sql`${clashSchedules.scheduledAt} <= NOW()`
        )
      );
  }

  // ==================== USER STORAGE CONFIG ====================

  async getUserStorageConfig(userId: number): Promise<UserStorageConfig | undefined> {
    const result = await db.select().from(userStorageConfig).where(eq(userStorageConfig.userId, userId));
    return result[0];
  }

  async upsertUserStorageConfig(userId: number, data: Omit<InsertUserStorageConfig, 'userId'>): Promise<UserStorageConfig> {
    const existing = await this.getUserStorageConfig(userId);
    if (existing) {
      const result = await db.update(userStorageConfig)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(userStorageConfig.userId, userId))
        .returning();
      return result[0];
    }
    const result = await db.insert(userStorageConfig).values({ ...data, userId }).returning();
    return result[0];
  }

  async deleteUserStorageConfig(userId: number): Promise<void> {
    await db.delete(userStorageConfig).where(eq(userStorageConfig.userId, userId));
  }

  // ==================== EVAL RESULT ARTIFACTS ====================

  async updateEvalResultArtifacts(evalJobId: number, artifactUrl: string, artifactFiles: unknown): Promise<void> {
    await db.update(evalResults)
      .set({ artifactUrl, artifactFiles, artifactStatus: 'uploaded' })
      .where(eq(evalResults.evalJobId, evalJobId));
  }

  async updateEvalResultArtifactStatus(evalJobId: number, status: string): Promise<void> {
    await db.update(evalResults)
      .set({ artifactStatus: status })
      .where(eq(evalResults.evalJobId, evalJobId));
  }

  async resetStuckArtifactUploads(): Promise<number> {
    const result = await db.update(evalResults)
      .set({ artifactStatus: 'failed' })
      .where(eq(evalResults.artifactStatus, 'uploading'))
      .returning({ id: evalResults.id });
    return result.length;
  }
}

export const storage = new DatabaseStorage();
