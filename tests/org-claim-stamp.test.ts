import { describe, it, expect, beforeAll } from "vitest";
import { storage } from "../server/storage";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

// Factories mirror tests/tier-pool-claim.test.ts (same dev-DB seeding style).
const mkToken = (name: string, siteId: string, tier: string, createdBy: number) =>
  storage.createEvalAgentToken({
    name, tokenHash: `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    siteId, dispatchTier: tier, createdBy,
  } as any);

const mkTeamJob = (createdBy: number, creatorOrgId: number | null) =>
  storage.createEvalJob({
    workflowId: null, triggerType: 2, evalSetId: null, createdBy,
    siteId: null, targetRegion: "na-us-ashburn", targetTier: "team",
    creatorOrgId,
    config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
    status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
  } as any);

d("R2: claimability is frozen at creation (design §11, pinned semantic change)", () => {
  let orgId: number, creatorId: number, tokenArg: any, agentId: number;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const org = await storage.createOrganization({ name: `r2-org-${suffix}` } as any);
    orgId = org.id;
    creatorId = (await storage.createUser({
      username: `r2c${suffix}`, email: `r2c${suffix}@example.com`, organizationId: orgId,
    } as any)).id;
    const memberId = (await storage.createUser({
      username: `r2m${suffix}`, email: `r2m${suffix}@example.com`, organizationId: orgId,
    } as any)).id;
    // The claiming side stays in the org throughout — only the CREATOR leaves.
    const tok = await mkToken(`r2-team-${suffix}`, "na-us-ashburn-01", "team", memberId);
    tokenArg = {
      id: tok.id, siteId: tok.siteId, region: tok.region, dispatchTier: tok.dispatchTier,
      createdBy: tok.createdBy, ownerOrgId: orgId, locationTrust: "trusted",
    };
    agentId = (await storage.createEvalAgent({
      tokenId: tok.id, name: `r2-agent-${suffix}`, siteId: tok.siteId, state: "idle", metadata: {},
    } as any)).id;
  });

  it("a pending team job stays claimable after its creator leaves the org", async () => {
    const job = await mkTeamJob(creatorId, orgId); // the stamp — seam-resolved at the real creation sites
    await storage.removeUserFromOrganization(creatorId); // creator leaves AFTER creation
    expect((await storage.getClaimableJobsForToken(tokenArg)).map((j) => j.id)).toContain(job.id);
    const claimed = await storage.claimEvalJob(job.id, agentId, tokenArg);
    expect(claimed?.id).toBe(job.id); // frozen: still claimable (was: unclaimable once the creator left)
  });

  it("a team job stamped with creatorOrgId null is never claimable via the team arm", async () => {
    const job = await mkTeamJob(creatorId, null);
    expect((await storage.getClaimableJobsForToken(tokenArg)).map((j) => j.id)).not.toContain(job.id);
    expect(await storage.claimEvalJob(job.id, agentId, tokenArg)).toBeUndefined();
  });
});
