import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage, pool } from "../server/storage";

// Tools → Analyze visibility on the real SQL (design 2026-09-30): an analysis
// is hidden from the Eval Jobs lists, never on the public boards, and shows in
// its creator's My Evals under the region they stated.
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const ME = 2;    // scout
const OTHER = 1; // admin
const REGION = "na-us-seattle";
const jobIds: number[] = [];

let analyzeJobId: number;
let analyzeResultId: number;
let evalJobId: number;

afterAll(async () => {
  if (hasDb && jobIds.length) await pool.query("DELETE FROM eval_jobs WHERE id = ANY($1)", [jobIds]);
});

d("analyze results: where they show (real SQL)", () => {
  beforeAll(async () => {
    const provider = (await storage.getAllProviders())[0];
    // Snapshot deliberately dressed as public + mainline + principal on a
    // public agent: only kind keeps it off the public boards.
    const publicLooking = {
      provider: { id: provider.id, name: provider.name, platformId: provider.platformId ?? null },
      evalFlow: { name: "x", config: {}, visibility: "public", isMainline: true, ownerId: ME, organizationId: null },
      evalSet: { name: "x", config: {}, visibility: "public", isMainline: true, ownerId: ME },
      creatorPlan: "principal",
      transport: "web",
    };
    const a = await storage.createEvalJob({
      kind: "analyze", evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: ME,
      siteId: null, targetRegion: null, targetTier: null, config: {}, snapshot: publicLooking as any,
      status: "completed", priority: -10, retryCount: 0, maxRetries: 3, tokenDispatchTier: "public",
    } as any);
    analyzeJobId = a.id; jobIds.push(a.id);
    analyzeResultId = (await storage.createEvalResult({
      evalJobId: a.id, providerId: provider.id, siteId: null, recordingRegion: REGION, responseLatencyMedian: 900,
    } as any)).id;
    // Control: an ordinary job of the same user.
    const e = await storage.createEvalJob({
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: ME,
      siteId: "na-us-seattle-01", targetRegion: null, targetTier: null, config: {},
      snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null } as any,
      status: "completed", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    evalJobId = e.id; jobIds.push(e.id);
  });

  const has = (rows: Array<{ id: number }>) => rows.some((r) => r.id === analyzeResultId);

  it("is left out of the Eval Jobs list and count", async () => {
    const jobs = await storage.getEvalJobs({ ownerId: ME, limit: 500 });
    expect(jobs.map((j) => j.id)).toContain(evalJobId); // control
    expect(jobs.map((j) => j.id)).not.toContain(analyzeJobId);
    const withBoth = await storage.countEvalJobs({ ownerId: ME });
    await pool.query("UPDATE eval_jobs SET kind = 'eval' WHERE id = $1", [analyzeJobId]);
    expect(await storage.countEvalJobs({ ownerId: ME })).toBe(withBoth + 1);
    await pool.query("UPDATE eval_jobs SET kind = 'analyze' WHERE id = $1", [analyzeJobId]);
  });

  it("is in its creator's My Evals, in the transport they chose only", async () => {
    expect(has(await storage.getMyEvalMetrics(ME, 24, undefined, "web"))).toBe(true);
    expect(has(await storage.getMyEvalMetrics(ME, 24, undefined, "phone"))).toBe(false);
    expect(has(await storage.getMyEvalMetrics(OTHER, 24, undefined, "web"))).toBe(false);
  });

  it("never reaches Mainline or Community, however public it looks", async () => {
    expect(has(await storage.getMainlineMetrics(24, undefined, "web"))).toBe(false);
    expect(has(await storage.getCommunityMetrics(24, undefined, "web"))).toBe(false);
    // Community is public but NOT fully mainline: look like that, too.
    await pool.query(`UPDATE eval_jobs SET snapshot = jsonb_set(snapshot, '{evalFlow,isMainline}', 'false') WHERE id = $1`, [analyzeJobId]);
    try {
      expect(has(await storage.getCommunityMetrics(24, undefined, "web"))).toBe(false);
    } finally {
      await pool.query(`UPDATE eval_jobs SET snapshot = jsonb_set(snapshot, '{evalFlow,isMainline}', 'true') WHERE id = $1`, [analyzeJobId]);
    }
  });

  it("the My Evals region picker offers the stated region", async () => {
    const { baseIds } = await storage.getAvailableRegions("myEvals", 24, ME);
    expect(baseIds).toContain(REGION);
  });

  it("the /api/v1 results list keeps to eval runs", async () => {
    const rows = await storage.getEvalResults({ ownerId: ME, limit: 500 });
    expect(rows.some((r) => r.id === analyzeResultId)).toBe(false);
  });

  it("a deleted analysis leaves My Evals, even if its result arrived after the delete", async () => {
    await pool.query("UPDATE eval_jobs SET deleted_at = now() WHERE id = $1", [analyzeJobId]);
    try {
      expect(has(await storage.getMyEvalMetrics(ME, 24, undefined, "web"))).toBe(false);
    } finally {
      await pool.query("UPDATE eval_jobs SET deleted_at = NULL WHERE id = $1", [analyzeJobId]);
    }
  });

  it("the Analyze list shows a job once, even with two result rows", async () => {
    const extra = await storage.createEvalResult({ evalJobId: analyzeJobId, providerId: (await storage.getAllProviders())[0].id, siteId: null } as any);
    try {
      const rows = await storage.getAnalyzeJobs(ME);
      expect(rows.filter((r) => r.job.id === analyzeJobId)).toHaveLength(1);
    } finally {
      await pool.query("DELETE FROM eval_results WHERE id = $1", [extra.id]);
    }
  });

  it("files under the region the uploader stated, and not under Unverified", async () => {
    expect(has(await storage.getMyEvalMetrics(ME, 24, { baseIds: [REGION] }, "web"))).toBe(true);
    expect(has(await storage.getMyEvalMetrics(ME, 24, { baseIds: ["eu-de-frankfurt"] }, "web"))).toBe(false);
    expect(has(await storage.getMyEvalMetrics(ME, 24, { unverified: true }, "web"))).toBe(false);
  });
});
