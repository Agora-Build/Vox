import { describe, it, expect } from "vitest";
import { storage } from "../server/storage";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("storage.getReapableSharedJobs", () => {
  it("includes recently-failed targeted jobs with settlementContext, excludes those without", async () => {
    // createdBy=1 (admin) and region na-us-ashburn-01 exist after dev-DB init/seed.
    const token = await storage.createEvalAgentToken({
      name: "reap-query-test",
      tokenHash: `reap-test-${Date.now()}`,
      siteId: "na-us-ashburn-01",
      createdBy: 1,
    } as any);

    // Targeted + carries settlementContext → should be returned once failed.
    const included = await storage.createEvalJob({
      workflowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
      siteId: "na-us-ashburn-01", targetTokenId: token.id,
      config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null,
        settlementContext: { settlementId: 424242 } } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);

    // Targeted but NO settlementContext → must be excluded.
    const excluded = await storage.createEvalJob({
      workflowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
      siteId: "na-us-ashburn-01", targetTokenId: token.id,
      config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);

    // Make both genuinely failed with a fresh completed_at (completeEvalJob sets
    // status=failed + completedAt=now on any job, unlike finalizeRunningJob which
    // only touches running jobs).
    await storage.completeEvalJob(included.id, "boom");
    await storage.completeEvalJob(excluded.id, "boom");

    // COMPLETED + settlementContext → must ALSO be returned (review C1: a
    // completed-but-unsettled job must be re-driven for capture, not left to the
    // leak-reaper). completeEvalJob sets status=failed, so drive completed via the
    // running→completed transition.
    const includedCompleted = await storage.createEvalJob({
      workflowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
      siteId: "na-us-ashburn-01", targetTokenId: token.id,
      config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null,
        settlementContext: { settlementId: 424243 } } as any,
      status: "running", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    await storage.finalizeRunningJob(includedCompleted.id, undefined); // running → completed

    // graceMinutes=0 → no grace exclusion, so jobs completed just now are eligible.
    const rows = await storage.getReapableSharedJobs(60, 0, 500);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(included.id);      // the real assertion: query returns it
    expect(ids).not.toContain(excluded.id);  // no settlementContext → excluded
    expect(ids).toContain(includedCompleted.id); // completed jobs are reapable too (C1)
  });

  it("grace period excludes a job that turned terminal too recently (GitHub #90)", async () => {
    const token = await storage.createEvalAgentToken({
      name: "reap-grace-test",
      tokenHash: `reap-grace-${Date.now()}`,
      siteId: "na-us-ashburn-01",
      createdBy: 1,
    } as any);

    // A completed, targeted, settlement-bearing job — the money path. Drive it
    // through running→completed so its completed_at is ~now (inside the grace window).
    const job = await storage.createEvalJob({
      workflowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
      siteId: "na-us-ashburn-01", targetTokenId: token.id,
      config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null,
        settlementContext: { settlementId: 909090 } } as any,
      status: "running", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    await storage.finalizeRunningJob(job.id, undefined); // running → completed, completed_at=now

    // With a 1-minute grace, a just-completed job must NOT be swept: this is the
    // window where its evalResults row may not be written yet, so settling now would
    // refund a valid job. It is excluded until it ages past the grace.
    const withGrace = await storage.getReapableSharedJobs(60, 1, 500);
    expect(withGrace.map((r) => r.id)).not.toContain(job.id);

    // Same job with no grace IS eligible — proves the exclusion is the grace bound,
    // not some other filter.
    const noGrace = await storage.getReapableSharedJobs(60, 0, 500);
    expect(noGrace.map((r) => r.id)).toContain(job.id);
  });

  it("returns candidates oldest-first so a backlog drains before aging out (#7)", async () => {
    const token = await storage.createEvalAgentToken({
      name: "reap-order-test",
      tokenHash: `reap-order-${Date.now()}`,
      siteId: "na-us-ashburn-01",
      createdBy: 1,
    } as any);

    // Seed two targeted, settlement-bearing jobs and finalize them in sequence so
    // this test proves ordering on its OWN rows rather than relying on state left by
    // earlier tests in this describe (which would let it pass vacuously if they were
    // removed or reordered). Two awaited finalizes give distinct completed_at.
    const first = await storage.createEvalJob({
      workflowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
      siteId: "na-us-ashburn-01", targetTokenId: token.id,
      config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null,
        settlementContext: { settlementId: 707071 } } as any,
      status: "running", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    await storage.finalizeRunningJob(first.id, undefined);
    const second = await storage.createEvalJob({
      workflowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
      siteId: "na-us-ashburn-01", targetTokenId: token.id,
      config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null,
        settlementContext: { settlementId: 707072 } } as any,
      status: "running", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    await storage.finalizeRunningJob(second.id, undefined);

    const rows = await storage.getReapableSharedJobs(60, 0, 500);
    // Not vacuous: our two seeded rows must be present.
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const times = rows.map((r) => (r.completedAt as Date).getTime());
    const sorted = [...times].sort((a, b) => a - b);
    expect(times).toEqual(sorted); // completed_at ascending (robust to equal-time ties)
  });
});
