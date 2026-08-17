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
      region: "na-us-ashburn-01",
      createdBy: 1,
    } as any);

    // Targeted + carries settlementContext → should be returned once failed.
    const included = await storage.createEvalJob({
      workflowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
      region: "na-us-ashburn-01", targetTokenId: token.id,
      config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null,
        settlementContext: { settlementId: 424242 } } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);

    // Targeted but NO settlementContext → must be excluded.
    const excluded = await storage.createEvalJob({
      workflowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
      region: "na-us-ashburn-01", targetTokenId: token.id,
      config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);

    // Make both genuinely failed with a fresh completed_at (completeEvalJob sets
    // status=failed + completedAt=now on any job, unlike finalizeRunningJob which
    // only touches running jobs).
    await storage.completeEvalJob(included.id, "boom");
    await storage.completeEvalJob(excluded.id, "boom");

    const rows = await storage.getReapableSharedJobs(60, 500);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(included.id);      // the real assertion: query returns it
    expect(ids).not.toContain(excluded.id);  // no settlementContext → excluded
  });
});
