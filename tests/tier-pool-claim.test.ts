import { describe, it, expect } from "vitest";
import { storage } from "../server/storage";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

// admin (id 1) exists after dev-DB init. Tokens created via createEvalAgentToken
// derive region from siteId (Task 1).
const mkToken = (name: string, siteId: string, tier = "public", createdBy = 1) =>
  storage.createEvalAgentToken({
    name, tokenHash: `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    siteId, dispatchTier: tier, createdBy,
  } as any);

const mkPooledJob = (targetRegion: string, targetTier: string, createdBy = 1) =>
  storage.createEvalJob({
    workflowId: null, triggerType: 2, evalSetId: null, createdBy,
    siteId: null, targetRegion, targetTier,
    config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
    status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
  } as any);

d("pooled claim SQL mirrors isClaimable", () => {
  it("public pool: in-region public token lists+claims and stamps its site", async () => {
    const tok = await mkToken(`tp-pub-${Date.now()}`, "na-us-ashburn-01");
    const job = await mkPooledJob("na-us-ashburn", "public", 2); // creator 2 = scout
    const arg = { id: tok.id, siteId: tok.siteId, region: tok.region, dispatchTier: tok.dispatchTier, createdBy: tok.createdBy, ownerOrgId: null };
    const listed = await storage.getClaimableJobsForToken(arg);
    expect(listed.map(j => j.id)).toContain(job.id);
    const agent = await storage.createEvalAgent({ tokenId: tok.id, name: `tp-a-${Date.now()}`, siteId: tok.siteId, state: "idle", metadata: {} } as any);
    const claimed = await storage.claimEvalJob(job.id, agent.id, arg);
    expect(claimed).toBeDefined();
    expect(claimed!.siteId).toBe(tok.siteId); // pooled job stamped at claim
    expect(claimed!.tokenDispatchTier).toBe("public");
  });

  it("region mismatch: out-of-region token neither lists nor claims", async () => {
    const tok = await mkToken(`tp-eu-${Date.now()}`, "eu-de-frankfurt-01");
    const job = await mkPooledJob("na-us-ashburn", "public", 2);
    const arg = { id: tok.id, siteId: tok.siteId, region: tok.region, dispatchTier: tok.dispatchTier, createdBy: tok.createdBy, ownerOrgId: null };
    expect((await storage.getClaimableJobsForToken(arg)).map(j => j.id)).not.toContain(job.id);
    const agent = await storage.createEvalAgent({ tokenId: tok.id, name: `tp-ae-${Date.now()}`, siteId: tok.siteId, state: "idle", metadata: {} } as any);
    expect(await storage.claimEvalJob(job.id, agent.id, arg)).toBeUndefined();
  });

  it("private pool: own token (any tier) claims; stranger's token does not", async () => {
    const mine = await mkToken(`tp-mine-${Date.now()}`, "na-us-ashburn-01", "private", 1);
    const job = await mkPooledJob("na-us-ashburn", "private", 1);
    const strangerTok = await mkToken(`tp-str-${Date.now()}`, "na-us-ashburn-01", "public", 2);
    const strangerArg = { id: strangerTok.id, siteId: strangerTok.siteId, region: strangerTok.region, dispatchTier: strangerTok.dispatchTier, createdBy: strangerTok.createdBy, ownerOrgId: null };
    expect((await storage.getClaimableJobsForToken(strangerArg)).map(j => j.id)).not.toContain(job.id);
    const mineArg = { id: mine.id, siteId: mine.siteId, region: mine.region, dispatchTier: mine.dispatchTier, createdBy: mine.createdBy, ownerOrgId: null };
    expect((await storage.getClaimableJobsForToken(mineArg)).map(j => j.id)).toContain(job.id);
  });

  it("reaper: pooled pending job is NOT fast-failed by the no-agent sweep; site-pinned is", async () => {
    const pooled = await mkPooledJob("sa-br-saopaulo", "public", 2); // region with no online agent
    const pinned = await storage.createEvalJob({
      workflowId: null, triggerType: 2, evalSetId: null, createdBy: 2,
      siteId: "sa-br-saopaulo-01", targetRegion: null, targetTier: null,
      config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    // timeoutMinutes=0: everything pending is past the cutoff immediately.
    await storage.failPendingJobsWithNoAgent(0, 5);
    const pooledAfter = await storage.getEvalJob(pooled.id);
    const pinnedAfter = await storage.getEvalJob(pinned.id);
    expect(pooledAfter!.status).toBe("pending"); // pools are queues (spec §7)
    expect(pinnedAfter!.status).toBe("failed");  // site-pinned keeps the fast-fail
  });

  it("legacy site-pinned row still claimable under the old arm", async () => {
    const tok = await mkToken(`tp-leg-${Date.now()}`, "na-us-ashburn-01");
    const job = await storage.createEvalJob({
      workflowId: null, triggerType: 2, evalSetId: null, createdBy: 2,
      siteId: "na-us-ashburn-01", targetRegion: null, targetTier: null,
      config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    const arg = { id: tok.id, siteId: tok.siteId, region: tok.region, dispatchTier: tok.dispatchTier, createdBy: tok.createdBy, ownerOrgId: null };
    expect((await storage.getClaimableJobsForToken(arg)).map(j => j.id)).toContain(job.id);
  });
});
