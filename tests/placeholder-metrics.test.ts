import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { storage, pool, hashToken } from "../server/storage";
import { UNMEASURED_DEFAULTS } from "../vox_eval_agentd/result-defaults";

// #217: every eval result used to carry Network 85 / Naturalness 3.5 / Noise 90
// — the eval agent's placeholder defaults, never measured — and the boards
// ranked on them. Nothing measures these three yet, so they are null (N/A):
// the agent no longer sends them, Core drops the placeholder triple from an
// agent that still does, and migration 0047 clears the stored history.
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

it("the eval agent starts a result with nothing it didn't measure", () => {
  expect(UNMEASURED_DEFAULTS).toEqual({ networkResilience: null, naturalness: null, noiseReduction: null });
});

d("#217 placeholder metrics", () => {
  const jobIds: number[] = [];
  let tokenId = 0;
  let raw = "";
  let agent: { id: number; leaseId: string };
  let provider = "";
  let userId = 0;
  let cookie = "";

  beforeAll(async () => {
    provider = (await storage.getAllProviders())[0].id;
    // A user with their own private agent: their completed jobs show in My Evals.
    const admin = (await (await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@vox.local", password: "admin123456" }),
    })).headers.get("set-cookie") || "").split(";")[0];
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const email = `placeholder-${stamp}@example.com`;
    const { token } = await (await fetch(`${BASE_URL}/api/admin/invite`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: admin }, body: JSON.stringify({ email, plan: "premium" }),
    })).json();
    await fetch(`${BASE_URL}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: `placeholder${stamp}`, password: "TestPass123!", token }),
    });
    userId = (await pool.query("SELECT id FROM users WHERE email = $1", [email])).rows[0].id;
    cookie = ((await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "TestPass123!" }),
    })).headers.get("set-cookie") || "").split(";")[0];

    raw = `vox_agent_placeholder_${stamp}`;
    tokenId = (await storage.createEvalAgentToken({
      name: `placeholder-${stamp}`, tokenHash: hashToken(raw), siteId: "na-us-ashburn-01", dispatchTier: "private", createdBy: userId,
    } as any)).id;
    agent = await (await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${raw}` }, body: JSON.stringify({ name: "placeholder-agent" }),
    })).json();
  });

  afterAll(async () => {
    if (jobIds.length) await pool.query("DELETE FROM eval_jobs WHERE id = ANY($1)", [jobIds]);
    if (tokenId) {
      await pool.query("DELETE FROM eval_agents WHERE token_id = $1", [tokenId]);
      await pool.query("DELETE FROM eval_agent_tokens WHERE id = $1", [tokenId]);
    }
  });

  /** A job on this user's agent, claimed and completed with `results`. */
  async function complete(results: Record<string, unknown>) {
    const job = await storage.createEvalJob({
      // Aimed at this user's agent (its site isn't detected yet, so no site pin).
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: userId, targetTokenId: tokenId,
      siteId: null, targetRegion: null, targetTier: null, config: {},
      snapshot: { provider: { id: provider, name: "p", platformId: null }, evalFlow: null, evalSet: null, creatorPlan: "premium" } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    jobIds.push(job.id);
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${raw}` };
    expect((await fetch(`${BASE_URL}/api/eval-agent/jobs/${job.id}/claim`, {
      method: "POST", headers: auth, body: JSON.stringify({ agentId: agent.id, leaseId: agent.leaseId }),
    })).status).toBe(200);
    expect((await fetch(`${BASE_URL}/api/eval-agent/jobs/${job.id}/complete`, {
      method: "POST", headers: auth, body: JSON.stringify({ agentId: agent.id, leaseId: agent.leaseId, results: { responseLatencyMedian: 900, rawData: {}, ...results } }),
    })).ok).toBe(true);
    return (await storage.getEvalResultsByJob(job.id))[0];
  }

  it("an agent still sending the placeholder triple gets N/A stored, not the fake values", async () => {
    const r = await complete({ networkResilience: 85, naturalness: 3.5, noiseReduction: 90 });
    expect(r).toMatchObject({ networkResilience: null, naturalness: null, noiseReduction: null, responseLatencyMedian: 900 });
  });

  it("a real measurement is kept as sent", async () => {
    const r = await complete({ networkResilience: 70, naturalness: 4.1, noiseReduction: 80 });
    expect(r).toMatchObject({ networkResilience: 70, naturalness: 4.1, noiseReduction: 80 });
  });

  it("My Evals reports N/A as null, not 0", async () => {
    const r = await complete({ networkResilience: null, naturalness: null, noiseReduction: null });
    const rows = await (await fetch(`${BASE_URL}/api/metrics/my-evals?hours=24`, { headers: { Cookie: cookie } })).json();
    const row = (rows as Array<Record<string, unknown>>).find((x) => x.id === r.id);
    expect(row).toMatchObject({ networkResilience: null, naturalness: null, noiseReduction: null });
  });

  it("migration 0047 clears the stored placeholder triple and nothing else", async () => {
    const mk = async (net: number, nat: number, noise: number) => {
      const job = await storage.createEvalJob({
        evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: userId, siteId: null, targetRegion: null, targetTier: null, config: {},
        snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null } as any,
        status: "failed", priority: 0, retryCount: 0, maxRetries: 3,
      } as any);
      jobIds.push(job.id);
      return (await storage.createEvalResult({ evalJobId: job.id, providerId: provider, siteId: null, networkResilience: net, naturalness: nat, noiseReduction: noise } as any)).id;
    };
    const fake = await mk(85, 3.5, 90);
    const real = await mk(85, 4.0, 90); // one value differs: not the placeholder
    await pool.query(fs.readFileSync("migrations/0047_clear_placeholder_metrics.sql", "utf8"));
    const got = async (id: number) => (await pool.query("SELECT network_resilience, naturalness, noise_reduction FROM eval_results WHERE id = $1", [id])).rows[0];
    expect(await got(fake)).toEqual({ network_resilience: null, naturalness: null, noise_reduction: null });
    expect(await got(real)).toEqual({ network_resilience: 85, naturalness: 4, noise_reduction: 90 });
  });
});
