import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage, pool, buildJobSnapshot, hashToken } from "../server/storage";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

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

  it("defaults to web when the workflow has no transport (snapshot)", async () => {
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

d("phone transport — claim gating (SQL + permissions mirror)", () => {
  let creatorId: number;
  let tokenArg: { id: number; siteId: string | null; region: string | null; dispatchTier: string; createdBy: number; ownerOrgId: number | null; locationTrust: string };
  let agentId: number;
  let phoneJobId: number;
  let webJobId: number;
  let tokId: number;

  beforeAll(async () => {
    creatorId = (await storage.createUser({
      username: `phAclaim${suffix}`, email: `phAclaim${suffix}@example.com`,
    } as any)).id;
    const tok = await storage.createEvalAgentToken({
      name: `phA-claim-${suffix}`, tokenHash: `phA-claim-${suffix}`,
      siteId: "na-us-ashburn-01", dispatchTier: "private", createdBy: creatorId,
    } as any);
    tokId = tok.id;
    tokenArg = {
      id: tok.id, siteId: "na-us-ashburn-01", region: "na-us-ashburn",
      dispatchTier: "private", createdBy: creatorId, ownerOrgId: null, locationTrust: "trusted",
    };
    agentId = (await storage.createEvalAgent({
      tokenId: tok.id, name: `phA-claim-agent-${suffix}`, siteId: "na-us-ashburn-01",
      state: "idle", metadata: {},
    } as any)).id;

    const mkJob = (transport: "web" | "phone") => storage.createEvalJob({
      workflowId: null, triggerType: 2, evalSetId: null, createdBy: creatorId,
      siteId: null, targetRegion: "na-us-ashburn", targetTier: "private",
      config: {},
      snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null, transport } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    phoneJobId = (await mkJob("phone")).id;
    webJobId = (await mkJob("web")).id;
  });

  afterAll(async () => {
    if (!hasDb) return;
    await pool.query(`DELETE FROM eval_jobs WHERE id = ANY($1::int[])`, [[phoneJobId, webJobId].filter(Boolean)]);
    if (agentId) await pool.query(`DELETE FROM eval_agents WHERE id = $1`, [agentId]);
    if (tokId) await pool.query(`DELETE FROM eval_agent_tokens WHERE id = $1`, [tokId]);
    if (creatorId) await pool.query(`DELETE FROM users WHERE id = $1`, [creatorId]);
  });

  it("phone job is invisible and unclaimable without the phone capability; web job unaffected", async () => {
    const listed = await storage.getClaimableJobsForToken({ ...tokenArg, phoneCapable: false } as any);
    const ids = listed.map((j: any) => j.id);
    expect(ids).not.toContain(phoneJobId);
    expect(ids).toContain(webJobId);

    const claim = await storage.claimEvalJob(phoneJobId, agentId, { ...tokenArg, phoneCapable: false } as any);
    expect(claim).toBeUndefined();
  });

  it("phone job is visible and claimable with the phone capability", async () => {
    const listed = await storage.getClaimableJobsForToken({ ...tokenArg, phoneCapable: true } as any);
    expect(listed.map((j: any) => j.id)).toContain(phoneJobId);

    const claim = await storage.claimEvalJob(phoneJobId, agentId, { ...tokenArg, phoneCapable: true } as any);
    expect(claim).toBeDefined();
    expect(claim!.status).toBe("running");
  });

  it("isClaimable mirrors the gate", async () => {
    const { isClaimable } = await import("../server/permissions");
    const base = { targetTokenId: null, targetRegion: "na-us-ashburn", targetTier: "private" as const, createdBy: creatorId };
    const tok = { id: tokId, dispatchTier: "private" as const, createdBy: creatorId, region: "na-us-ashburn" };
    expect(isClaimable({ ...base, transport: "phone" }, { ...tok, phoneCapable: false } as any)).toBe(false);
    expect(isClaimable({ ...base, transport: "phone" }, { ...tok, phoneCapable: true } as any)).toBe(true);
    expect(isClaimable({ ...base }, { ...tok } as any)).toBe(true); // web/absent: ungated
  });
});

d("phone transport — workflow API (HTTP, dev server)", () => {
  let cookie: string;
  const created: number[] = [];

  beforeAll(async () => {
    const login = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@vox.local", password: "admin123456" }),
    });
    expect(login.ok).toBe(true);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
  });

  afterAll(async () => {
    if (!hasDb || created.length === 0) return;
    await pool.query(`DELETE FROM workflows WHERE id = ANY($1::int[])`, [created]);
  });

  const mkWorkflow = async (body: Record<string, unknown>) => {
    const providers = await storage.getAllProviders();
    const res = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `phA-http-${suffix}-${Math.random().toString(36).slice(2, 8)}`, providerId: providers[0].id, ...body }),
    });
    return res;
  };

  it("create accepts transport=phone and echoes it; default is web", async () => {
    const res = await mkWorkflow({ transport: "phone" });
    expect(res.ok).toBe(true);
    const wf = await res.json();
    created.push(wf.id);
    expect(wf.transport).toBe("phone");

    const res2 = await mkWorkflow({});
    const wf2 = await res2.json();
    created.push(wf2.id);
    expect(wf2.transport).toBe("web");
  });

  it("rejects an invalid transport with 400", async () => {
    const res = await mkWorkflow({ transport: "carrier-pigeon" });
    expect(res.status).toBe(400);
  });

  it("PATCH can flip transport", async () => {
    const res = await mkWorkflow({});
    const wf = await res.json();
    created.push(wf.id);
    const patch = await fetch(`${BASE_URL}/api/workflows/${wf.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ transport: "phone" }),
    });
    expect(patch.ok).toBe(true);
    expect((await patch.json()).transport).toBe("phone");
  });
});

d("phone transport — agent capability declaration (HTTP, dev server)", () => {
  let ownerId: number;
  let tokenId: number;
  let agentId: number;
  const rawToken = `phA-cap-token-${suffix}`;

  beforeAll(async () => {
    ownerId = (await storage.createUser({
      username: `phAcap${suffix}`, email: `phAcap${suffix}@example.com`,
    } as any)).id;
    const tok = await storage.createEvalAgentToken({
      name: `phA-cap-${suffix}`, tokenHash: hashToken(rawToken),
      siteId: "na-us-ashburn-01", dispatchTier: "private", createdBy: ownerId,
    } as any);
    tokenId = tok.id;
  });

  afterAll(async () => {
    if (!hasDb) return;
    if (agentId) await pool.query(`DELETE FROM eval_agents WHERE id = $1`, [agentId]);
    if (tokenId) await pool.query(`DELETE FROM eval_agent_tokens WHERE id = $1`, [tokenId]);
    if (ownerId) await pool.query(`DELETE FROM users WHERE id = $1`, [ownerId]);
  });

  it("register accepts capabilities and persists them", async () => {
    const res = await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawToken}` },
      body: JSON.stringify({ name: `phA-cap-agent-${suffix}`, capabilities: ["phone"] }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    agentId = body.id;
    const agent = await storage.getEvalAgent(agentId);
    expect(agent!.capabilities).toEqual(["phone"]);
  });

  it("rejects unknown capabilities with 400", async () => {
    const res = await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawToken}` },
      body: JSON.stringify({ name: `phA-cap-agent-${suffix}`, capabilities: ["jetpack"] }),
    });
    expect(res.status).toBe(400);
  });

  it("heartbeat with capabilities:[] clears them (self-healing); omitted field leaves them", async () => {
    // Re-register to get a fresh lease (the reject test above didn't supersede it,
    // but be explicit): capabilities back to ["phone"].
    const reg = await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawToken}` },
      body: JSON.stringify({ name: `phA-cap-agent-${suffix}`, capabilities: ["phone"] }),
    });
    const { id, leaseId } = await reg.json();
    agentId = id;

    // Omitted field: unchanged.
    let hb = await fetch(`${BASE_URL}/api/eval-agent/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawToken}` },
      body: JSON.stringify({ agentId: id, leaseId, state: "idle" }),
    });
    expect(hb.ok).toBe(true);
    expect((await storage.getEvalAgent(id))!.capabilities).toEqual(["phone"]);

    // Explicit empty array: cleared (DialF went away on the host).
    hb = await fetch(`${BASE_URL}/api/eval-agent/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawToken}` },
      body: JSON.stringify({ agentId: id, leaseId, state: "idle", capabilities: [] }),
    });
    expect(hb.ok).toBe(true);
    expect((await storage.getEvalAgent(id))!.capabilities).toEqual([]);
  });
});
