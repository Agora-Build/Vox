import { describe, it, expect, afterAll } from "vitest";
import { storage, pool } from "../server/storage";

// #94: completing a job used to be two steps — mark it completed, then insert
// its result — with a rollback to 'running' if the insert failed. In between,
// the reap-settle sweep could see "completed, no result" and refund work that
// was done (the 1-minute grace only narrowed that window). Now the job and its
// result commit together, so that state is never visible.
const d = process.env.DATABASE_URL ? describe : describe.skip;
const jobIds: number[] = [];

afterAll(async () => {
  if (jobIds.length) await pool.query("DELETE FROM eval_jobs WHERE id = ANY($1)", [jobIds]);
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

  it("a failed run is finalized without a result", async () => {
    const job = await mkRunning();
    const done = await storage.finalizeRunningJobWithResult(job.id, "aeval exited 1", null);
    expect(done).toMatchObject({ status: "failed", error: "aeval exited 1" });
    expect(await storage.getEvalResultsByJob(job.id)).toEqual([]);
  });
});
