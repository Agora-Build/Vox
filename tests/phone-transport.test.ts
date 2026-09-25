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
  let evalflowId: number;
  let jobId: number;

  beforeAll(async () => {
    userId = (await storage.createUser({
      username: `phA${suffix}`, email: `phA${suffix}@example.com`,
    } as any)).id;
  });

  afterAll(async () => {
    if (!hasDb) return;
    if (jobId) await pool.query(`DELETE FROM eval_jobs WHERE id = $1`, [jobId]);
    if (evalflowId) await pool.query(`DELETE FROM evalflows WHERE id = $1`, [evalflowId]);
    if (userId) await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  it("freezes transport at job creation; later evalflow edits don't rewrite it", async () => {
    const providers = await storage.getAllProviders();
    expect(providers.length).toBeGreaterThan(0);

    const wf = await storage.createEvalflow({
      name: `phA-wf-${suffix}`, ownerId: userId, providerId: providers[0].id,
      transport: "phone", visibility: "private", config: {},
    } as any);
    evalflowId = wf.id;
    expect(wf.transport).toBe("phone");

    const snap = buildJobSnapshot(wf, null, providers[0], "principal");
    expect(snap.transport).toBe("phone");

    const job = await storage.createEvalJob({
      evalflowId: wf.id, triggerType: 2, evalSetId: null, createdBy: userId,
      siteId: null, targetRegion: "na-us-ashburn", targetTier: "private",
      config: {}, snapshot: snap,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    jobId = job.id;
    expect(job.transport).toBe("phone"); // stamped column

    // Edit the live evalflow — the frozen job must not move.
    await storage.updateEvalflow(wf.id, { transport: "web" } as any);
    const reread = await storage.getEvalJob(job.id);
    expect(reread!.transport).toBe("phone");
    expect((reread!.snapshot as any).transport).toBe("phone");
  });

  it("defaults to web when the evalflow has no transport (snapshot)", async () => {
    const providers = await storage.getAllProviders();
    const wf = await storage.createEvalflow({
      name: `phA-wf-web-${suffix}`, ownerId: userId, providerId: providers[0].id,
      visibility: "private", config: {},
    } as any);
    try {
      expect(wf.transport).toBe("web");
      const snap = buildJobSnapshot(wf, null, providers[0], "basic");
      expect(snap.transport).toBe("web");
    } finally {
      await pool.query(`DELETE FROM evalflows WHERE id = $1`, [wf.id]);
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
      evalflowId: null, triggerType: 2, evalSetId: null, createdBy: creatorId,
      siteId: null, targetRegion: "na-us-ashburn", targetTier: "private",
      config: {},
      snapshot: { provider: null, evalflow: null, evalSet: null, creatorPlan: null, transport } as any,
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

d("phone transport — callMetadata + metrics transport filter", () => {
  let creatorId: number;
  let tokId: number;
  let agentId: number;
  let webJobId: number;
  let phoneJobId: number;
  const rawToken = `phA-met-token-${suffix}`;

  const mkCompletedishJob = async (transport: "web" | "phone", providerId: string) => {
    const job = await storage.createEvalJob({
      evalflowId: null, triggerType: 2, evalSetId: null, createdBy: creatorId,
      siteId: null, targetRegion: "na-us-ashburn", targetTier: "private",
      config: {},
      snapshot: { provider: { id: providerId, name: "p", platformId: null }, evalflow: null, evalSet: null, creatorPlan: "basic", transport } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    // Claim stamps tokenDispatchTier=private + running (my-evals arm 3 needs it).
    const claimed = await storage.claimEvalJob(job.id, agentId, {
      id: tokId, siteId: "na-us-ashburn-01", region: "na-us-ashburn", dispatchTier: "private",
      createdBy: creatorId, ownerOrgId: null, locationTrust: "trusted", phoneCapable: true,
    } as any);
    expect(claimed).toBeDefined();
    return job.id;
  };

  beforeAll(async () => {
    creatorId = (await storage.createUser({
      username: `phAmet${suffix}`, email: `phAmet${suffix}@example.com`,
    } as any)).id;
    const tok = await storage.createEvalAgentToken({
      name: `phA-met-${suffix}`, tokenHash: hashToken(rawToken),
      siteId: "na-us-ashburn-01", dispatchTier: "private", createdBy: creatorId,
    } as any);
    tokId = tok.id;
    agentId = (await storage.createEvalAgent({
      tokenId: tok.id, name: `phA-met-agent-${suffix}`, siteId: "na-us-ashburn-01",
      state: "idle", metadata: {},
    } as any)).id;
    const providers = await storage.getAllProviders();
    webJobId = await mkCompletedishJob("web", providers[0].id);
    phoneJobId = await mkCompletedishJob("phone", providers[0].id);
  });

  afterAll(async () => {
    if (!hasDb) return;
    await pool.query(`DELETE FROM eval_results WHERE eval_job_id = ANY($1::int[])`, [[webJobId, phoneJobId].filter(Boolean)]);
    await pool.query(`DELETE FROM eval_jobs WHERE id = ANY($1::int[])`, [[webJobId, phoneJobId].filter(Boolean)]);
    if (agentId) await pool.query(`DELETE FROM eval_agents WHERE id = $1`, [agentId]);
    if (tokId) await pool.query(`DELETE FROM eval_agent_tokens WHERE id = $1`, [tokId]);
    if (creatorId) await pool.query(`DELETE FROM users WHERE id = $1`, [creatorId]);
  });

  it("complete endpoint persists callMetadata; oversized/invalid rejected", async () => {
    const complete = (jobId: number, extra: Record<string, unknown>) =>
      fetch(`${BASE_URL}/api/eval-agent/jobs/${jobId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawToken}` },
        body: JSON.stringify({ agentId, results: { responseRate: 0.5, turnSuccessRate: 0.5 }, ...extra }),
      });

    const bad = await complete(phoneJobId, { callMetadata: "not-an-object" });
    expect(bad.status).toBe(400);

    const ok = await complete(phoneJobId, {
      callMetadata: { disposition: "completed", durationMs: 61000, answeredAfterMs: 4200 },
    });
    expect(ok.ok).toBe(true);
    const row = await pool.query(`SELECT call_metadata FROM eval_results WHERE eval_job_id = $1`, [phoneJobId]);
    expect(row.rows[0].call_metadata).toEqual({ disposition: "completed", durationMs: 61000, answeredAfterMs: 4200 });

    const okWeb = await complete(webJobId, {});
    expect(okWeb.ok).toBe(true);
  });

  it("getMyEvalMetrics filters by transport; default is web", async () => {
    const web = await storage.getMyEvalMetrics(creatorId, undefined, undefined);
    const phone = await (storage.getMyEvalMetrics as any)(creatorId, undefined, undefined, "phone");
    const webJobs = web.map((r: any) => r.id);
    expect(phone.some((r: any) => (r as any).transport === "phone")).toBe(true);
    expect(phone.every((r: any) => (r as any).transport === "phone")).toBe(true);
    expect((web as any[]).every((r: any) => (r.transport ?? "web") === "web")).toBe(true);
    expect(webJobs.length).toBeGreaterThan(0);
  });

  it("metrics endpoints validate the transport param", async () => {
    const bad = await fetch(`${BASE_URL}/api/metrics/realtime?transport=pigeon`);
    expect(bad.status).toBe(400);
    const ok = await fetch(`${BASE_URL}/api/metrics/realtime?transport=phone`);
    expect(ok.status).toBe(200);
  });
});

d("phone transport — evalflow API (HTTP, dev server)", () => {
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
    await pool.query(`DELETE FROM evalflows WHERE id = ANY($1::int[])`, [created]);
  });

  const mkEvalflow = async (body: Record<string, unknown>) => {
    const providers = await storage.getAllProviders();
    const res = await fetch(`${BASE_URL}/api/evalflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `phA-http-${suffix}-${Math.random().toString(36).slice(2, 8)}`, providerId: providers[0].id, ...body }),
    });
    return res;
  };

  it("create accepts transport=phone and echoes it; default is web", async () => {
    const res = await mkEvalflow({ transport: "phone" });
    expect(res.ok).toBe(true);
    const wf = await res.json();
    created.push(wf.id);
    expect(wf.transport).toBe("phone");

    const res2 = await mkEvalflow({});
    const wf2 = await res2.json();
    created.push(wf2.id);
    expect(wf2.transport).toBe("web");
  });

  it("rejects an invalid transport with 400", async () => {
    const res = await mkEvalflow({ transport: "carrier-pigeon" });
    expect(res.status).toBe(400);
  });

  it("validates Setup step scripts per mode and refuses running a phone evalflow without call establishment", async () => {
    // Clean cut: the old per-mode config keys are rejected with pointer errors.
    const legacyDial = await mkEvalflow({ transport: "phone", config: { phoneDial: { number: "+15551234" } } });
    expect(legacyDial.status).toBe(400);
    expect((await legacyDial.json()).error).toContain("call.dial step");
    const legacyTrigger = await mkEvalflow({ transport: "phone", config: { restfulTrigger: { method: "POST", url: "https://x.example/y" } } });
    expect(legacyTrigger.status).toBe(400);
    expect((await legacyTrigger.json()).error).toContain("restful.request step");

    // Vocabulary is transport-scoped.
    const badNumber = await mkEvalflow({ transport: "phone", config: { stepsPrefix: "- type: call.dial\n  number: abc\n" } });
    expect(badNumber.status).toBe(400);
    const webVocabOnPhone = await mkEvalflow({ transport: "phone", config: { stepsPrefix: "- type: platform.setup\n" } });
    expect(webVocabOnPhone.status).toBe(400);
    expect((await webVocabOnPhone.json()).error).toContain("web-session vocabulary");
    const phoneVocabOnWeb = await mkEvalflow({ transport: "web", config: { stepsPrefix: "- type: call.dial\n  number: \"+15551234\"\n" } });
    expect(phoneVocabOnWeb.status).toBe(400);
    expect((await phoneVocabOnWeb.json()).error).toContain("phone vocabulary");

    const okDial = await mkEvalflow({
      transport: "phone",
      config: { stepsPrefix: '- type: call.dial\n  number: "+1 (555) 010-1234"\n- type: call.wait_answered\n', stepsSuffix: "- type: call.hangup\n" },
    });
    expect(okDial.ok).toBe(true);
    created.push((await okDial.json()).id);

    // Phone evalflow with EMPTY Setup: creatable, but running it is refused at
    // the source (unified-steps §4 — nothing would establish a call).
    const bare = await mkEvalflow({ transport: "phone" });
    const bareWf = await bare.json();
    created.push(bareWf.id);
    const run = await fetch(`${BASE_URL}/api/evalflows/${bareWf.id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ region: "na-us-ashburn", targetTier: "private" }),
    });
    expect(run.status).toBe(400);
    expect((await run.json()).error).toContain("establish no call");

    // Trigger-only Setup (restful.request, no call.dial): authorable, but the
    // run names the R7 gap.
    const triggerOnly = await mkEvalflow({
      transport: "phone",
      config: { stepsPrefix: '- type: restful.request\n  method: POST\n  url: "https://x.example/call"\n' },
    });
    expect(triggerOnly.ok).toBe(true);
    const triggerWf = await triggerOnly.json();
    created.push(triggerWf.id);
    const runTrigger = await fetch(`${BASE_URL}/api/evalflows/${triggerWf.id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ region: "na-us-ashburn", targetTier: "private" }),
    });
    expect(runTrigger.status).toBe(400);
    expect((await runTrigger.json()).error).toContain("DialF R7");
  });

  it("PATCH can flip transport", async () => {
    const res = await mkEvalflow({});
    const wf = await res.json();
    created.push(wf.id);
    const patch = await fetch(`${BASE_URL}/api/evalflows/${wf.id}`, {
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
