import { describe, it, expect, afterAll } from "vitest";
import { storage, pool, hashToken } from "../server/storage";
import { claimFirstAvailable, claimOutcome } from "../vox_eval_agentd/job-pick";

// #216: a pooled job requeued after its agent died keeps the site_id its
// first claim stamped. It must stay claimable by any agent in the region, get
// the new claimer's site, and never stall an agent that can't take it.
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

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

/** A pending public pooled job in `region`, still carrying another site from an earlier claim. */
const requeuedPooledJob = async (region: string) => {
  const job = await storage.createEvalJob({
    evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: 2,
    siteId: `${region}-97`, targetRegion: region, targetTier: "public", config: {},
    snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null } as any,
    status: "pending", priority: 0, retryCount: 1, maxRetries: 3,
  } as any);
  jobIds.push(job.id);
  return job;
};

d("#216 requeued pooled job", () => {
  it("another agent in the region claims it, and the job gets that agent's site", async () => {
    const job = await requeuedPooledJob("na-us-ashburn");
    const tok = await storage.createEvalAgentToken({
      name: `requeue-${Date.now()}`, tokenHash: `requeue-${Date.now()}-${Math.random()}`,
      siteId: "na-us-ashburn-01", dispatchTier: "public", createdBy: 1,
    } as any);
    tokenIds.push(tok.id);
    const agent = await storage.createEvalAgent({ tokenId: tok.id, name: `requeue-a-${Date.now()}`, siteId: tok.siteId, state: "idle", metadata: {} } as any);
    const claimed = await storage.claimEvalJob(job.id, agent.id, {
      id: tok.id, siteId: tok.siteId, region: tok.region, dispatchTier: "public", createdBy: 1, ownerOrgId: null, locationTrust: "trusted",
    });
    expect(claimed).toMatchObject({ status: "running", siteId: "na-us-ashburn-01" });
  });

  it("the claim route accepts it instead of fencing on the stale site", async () => {
    const job = await requeuedPooledJob("na-us-ashburn");
    const raw = `vox_agent_requeue_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const tok = await storage.createEvalAgentToken({
      name: `requeue-http-${Date.now()}`, tokenHash: hashToken(raw), siteId: "na-us-ashburn-01", dispatchTier: "public", createdBy: 1,
    } as any);
    tokenIds.push(tok.id);
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${raw}` };
    const reg = await fetch(`${BASE_URL}/api/eval-agent/register`, { method: "POST", headers: auth, body: JSON.stringify({ name: "requeue-http-agent" }) });
    expect(reg.ok).toBe(true);
    const agent = await reg.json();
    const listed = await (await fetch(`${BASE_URL}/api/eval-agent/jobs`, { headers: auth })).json();
    expect(listed.map((j: { id: number }) => j.id)).toContain(job.id);
    const res = await fetch(`${BASE_URL}/api/eval-agent/jobs/${job.id}/claim`, {
      method: "POST", headers: auth, body: JSON.stringify({ agentId: agent.id, leaseId: agent.leaseId }),
    });
    expect(res.status).toBe(200);
  });
});

describe("#216 the agent moves past a job it can't claim", () => {
  it("claims the first job that accepts, in list order", async () => {
    const tried: number[] = [];
    const got = await claimFirstAvailable([{ id: 1 }, { id: 2 }, { id: 3 }], async (j) => { tried.push(j.id); return j.id === 2 ? "claimed" : "taken"; });
    expect(got).toEqual({ id: 2 });
    expect(tried).toEqual([1, 2]);
  });
  it("stops at a claim that failed for any other reason (Core trouble): no burst of claims", async () => {
    const tried: number[] = [];
    const got = await claimFirstAvailable([{ id: 1 }, { id: 2 }, { id: 3 }],
      async (j) => { tried.push(j.id); return j.id === 1 ? "error" : "claimed"; });
    expect(got).toBeNull();
    expect(tried).toEqual([1]);
  });
  it("reads a claim response: refusals about the job move on, anything else stops", () => {
    expect(claimOutcome(200)).toBe("claimed");
    for (const s of [409, 403, 404]) expect(claimOutcome(s)).toBe("taken");
    for (const s of [500, 502, 503, 401]) expect(claimOutcome(s)).toBe("error");
  });
  it("returns null when none can be claimed", async () => {
    expect(await claimFirstAvailable([{ id: 1 }], async () => "taken")).toBeNull();
    expect(await claimFirstAvailable([], async () => "claimed")).toBeNull();
  });
});
