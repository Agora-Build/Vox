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

  // Fix round 2, item 1: the pooled SQL arm must carry its own `target_token_id
  // IS NULL` guard (the arms are OR'd in SQL, unlike isClaimable()'s early
  // return) — otherwise a malformed row with BOTH targetTokenId and
  // targetRegion/targetTier set would leak to any in-region pool claimer.
  // App-level invariant only (no CHECK constraint), hence the direct insert.
  it("divergence guard: a row with BOTH targetTokenId and targetRegion is never claimed via the pool arm", async () => {
    const otherTok = await mkToken(`tp-other-${Date.now()}`, "na-us-ashburn-01");
    const pubTok = await mkToken(`tp-divpub-${Date.now()}`, "na-us-ashburn-01");
    const job = await storage.createEvalJob({
      workflowId: null, triggerType: 2, evalSetId: null, createdBy: 2,
      siteId: null, targetTokenId: otherTok.id, targetRegion: "na-us-ashburn", targetTier: "public",
      config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    const arg = { id: pubTok.id, siteId: pubTok.siteId, region: pubTok.region, dispatchTier: pubTok.dispatchTier, createdBy: pubTok.createdBy, ownerOrgId: null };
    expect((await storage.getClaimableJobsForToken(arg)).map(j => j.id)).not.toContain(job.id);
    const agent = await storage.createEvalAgent({ tokenId: pubTok.id, name: `tp-divagent-${Date.now()}`, siteId: pubTok.siteId, state: "idle", metadata: {} } as any);
    expect(await storage.claimEvalJob(job.id, agent.id, arg)).toBeUndefined();
  });

  // Fix round 2, item 3: the team arm is security-critical (org-boundary
  // mutual consent) and had no SQL-level test.
  it("team pool: mutual consent at the SQL layer — org-mate's team token claims; org-mate's private token does not", async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const org = await storage.createOrganization({ name: `tp-org-${suffix}` } as any);
    const userA = await storage.createUser({ username: `tpA${suffix}`, email: `tpA${suffix}@example.com`, organizationId: org.id } as any);
    const userB = await storage.createUser({ username: `tpB${suffix}`, email: `tpB${suffix}@example.com`, organizationId: org.id } as any);

    // (a) B's TEAM-tier token, in-region, ownerOrgId = the shared org: lists + claims.
    const teamJob = await mkPooledJob("na-us-ashburn", "team", userA.id);
    const teamTok = await mkToken(`tp-team-${suffix}`, "na-us-ashburn-01", "team", userB.id);
    const teamArg = { id: teamTok.id, siteId: teamTok.siteId, region: teamTok.region, dispatchTier: teamTok.dispatchTier, createdBy: teamTok.createdBy, ownerOrgId: org.id };
    expect((await storage.getClaimableJobsForToken(teamArg)).map(j => j.id)).toContain(teamJob.id);
    const teamAgent = await storage.createEvalAgent({ tokenId: teamTok.id, name: `tp-teamagent-${suffix}`, siteId: teamTok.siteId, state: "idle", metadata: {} } as any);
    const claimed = await storage.claimEvalJob(teamJob.id, teamAgent.id, teamArg);
    expect(claimed).toBeDefined();

    // (b) B's PRIVATE-tier token, same org, same region: does NOT (mutual consent —
    // the owner offered only 'private', which isn't in the job's team/public ask).
    const privJob = await mkPooledJob("na-us-ashburn", "team", userA.id);
    const privTok = await mkToken(`tp-teampriv-${suffix}`, "na-us-ashburn-01", "private", userB.id);
    const privArg = { id: privTok.id, siteId: privTok.siteId, region: privTok.region, dispatchTier: privTok.dispatchTier, createdBy: privTok.createdBy, ownerOrgId: org.id };
    expect((await storage.getClaimableJobsForToken(privArg)).map(j => j.id)).not.toContain(privJob.id);
  });
});

d("getEvalJobs region filter", () => {
  it("matches exact-region sites and pending pooled rows, NOT prefix-colliding baseIds", async () => {
    // Storage-level rows bypass catalog validation, so a prefix-colliding
    // sibling baseId (na-us-ashburn vs na-us-ashburn-west) can be simulated
    // directly. A bare LIKE 'base-%' would wrongly match the sibling's site.
    const mk = (siteId: string | null, targetRegion: string | null) =>
      storage.createEvalJob({
        workflowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
        siteId, targetRegion, targetTier: targetRegion ? "public" : null,
        config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
        status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
      } as any);
    const claimed = await mk("na-us-ashburn-01", null);
    const pooled = await mk(null, "na-us-ashburn");
    const collider = await mk("na-us-ashburn-west-01", null);
    const otherPool = await mk(null, "na-us-ashburn-west");

    const rows = await storage.getEvalJobs({ region: "na-us-ashburn", limit: 1000 });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(claimed.id);
    expect(ids).toContain(pooled.id);
    expect(ids).not.toContain(collider.id);   // prefix collision guarded
    expect(ids).not.toContain(otherPool.id);
  });
});
