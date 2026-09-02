import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { storage, db, hashToken } from "../server/storage";
import { evalAgents, evalAgentTokens, evalJobs, evalResults } from "../shared/schema";
import { BASE_NA } from "./helpers/regions";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "admin@vox.local";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "admin123456";

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("no session cookie");
  return cookie.split(";")[0];
}
const authFetch = (cookie: string, url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { ...(init.headers || {}), Cookie: cookie, "Content-Type": "application/json" } });

describeDb("zero-trust claim gating", () => {
  let tokenId: number; let agentId: number;
  const jobIds: number[] = [];

  const identity = (over: Partial<{ siteId: string | null; region: string | null; locationTrust: string }> = {}) => ({
    id: tokenId, siteId: null as string | null, region: null as string | null,
    dispatchTier: "private", createdBy: 1, ownerOrgId: null, locationTrust: "unknown", ...over,
  });

  const makeJob = async (fields: Partial<typeof evalJobs.$inferInsert>) => {
    const row = await db.insert(evalJobs).values({
      workflowId: null, evalSetId: null, createdBy: 1, status: "pending",
      config: {}, snapshot: {}, siteId: null, ...fields,
    } as typeof evalJobs.$inferInsert).returning();
    jobIds.push(row[0].id);
    return row[0];
  };

  beforeAll(async () => {
    const t = await db.insert(evalAgentTokens).values({
      name: "zt-claim", tokenHash: hashToken(`zt-claim-${Date.now()}`),
      dispatchTier: "private", createdBy: 1, isRevoked: false, siteId: null, region: null,
    }).returning();
    tokenId = t[0].id;
    const a = await db.insert(evalAgents).values({ name: "zt-claim-agent", tokenId, siteId: null, state: "idle" }).returning();
    agentId = a[0].id;
  });
  afterAll(async () => {
    if (jobIds.length) await db.delete(evalJobs).where(inArray(evalJobs.id, jobIds));
    await db.delete(evalAgents).where(eq(evalAgents.id, agentId));
    await db.delete(evalAgentTokens).where(eq(evalAgentTokens.id, tokenId));
  });

  it("an Unverified agent (region NULL) cannot see or claim a region-pooled job", async () => {
    const job = await makeJob({ targetRegion: BASE_NA, targetTier: "private" });
    const visible = await storage.getClaimableJobsForToken(identity());
    expect(visible.map(j => j.id)).not.toContain(job.id);
    expect(await storage.claimEvalJob(job.id, agentId, identity())).toBeUndefined();
  });

  it("a trusted agent in the pool region claims it, freezing location_trust + its siteId", async () => {
    const job = await makeJob({ targetRegion: BASE_NA, targetTier: "private" });
    const id = identity({ region: BASE_NA, siteId: `${BASE_NA}-77`, locationTrust: "trusted" });
    const visible = await storage.getClaimableJobsForToken(id);
    expect(visible.map(j => j.id)).toContain(job.id);
    const claimed = await storage.claimEvalJob(job.id, agentId, id);
    expect(claimed?.siteId).toBe(`${BASE_NA}-77`);
    expect(claimed?.locationTrust).toBe("trusted");
  });

  it("a targeted job IS claimable by an Unverified agent — siteId stays NULL, trust frozen", async () => {
    const job = await makeJob({ targetTokenId: tokenId });
    const claimed = await storage.claimEvalJob(job.id, agentId, identity({ locationTrust: "anonymized" }));
    expect(claimed).toBeDefined();
    expect(claimed?.siteId).toBeNull();
    expect(claimed?.locationTrust).toBe("anonymized");
  });
});

// Full HTTP round-trip regression for the /complete route's claimed-ness gate
// (server/routes.ts): the result-recording condition used to be
// `job.siteId != null`, which under zero trust silently dropped every result
// from an Unverified agent (siteId is legitimately null while evalAgentId is
// set). Fixed to gate on `job.evalAgentId != null` instead. This exercises the
// real route end to end — register → run (targeted) → claim → complete — and
// asserts the eval_results row lands with site_id NULL rather than not landing
// at all.
describeDb("zero-trust complete route — Unverified agent's result is recorded (siteId NULL)", () => {
  let cookie: string;
  let workflowId: number;
  let evalSetId: number;
  let tokenId: number;
  let tokenSecret: string;
  let agentId: number;
  let leaseId: string;
  let jobId: number;

  beforeAll(async () => {
    cookie = await login();

    const providers = await (await authFetch(cookie, `${BASE_URL}/api/providers`)).json();
    const providerId = providers[0].id;
    const wfRes = await authFetch(cookie, `${BASE_URL}/api/workflows`, {
      method: "POST",
      body: JSON.stringify({ name: `zt-complete-wf-${Date.now()}`, visibility: "public", providerId, config: {} }),
    });
    expect(wfRes.ok).toBe(true);
    workflowId = (await wfRes.json()).id;
    const es = await (await authFetch(cookie, `${BASE_URL}/api/eval-sets?includePublic=true`)).json();
    evalSetId = es[0].id;

    // Private (non-public) token: mints with siteId/region NULL under zero
    // trust — no region assertion possible at mint time.
    const tokRes = await authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens`, {
      method: "POST",
      body: JSON.stringify({ name: `zt-complete-tok-${Date.now()}`, dispatchTier: "private" }),
    });
    expect(tokRes.ok).toBe(true);
    const tokBody = await tokRes.json();
    tokenId = tokBody.id;
    tokenSecret = tokBody.token;
    expect(tokBody.siteId).toBeNull();

    // Register on localhost: lands Unverified (locationTrust "unknown",
    // siteId/region null) — never touched by trusted detection.
    const regRes = await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "zt-complete-agent" }),
    });
    expect(regRes.ok).toBe(true);
    const agent = await regRes.json();
    agentId = agent.id;
    leaseId = agent.leaseId;
    expect(agent.siteId).toBeNull();

    // Targeted dispatch is trust-exempt (spec: "Targeted claims: no trust
    // gate") — this is how an Unverified private agent still runs its
    // owner's evals.
    const runRes = await authFetch(cookie, `${BASE_URL}/api/workflows/${workflowId}/run`, {
      method: "POST",
      body: JSON.stringify({ evalSetId, targetTokenId: tokenId }),
    });
    expect(runRes.ok).toBe(true);
    jobId = (await runRes.json()).job.id;

    const claimRes = await fetch(`${BASE_URL}/api/eval-agent/jobs/${jobId}/claim`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, leaseId }),
    });
    expect(claimRes.ok).toBe(true);
    const claimedJob = await claimRes.json();
    expect(claimedJob.evalAgentId).toBe(agentId);
    expect(claimedJob.siteId).toBeNull();
  });

  afterAll(async () => {
    await authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens/${tokenId}/revoke`, { method: "POST" });
    await authFetch(cookie, `${BASE_URL}/api/workflows/${workflowId}`, { method: "DELETE" });
  });

  it("completing the job with results creates an eval_results row with siteId NULL", async () => {
    const completeRes = await fetch(`${BASE_URL}/api/eval-agent/jobs/${jobId}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId, leaseId,
        results: {
          responseLatencyMedian: 900, responseLatencySd: 50,
          interruptLatencyMedian: 800, interruptLatencySd: 40,
          responseRate: 1, interruptRate: 1, falseInterruptRate: 0, turnSuccessRate: 1,
        },
      }),
    });
    expect(completeRes.ok).toBe(true);

    const rows = await db.select().from(evalResults).where(eq(evalResults.evalJobId, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0].siteId).toBeNull();
    expect(rows[0].responseLatencyMedian).toBe(900);

    const job = await storage.getEvalJob(jobId);
    expect(job?.status).toBe("completed");
    expect(job?.evalAgentId).toBe(agentId);
    expect(job?.siteId).toBeNull();
  });
});
