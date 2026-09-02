import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { storage, db, hashToken } from "../server/storage";
import { evalAgents, evalAgentTokens, evalJobs } from "../shared/schema";
import { BASE_NA } from "./helpers/regions";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("zero-trust claim gating", () => {
  let tokenId: number; let agentId: number;
  const jobIds: number[] = [];

  const identity = (over: Partial<{ siteId: string | null; region: string | null; locationTrust: string }> = {}) => ({
    id: tokenId, siteId: null as string | null, region: null as string | null,
    dispatchTier: "private", createdBy: 1, ownerOrgId: null, locationTrust: "unknown", ...over,
  });

  const makeJob = async (fields: Partial<typeof evalJobs.$inferInsert>) => {
    const row = await db.insert(evalJobs).values({
      workflowId: null, evalSetId: null, createdBy: 1, status: "pending",
      config: {}, snapshot: {}, siteId: null, ...fields,
    } as typeof evalJobs.$inferInsert).returning();
    jobIds.push(row[0].id);
    return row[0];
  };

  beforeAll(async () => {
    const t = await db.insert(evalAgentTokens).values({
      name: "zt-claim", tokenHash: hashToken(`zt-claim-${Date.now()}`),
      dispatchTier: "private", createdBy: 1, isRevoked: false, siteId: null, region: null,
    }).returning();
    tokenId = t[0].id;
    const a = await db.insert(evalAgents).values({ name: "zt-claim-agent", tokenId, siteId: null, state: "idle" }).returning();
    agentId = a[0].id;
  });
  afterAll(async () => {
    if (jobIds.length) await db.delete(evalJobs).where(inArray(evalJobs.id, jobIds));
    await db.delete(evalAgents).where(eq(evalAgents.id, agentId));
    await db.delete(evalAgentTokens).where(eq(evalAgentTokens.id, tokenId));
  });

  it("an Unverified agent (region NULL) cannot see or claim a region-pooled job", async () => {
    const job = await makeJob({ targetRegion: BASE_NA, targetTier: "private" });
    const visible = await storage.getClaimableJobsForToken(identity());
    expect(visible.map(j => j.id)).not.toContain(job.id);
    expect(await storage.claimEvalJob(job.id, agentId, identity())).toBeUndefined();
  });

  it("a trusted agent in the pool region claims it, freezing location_trust + its siteId", async () => {
    const job = await makeJob({ targetRegion: BASE_NA, targetTier: "private" });
    const id = identity({ region: BASE_NA, siteId: `${BASE_NA}-77`, locationTrust: "trusted" });
    const visible = await storage.getClaimableJobsForToken(id);
    expect(visible.map(j => j.id)).toContain(job.id);
    const claimed = await storage.claimEvalJob(job.id, agentId, id);
    expect(claimed?.siteId).toBe(`${BASE_NA}-77`);
    expect(claimed?.locationTrust).toBe("trusted");
  });

  it("a targeted job IS claimable by an Unverified agent — siteId stays NULL, trust frozen", async () => {
    const job = await makeJob({ targetTokenId: tokenId });
    const claimed = await storage.claimEvalJob(job.id, agentId, identity({ locationTrust: "anonymized" }));
    expect(claimed).toBeDefined();
    expect(claimed?.siteId).toBeNull();
    expect(claimed?.locationTrust).toBe("anonymized");
  });
});
