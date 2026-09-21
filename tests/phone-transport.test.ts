import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage, pool, buildJobSnapshot } from "../server/storage";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

// Phase A of Phone vs Agent (designs/2026-09-21-phone-vs-agent-design.md §3/§8):
// the transport axis is frozen per job at creation (creator_org_id pattern) and
// phone jobs are claimable only by agents declaring the "phone" capability.
// Seeding style mirrors tests/org-claim-stamp.test.ts (raw dev-DB seeding).

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

d("phone transport — snapshot + frozen job stamp", () => {
  let userId: number;
  let workflowId: number;
  let jobId: number;

  beforeAll(async () => {
    userId = (await storage.createUser({
      username: `phA${suffix}`, email: `phA${suffix}@example.com`,
    } as any)).id;
  });

  afterAll(async () => {
    if (!hasDb) return;
    if (jobId) await pool.query(`DELETE FROM eval_jobs WHERE id = $1`, [jobId]);
    if (workflowId) await pool.query(`DELETE FROM workflows WHERE id = $1`, [workflowId]);
    if (userId) await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  it("freezes transport at job creation; later workflow edits don't rewrite it", async () => {
    const providers = await storage.getAllProviders();
    expect(providers.length).toBeGreaterThan(0);

    const wf = await storage.createWorkflow({
      name: `phA-wf-${suffix}`, ownerId: userId, providerId: providers[0].id,
      transport: "phone", visibility: "private", config: {},
    } as any);
    workflowId = wf.id;
    expect(wf.transport).toBe("phone");

    const snap = buildJobSnapshot(wf, null, providers[0], "principal");
    expect(snap.transport).toBe("phone");

    const job = await storage.createEvalJob({
      workflowId: wf.id, triggerType: 2, evalSetId: null, createdBy: userId,
      siteId: null, targetRegion: "na-us-ashburn", targetTier: "private",
      config: {}, snapshot: snap,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    jobId = job.id;
    expect(job.transport).toBe("phone"); // stamped column

    // Edit the live workflow — the frozen job must not move.
    await storage.updateWorkflow(wf.id, { transport: "web" } as any);
    const reread = await storage.getEvalJob(job.id);
    expect(reread!.transport).toBe("phone");
    expect((reread!.snapshot as any).transport).toBe("phone");
  });

  it("defaults to web when the workflow has no transport", async () => {
    const providers = await storage.getAllProviders();
    const wf = await storage.createWorkflow({
      name: `phA-wf-web-${suffix}`, ownerId: userId, providerId: providers[0].id,
      visibility: "private", config: {},
    } as any);
    try {
      expect(wf.transport).toBe("web");
      const snap = buildJobSnapshot(wf, null, providers[0], "basic");
      expect(snap.transport).toBe("web");
    } finally {
      await pool.query(`DELETE FROM workflows WHERE id = $1`, [wf.id]);
    }
  });
});
