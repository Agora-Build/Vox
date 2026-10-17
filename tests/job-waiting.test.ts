import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { explainWaiting, agentListFilter, type WaitAgent, type WaitJob } from "../server/job-wait";
import { storage, pool, hashToken } from "../server/storage";

// A phone job sat pending while its agent looked healthy (heartbeats fine,
// polls empty): an agent only SEES the jobs the claim rule lets it take, and
// GET /api/eval-agents reported capabilities: [] for every agent, so nothing
// showed why. The job page now runs the claim rule over the agents online and
// says which requirement nobody meets; the Agents page shows capabilities.

const NOW = new Date("2026-10-17T00:00:00Z");
const ME = 501;
const agent = (over: Partial<WaitAgent> = {}): WaitAgent => ({
  name: "Inbound&Outbound Call Agent", tokenId: 41, state: "idle", lastSeenAt: new Date(NOW.getTime() - 30_000),
  capabilities: [], metadata: { frameworkVersion: "0.4.2", sessionInjection: "1" },
  siteId: null, region: null, locationTrust: "trusted",
  tokenCreatedBy: ME, tokenDispatchTier: "public", tokenRegion: "na-us", tokenSiteId: "na-us-santaclara-03",
  tokenIsRevoked: false, tokenOwnerOrgId: null, ...over,
});
const phoneJob = (over: Partial<WaitJob> = {}): WaitJob => ({
  targetTokenId: null, targetRegion: "na-us", targetTier: "public", siteId: null, createdBy: ME, creatorOrgId: null,
  transport: "phone", kind: "eval", sessionInjected: false, config: {}, ...over,
});
const explain = (job: WaitJob, agents: WaitAgent[], viewer = ME) => explainWaiting(job, agents, viewer, { now: NOW });

describe("why a pending job waits (the claim rule over the agents online)", () => {
  it("the incident: a phone job, and the only matching agent isn't reporting phone", () => {
    const w = explain(phoneJob(), [agent()]);
    expect(w.canTake).toBe(0);
    expect(w.message).toMatch(/^Waiting for an agent with phone capability\. 1 online agent would take this phone job but isn't reporting phone/);
    expect(w.message).toMatch(/DialF check passes/);
    expect(w.message).toContain("Your agent 'Inbound&Outbound Call Agent' is among them.");
  });

  it("once it reports phone, it can take the job", () => {
    expect(explain(phoneJob(), [agent({ capabilities: ["phone"] })])).toMatchObject({ canTake: 1, busy: 0, message: expect.stringMatching(/pick it up within seconds/) });
  });

  it("every agent that may take it is busy", () => {
    expect(explain(phoneJob(), [agent({ capabilities: ["phone"], state: "occupied" })]).message).toMatch(/all busy with other jobs right now/);
  });

  it("someone else's agent is counted, never named", () => {
    const w = explain(phoneJob(), [agent({ tokenCreatedBy: 999, name: "Bob's secret rig" })]);
    expect(w.message).toMatch(/1 online agent would take this phone job/);
    expect(w.message).not.toContain("Bob");
  });

  it("an agent too old for the job (the jobs list hides it as well)", () => {
    const w = explain(phoneJob({ config: { frameworkVersion: "0.4.2" } }), [agent({ capabilities: ["phone"], metadata: { frameworkVersion: "0.4.1", sessionInjection: "1" } })]);
    expect(w.canTake).toBe(0);
    expect(w.message).toMatch(/may take this job but can't run it: it runs aeval 0\.4\.1; this job needs 0\.4\.2 or newer\. Upgrade it with vox-upgrade\.sh/);
  });

  it("the matching agent is offline", () => {
    const w = explain(phoneJob(), [agent({ capabilities: ["phone"], state: "offline", lastSeenAt: new Date(NOW.getTime() - 3_600_000) })]);
    expect(w.message).toBe("Waiting for a public-tier agent in na-us: the one that matches is offline. Yours: 'Inbound&Outbound Call Agent'.");
  });

  it("a heartbeat older than the online window counts as offline", () => {
    expect(explain(phoneJob(), [agent({ capabilities: ["phone"], lastSeenAt: new Date(NOW.getTime() - 6 * 60_000) })]).canTake).toBe(0);
  });

  it("nothing matches its target at all", () => {
    expect(explain(phoneJob({ targetRegion: "eu-de" }), [agent({ capabilities: ["phone"] })]).message)
      .toBe("Waiting for a public-tier agent in eu-de: no agent matches it.");
  });

  it("decides on each token's LATEST agent row, as the claim route does, and skips revoked tokens", () => {
    // Newest first: the current row has no phone; an older row did.
    expect(explain(phoneJob(), [agent(), agent({ capabilities: ["phone"] })]).canTake).toBe(0);
    expect(explain(phoneJob(), [agent({ capabilities: ["phone"], tokenIsRevoked: true })]).canTake).toBe(0);
  });

  it("an analysis waits for an agent that can analyze", () => {
    const w = explain(phoneJob({ kind: "analyze", transport: "web", targetRegion: null, targetTier: null }), [agent()]);
    expect(w.message).toMatch(/^Waiting for an agent that can run analyses/);
  });
});

describe("the jobs-list filter both the route and the explanation use", () => {
  it("hides a session-injected job from a build that can't use a session, and a too-new job from an old aeval", () => {
    expect(agentListFilter({ sessionInjection: { platformId: "x" } }, {})).toMatch(/can't use a login session/);
    expect(agentListFilter({ frameworkVersion: "0.5.0" }, { frameworkVersion: "0.4.2" })).toMatch(/needs 0\.5\.0 or newer/);
    expect(agentListFilter({ frameworkVersion: "0.4.2" }, { frameworkVersion: "0.4.2" })).toBeNull();
    expect(agentListFilter({}, {})).toBeNull();
  });
});

// Real routes on the running dev server.
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const d = process.env.DATABASE_URL ? describe : describe.skip;

d("the job page and the Agents page, over HTTP", () => {
  let cookie = "";
  let userId = 0;
  let tokenId = 0;
  let raw = "";
  let agentReg: { id: number; leaseId: string };
  const jobIds: number[] = [];
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `waiting-${stamp}@example.com`;

  beforeAll(async () => {
    const admin = ((await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@vox.local", password: "admin123456" }),
    })).headers.get("set-cookie") || "").split(";")[0];
    const { token } = await (await fetch(`${BASE_URL}/api/admin/invite`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: admin }, body: JSON.stringify({ email, plan: "premium" }),
    })).json();
    await fetch(`${BASE_URL}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: `waiting${stamp}`, password: "TestPass123!", token }),
    });
    userId = (await pool.query("SELECT id FROM users WHERE email = $1", [email])).rows[0].id;
    cookie = ((await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "TestPass123!" }),
    })).headers.get("set-cookie") || "").split(";")[0];
    raw = `vox_agent_waiting_${stamp}`;
    tokenId = (await storage.createEvalAgentToken({
      name: `waiting-${stamp}`, tokenHash: hashToken(raw), siteId: null, dispatchTier: "private", createdBy: userId,
    } as any)).id;
    agentReg = await (await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${raw}` },
      body: JSON.stringify({ name: "My Phone Agent", capabilities: [] }),
    })).json();
  });

  afterAll(async () => {
    if (jobIds.length) await pool.query("DELETE FROM eval_jobs WHERE id = ANY($1)", [jobIds]);
    if (tokenId) {
      await pool.query("DELETE FROM eval_agents WHERE token_id = $1", [tokenId]);
      await pool.query("DELETE FROM eval_agent_tokens WHERE id = $1", [tokenId]);
    }
  });

  const heartbeat = (capabilities: string[]) => fetch(`${BASE_URL}/api/eval-agent/heartbeat`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${raw}` },
    body: JSON.stringify({ agentId: agentReg.id, leaseId: agentReg.leaseId, state: "idle", capabilities }),
  });

  it("a pending phone job sent to my agent says it's waiting for phone capability, naming my agent — then clears", async () => {
    const job = await storage.createEvalJob({
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: userId, targetTokenId: tokenId,
      siteId: null, targetRegion: null, targetTier: null, config: {},
      // A job's transport is stamped from its frozen snapshot, not passed in.
      snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: "premium", transport: "phone" } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    jobIds.push(job.id);
    const detail = async () => (await (await fetch(`${BASE_URL}/api/eval-jobs/${job.id}/detail`, { headers: { Cookie: cookie } })).json()).waiting;
    const before = await detail();
    expect(before.canTake).toBe(0);
    expect(before.message).toMatch(/^Waiting for an agent with phone capability/);
    expect(before.message).toContain("Your agent 'My Phone Agent' is among them.");

    expect((await heartbeat(["phone"])).ok).toBe(true);
    expect(await detail()).toMatchObject({ canTake: 1, message: expect.stringMatching(/within seconds/) });
  });

  it("the Agents page gets the capabilities the agent reported (it got [] for everyone before)", async () => {
    expect((await heartbeat(["phone", "analyze"])).ok).toBe(true);
    const rows = await (await fetch(`${BASE_URL}/api/eval-agents`, { headers: { Cookie: cookie } })).json() as Array<{ id: number; capabilities: string[] }>;
    expect(rows.find((a) => a.id === agentReg.id)?.capabilities).toEqual(["phone", "analyze"]);
  });

  it("a finished job carries no waiting explanation", async () => {
    const done = await storage.createEvalJob({
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: userId, targetTokenId: tokenId,
      siteId: null, targetRegion: null, targetTier: null, config: {},
      snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: "premium" } as any,
      status: "failed", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    jobIds.push(done.id);
    expect((await (await fetch(`${BASE_URL}/api/eval-jobs/${done.id}/detail`, { headers: { Cookie: cookie } })).json()).waiting).toBeNull();
  });
});
