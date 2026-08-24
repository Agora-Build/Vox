import { describe, it, expect } from "vitest";
import { storage } from "../server/storage";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("tier-targeting schema", () => {
  it("createEvalAgentToken derives region from siteId when absent", async () => {
    const token = await storage.createEvalAgentToken({
      name: `tt-schema-${Date.now()}`,
      tokenHash: `tt-schema-${Date.now()}`,
      siteId: "na-us-ashburn-01",
      createdBy: 1,
    } as any);
    expect(token.region).toBe("na-us-ashburn");
  });

  it("createEvalAgentTokenForLocation stamps region = baseId", async () => {
    const token = await storage.createEvalAgentTokenForLocation("na-us-seattle", {
      name: `tt-mint-${Date.now()}`,
      tokenHash: `tt-mint-${Date.now()}`,
      dispatchTier: "public",
      createdBy: 1,
      isRevoked: false,
    } as any);
    expect(token.region).toBe("na-us-seattle");
    expect(token.siteId.startsWith("na-us-seattle-")).toBe(true);
  });

  it("createEvalJob accepts a site-less pooled job", async () => {
    const job = await storage.createEvalJob({
      workflowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
      siteId: null, targetRegion: "na-us-seattle", targetTier: "public",
      config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    expect(job.siteId).toBeNull();
    expect(job.targetRegion).toBe("na-us-seattle");
    expect(job.targetTier).toBe("public");
  });
});
