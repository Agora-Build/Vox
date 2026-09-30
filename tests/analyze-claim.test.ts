import { describe, it, expect, afterAll } from "vitest";
import { storage, pool } from "../server/storage";

// Tools → Analyze claim rule on the real SQL (design 2026-09-30). Mirrors
// permissions.isClaimable (tests/permissions-dispatch.test.ts): an analyze job
// goes to an analyze-capable agent the uploader may use — public, or their
// own — never a marketplace agent; region and site play no part.
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const UPLOADER = 2; // scout, exists after dev-DB init
const OTHER = 1;    // admin
const jobIds: number[] = [];
const tokenIds: number[] = [];

afterAll(async () => {
  if (!hasDb) return;
  if (jobIds.length) await pool.query("DELETE FROM eval_jobs WHERE id = ANY($1)", [jobIds]);
  if (tokenIds.length) {
    await pool.query("DELETE FROM eval_agents WHERE token_id = ANY($1)", [tokenIds]);
    await pool.query("DELETE FROM eval_agent_tokens WHERE id = ANY($1)", [tokenIds]);
  }
});

const mkToken = async (tier: string, createdBy: number, siteId = "eu-de-frankfurt-01") => {
  const t = await storage.createEvalAgentToken({
    name: `analyze-claim-${tier}-${Date.now()}`, tokenHash: `analyze-claim-${Date.now()}-${Math.random()}`,
    siteId, dispatchTier: tier, createdBy,
  } as any);
  tokenIds.push(t.id);
  return t;
};
const identity = (t: { id: number; siteId: string | null; region: string | null; dispatchTier: string; createdBy: number }, analyzeCapable: boolean) => ({
  id: t.id, siteId: t.siteId, region: t.region, dispatchTier: t.dispatchTier, createdBy: t.createdBy,
  ownerOrgId: null, locationTrust: "trusted", analyzeCapable,
});
const mkAnalyzeJob = async (createdBy = UPLOADER, transport: "web" | "phone" = "web") => {
  const j = await storage.createEvalJob({
    kind: "analyze", evalFlowId: null, triggerType: 2, evalSetId: null, createdBy,
    siteId: null, targetRegion: null, targetTier: null, config: {},
    snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null, transport } as any,
    status: "pending", priority: -10, retryCount: 0, maxRetries: 3,
  } as any);
  jobIds.push(j.id);
  return j;
};
const listed = async (t: Parameters<typeof identity>[0], capable: boolean) =>
  (await storage.getClaimableJobsForToken(identity(t, capable))).map((j) => j.id);

d("analyze jobs: who may claim them (real SQL)", () => {
  it("a capable public agent lists and claims it, and the job stays without a site", async () => {
    const job = await mkAnalyzeJob();
    const tok = await mkToken("public", OTHER);
    expect(await listed(tok, true)).toContain(job.id);
    const agent = await storage.createEvalAgent({ tokenId: tok.id, name: `analyze-a-${Date.now()}`, siteId: tok.siteId, state: "idle", metadata: {} } as any);
    const claimed = await storage.claimEvalJob(job.id, agent.id, identity(tok, true));
    expect(claimed).toMatchObject({ status: "running", siteId: null });
  });

  it("the uploader's own private agent claims it", async () => {
    const job = await mkAnalyzeJob();
    const tok = await mkToken("private", UPLOADER);
    expect(await listed(tok, true)).toContain(job.id);
    const agent = await storage.createEvalAgent({ tokenId: tok.id, name: `analyze-own-${Date.now()}`, siteId: tok.siteId, state: "idle", metadata: {} } as any);
    expect(await storage.claimEvalJob(job.id, agent.id, identity(tok, true))).toBeDefined();
  });

  it("someone else's private agent, a marketplace agent, and an incapable agent don't", async () => {
    const job = await mkAnalyzeJob();
    const strangers = [
      { tok: await mkToken("private", OTHER), capable: true },
      { tok: await mkToken("shared", OTHER), capable: true },
      { tok: await mkToken("shared", UPLOADER), capable: true }, // even the uploader's own listing
      { tok: await mkToken("public", OTHER), capable: false },
    ];
    for (const { tok, capable } of strangers) {
      expect(await listed(tok, capable)).not.toContain(job.id);
      const agent = await storage.createEvalAgent({ tokenId: tok.id, name: `analyze-no-${Date.now()}`, siteId: tok.siteId, state: "idle", metadata: {} } as any);
      expect(await storage.claimEvalJob(job.id, agent.id, identity(tok, capable))).toBeUndefined();
    }
  });

  it("a phone recording doesn't need a phone-capable agent: the call already happened", async () => {
    const job = await mkAnalyzeJob(UPLOADER, "phone");
    expect(job.transport).toBe("phone");
    const tok = await mkToken("public", OTHER);
    expect(await listed(tok, true)).toContain(job.id); // phoneCapable not passed
    const agent = await storage.createEvalAgent({ tokenId: tok.id, name: `analyze-ph-${Date.now()}`, siteId: tok.siteId, state: "idle", metadata: {} } as any);
    expect(await storage.claimEvalJob(job.id, agent.id, identity(tok, true))).toBeDefined();
  });

  it("an agent takes a waiting eval run before an analysis", async () => {
    const tok = await mkToken("public", OTHER, "na-us-ashburn-01");
    const analyze = await mkAnalyzeJob();
    const evalJob = await storage.createEvalJob({
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: UPLOADER,
      siteId: null, targetRegion: "na-us-ashburn", targetTier: "public", config: {},
      snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    jobIds.push(evalJob.id);
    const ids = await listed(tok, true);
    expect(ids).toContain(analyze.id);
    expect(ids.indexOf(evalJob.id)).toBeLessThan(ids.indexOf(analyze.id));
  });

  it("the no-agent reaper leaves an analysis alone", async () => {
    const job = await mkAnalyzeJob();
    await pool.query(`UPDATE eval_jobs SET created_at = now() - interval '20 minutes', updated_at = now() - interval '20 minutes' WHERE id = $1`, [job.id]);
    await storage.failPendingJobsWithNoAgent(15, 5, true);
    expect(await storage.getEvalJob(job.id)).toMatchObject({ status: "pending", unclaimedCount: 0 });
  });
});
