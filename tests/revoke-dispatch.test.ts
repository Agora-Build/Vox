import { describe, it, expect, afterAll } from "vitest";
import { storage, pool } from "../server/storage";

// #214: a job aimed at one agent is created only while that agent's token is
// live. The token row is locked for the insert, so a revoke and a dispatch
// can't interleave: the dispatch either sees the revoke (no job) or its job
// exists before the revoke fails it.
const d = process.env.DATABASE_URL ? describe : describe.skip;
const jobIds: number[] = [];
const tokenIds: number[] = [];

afterAll(async () => {
  if (jobIds.length) await pool.query("DELETE FROM eval_jobs WHERE id = ANY($1)", [jobIds]);
  if (tokenIds.length) await pool.query("DELETE FROM eval_agent_tokens WHERE id = ANY($1)", [tokenIds]);
});

d("#214 dispatch vs revoke", () => {
  const mkToken = async () => {
    const t = await storage.createEvalAgentToken({ name: `revoke-race-${Date.now()}`, tokenHash: `revoke-race-${Date.now()}-${Math.random()}`, siteId: null, dispatchTier: "shared", createdBy: 1 } as any);
    tokenIds.push(t.id);
    return t;
  };
  const values = (tokenId: number) => ({
    evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: 2, targetTokenId: tokenId,
    siteId: null, targetRegion: null, targetTier: null, config: {},
    snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null },
    status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
  }) as any;

  it("creates the job while the token is live", async () => {
    const t = await mkToken();
    const job = await storage.createEvalJobForLiveToken(values(t.id), t.id);
    expect(job).not.toBeNull();
    jobIds.push(job!.id);
  });

  it("refuses once the token is revoked: no job", async () => {
    const t = await mkToken();
    await storage.revokeEvalAgentToken(t.id);
    expect(await storage.createEvalJobForLiveToken(values(t.id), t.id)).toBeNull();
    expect((await pool.query("SELECT count(*)::int c FROM eval_jobs WHERE target_token_id = $1", [t.id])).rows[0].c).toBe(0);
  });

  it("a revoke fails the token's queued jobs (and only those)", async () => {
    const t = await mkToken();
    const queued = (await storage.createEvalJobForLiveToken(values(t.id), t.id))!;
    jobIds.push(queued.id);
    const other = await mkToken();
    const bystander = (await storage.createEvalJobForLiveToken(values(other.id), other.id))!;
    jobIds.push(bystander.id);
    await storage.revokeEvalAgentToken(t.id);
    const failed = await storage.failPendingJobsForToken(t.id);
    expect(failed.map((j) => j.id)).toEqual([queued.id]);
    expect(await storage.getEvalJob(queued.id)).toMatchObject({ status: "failed", error: "Its eval agent was revoked before it could run this." });
    expect((await storage.getEvalJob(bystander.id))!.status).toBe("pending");
  });
});
