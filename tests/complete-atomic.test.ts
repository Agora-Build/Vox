import { describe, it, expect, afterAll } from "vitest";
import { storage, pool } from "../server/storage";

// #94: completing a job used to be two steps — mark it completed, then insert
// its result — with a rollback to 'running' if the insert failed. In between,
// the reap-settle sweep could see "completed, no result" and refund work that
// was done (the 1-minute grace only narrowed that window). Now the job and its
// result commit together, so that state is never visible.
const d = process.env.DATABASE_URL ? describe : describe.skip;
const jobIds: number[] = [];
const tokenIds: number[] = [];

afterAll(async () => {
  if (jobIds.length) await pool.query("DELETE FROM eval_jobs WHERE id = ANY($1)", [jobIds]);
  if (tokenIds.length) {
    await pool.query("DELETE FROM eval_agents WHERE token_id = ANY($1)", [tokenIds]);
    await pool.query("DELETE FROM eval_agent_tokens WHERE id = ANY($1)", [tokenIds]);
  }
});

d("#94 a job and its result are finalized together", () => {
  const mkRunning = async (snapshot: Record<string, unknown> = {}) => {
    const job = await storage.createEvalJob({
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: 1, targetTokenId: null,
      siteId: null, targetRegion: null, targetTier: null, config: {},
      snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null, ...snapshot } as any,
      status: "running", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    jobIds.push(job.id);
    return job;
  };
  const provider = async () => (await storage.getAllProviders())[0].id;

  it("stores the completion and the result as one", async () => {
    const job = await mkRunning();
    const done = await storage.finalizeRunningJobWithResult(job.id, undefined, { evalJobId: job.id, providerId: await provider(), siteId: null, responseLatencyMedian: 900 } as any);
    expect(done).toMatchObject({ status: "completed" });
    expect(await storage.getEvalResultsByJob(job.id)).toHaveLength(1);
  });

  it("a result that can't be stored leaves the job running — never 'completed, no result'", async () => {
    // Paid, so the settlement sweep would act on it if it ever looked completed.
    const job = await mkRunning({ settlementContext: { settlementId: 940001 } });
    await expect(storage.finalizeRunningJobWithResult(job.id, undefined, { evalJobId: job.id, providerId: "no-such-provider", siteId: null } as any))
      .rejects.toThrow();
    const after = (await storage.getEvalJob(job.id))!;
    expect(after).toMatchObject({ status: "running", completedAt: null, error: null });
    expect(await storage.getEvalResultsByJob(job.id)).toEqual([]);
    // So the sweep has nothing to settle.
    const reapable = await storage.getReapableSharedJobs(60, 0, 1000);
    expect(reapable.map((j) => j.id)).not.toContain(job.id);
  });

  it("a duplicate completion stores nothing", async () => {
    const job = await mkRunning();
    const p = await provider();
    await storage.finalizeRunningJobWithResult(job.id, undefined, { evalJobId: job.id, providerId: p, siteId: null } as any);
    expect(await storage.finalizeRunningJobWithResult(job.id, undefined, { evalJobId: job.id, providerId: p, siteId: null } as any)).toBeUndefined();
    expect(await storage.getEvalResultsByJob(job.id)).toHaveLength(1);
  });

  it("a late completion from an agent that lost the job doesn't finish the next agent's run", async () => {
    // The complete route checks the job is this agent's, then finalizes. If the
    // job is requeued and re-claimed in between, the write must not land.
    const tok = await storage.createEvalAgentToken({
      name: `atomic-${Date.now()}`, tokenHash: `atomic-${Date.now()}-${Math.random()}`, siteId: null, dispatchTier: "private", createdBy: 1,
    } as any);
    tokenIds.push(tok.id);
    const first = await storage.createEvalAgent({ tokenId: tok.id, name: "atomic-first", state: "idle", metadata: {} } as any);
    const next = await storage.createEvalAgent({ tokenId: tok.id, name: "atomic-next", state: "occupied", metadata: {} } as any);
    const job = await mkRunning();
    await pool.query("UPDATE eval_jobs SET eval_agent_id = $2 WHERE id = $1", [job.id, next.id]); // re-claimed
    const p = await provider();
    expect(await storage.finalizeRunningJobWithResult(job.id, undefined, { evalJobId: job.id, providerId: p, siteId: null } as any, { agentId: first.id, leaseId: null })).toBeUndefined();
    expect((await storage.getEvalJob(job.id))!).toMatchObject({ status: "running", evalAgentId: next.id, completedAt: null });
    expect(await storage.getEvalResultsByJob(job.id)).toEqual([]);
    // Its current agent still can.
    expect(await storage.finalizeRunningJobWithResult(job.id, undefined, { evalJobId: job.id, providerId: p, siteId: null } as any, { agentId: next.id, leaseId: null })).toMatchObject({ status: "completed" });
    expect(await storage.getEvalResultsByJob(job.id)).toHaveLength(1);
  });

  it("a superseded instance of the same agent doesn't finish the run its successor re-claimed", async () => {
    // Same agent row, re-registered (new lease); the job was requeued and
    // re-claimed by it. The old instance's late completion must not land.
    const tok = await storage.createEvalAgentToken({
      name: `atomic-lease-${Date.now()}`, tokenHash: `atomic-lease-${Date.now()}-${Math.random()}`, siteId: null, dispatchTier: "private", createdBy: 1,
    } as any);
    tokenIds.push(tok.id);
    const agent = await storage.createEvalAgent({ tokenId: tok.id, name: "atomic-lease", state: "occupied", metadata: {} } as any);
    await pool.query("UPDATE eval_agents SET current_lease_id = 'lease-new' WHERE id = $1", [agent.id]);
    const job = await mkRunning();
    await pool.query("UPDATE eval_jobs SET eval_agent_id = $2 WHERE id = $1", [job.id, agent.id]);
    const p = await provider();
    expect(await storage.finalizeRunningJobWithResult(job.id, undefined, { evalJobId: job.id, providerId: p, siteId: null } as any, { agentId: agent.id, leaseId: "lease-old" })).toBeUndefined();
    expect((await storage.getEvalJob(job.id))!).toMatchObject({ status: "running", completedAt: null });
    expect(await storage.getEvalResultsByJob(job.id)).toEqual([]);
    expect(await storage.finalizeRunningJobWithResult(job.id, undefined, { evalJobId: job.id, providerId: p, siteId: null } as any, { agentId: agent.id, leaseId: "lease-new" })).toMatchObject({ status: "completed" });
  });

  it("a failed run is finalized without a result", async () => {
    const job = await mkRunning();
    const done = await storage.finalizeRunningJobWithResult(job.id, "aeval exited 1", null);
    expect(done).toMatchObject({ status: "failed", error: "aeval exited 1" });
    expect(await storage.getEvalResultsByJob(job.id)).toEqual([]);
  });
});
