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
  let evalFlowId: number;
  let jobId: number;

  beforeAll(async () => {
    userId = (await storage.createUser({
      username: `phA${suffix}`, email: `phA${suffix}@example.com`,
    } as any)).id;
  });

  afterAll(async () => {
    if (!hasDb) return;
    if (jobId) await pool.query(`DELETE FROM eval_jobs WHERE id = $1`, [jobId]);
    if (evalFlowId) await pool.query(`DELETE FROM eval_flows WHERE id = $1`, [evalFlowId]);
    if (userId) await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  it("freezes transport at job creation; later evalFlow edits don't rewrite it", async () => {
    const providers = await storage.getAllProviders();
    expect(providers.length).toBeGreaterThan(0);

    const wf = await storage.createEvalFlow({
      name: `phA-wf-${suffix}`, ownerId: userId, providerId: providers[0].id,
      transport: "phone", visibility: "private", config: {},
    } as any);
    evalFlowId = wf.id;
    expect(wf.transport).toBe("phone");

    const snap = buildJobSnapshot(wf, null, providers[0], "principal");
    expect(snap.transport).toBe("phone");

    const job = await storage.createEvalJob({
      evalFlowId: wf.id, triggerType: 2, evalSetId: null, createdBy: userId,
      siteId: null, targetRegion: "na-us-ashburn", targetTier: "private",
      config: {}, snapshot: snap,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    jobId = job.id;
    expect(job.transport).toBe("phone"); // stamped column

    // Edit the live evalFlow — the frozen job must not move.
    await storage.updateEvalFlow(wf.id, { transport: "web" } as any);
    const reread = await storage.getEvalJob(job.id);
    expect(reread!.transport).toBe("phone");
    expect((reread!.snapshot as any).transport).toBe("phone");
  });

  it("defaults to web when the evalFlow has no transport (snapshot)", async () => {
    const providers = await storage.getAllProviders();
    const wf = await storage.createEvalFlow({
      name: `phA-wf-web-${suffix}`, ownerId: userId, providerId: providers[0].id,
      visibility: "private", config: {},
    } as any);
    try {
      expect(wf.transport).toBe("web");
      const snap = buildJobSnapshot(wf, null, providers[0], "basic");
      expect(snap.transport).toBe("web");
    } finally {
      await pool.query(`DELETE FROM eval_flows WHERE id = $1`, [wf.id]);
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
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: creatorId,
      siteId: null, targetRegion: "na-us-ashburn", targetTier: "private",
      config: {},
      snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null, transport } as any,
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
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: creatorId,
      siteId: null, targetRegion: "na-us-ashburn", targetTier: "private",
      config: {},
      snapshot: { provider: { id: providerId, name: "p", platformId: null }, evalFlow: null, evalSet: null, creatorPlan: "basic", transport } as any,
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

d("phone transport — evalFlow API (HTTP, dev server)", () => {
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
    await pool.query(`DELETE FROM eval_flows WHERE id = ANY($1::int[])`, [created]);
  });

  const mkEvalFlow = async (body: Record<string, unknown>) => {
    const providers = await storage.getAllProviders();
    const res = await fetch(`${BASE_URL}/api/eval-flows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `phA-http-${suffix}-${Math.random().toString(36).slice(2, 8)}`, providerId: providers[0].id, ...body }),
    });
    return res;
  };

  it("create accepts transport=phone and echoes it; default is web", async () => {
    const res = await mkEvalFlow({ transport: "phone" });
    expect(res.ok).toBe(true);
    const wf = await res.json();
    created.push(wf.id);
    expect(wf.transport).toBe("phone");

    const res2 = await mkEvalFlow({});
    const wf2 = await res2.json();
    created.push(wf2.id);
    expect(wf2.transport).toBe("web");
  });

  it("rejects an invalid transport with 400", async () => {
    const res = await mkEvalFlow({ transport: "carrier-pigeon" });
    expect(res.status).toBe(400);
  });

  it("validates Setup step scripts per mode and refuses running a phone evalFlow without call establishment", async () => {
    // Clean cut: the old per-mode config keys are rejected with pointer errors.
    const legacyDial = await mkEvalFlow({ transport: "phone", config: { phoneDial: { number: "+15551234" } } });
    expect(legacyDial.status).toBe(400);
    expect((await legacyDial.json()).error).toContain("call.dial step");
    const legacyTrigger = await mkEvalFlow({ transport: "phone", config: { restfulTrigger: { method: "POST", url: "https://x.example/y" } } });
    expect(legacyTrigger.status).toBe(400);
    expect((await legacyTrigger.json()).error).toContain("restful.request step");

    // Vocabulary is transport-scoped.
    const badNumber = await mkEvalFlow({ transport: "phone", config: { stepsPrefix: "- type: call.dial\n  number: abc\n" } });
    expect(badNumber.status).toBe(400);
    const webVocabOnPhone = await mkEvalFlow({ transport: "phone", config: { stepsPrefix: "- type: platform.setup\n" } });
    expect(webVocabOnPhone.status).toBe(400);
    expect((await webVocabOnPhone.json()).error).toContain("web-session vocabulary");
    const phoneVocabOnWeb = await mkEvalFlow({ transport: "web", config: { stepsPrefix: "- type: call.dial\n  number: \"+15551234\"\n" } });
    expect(phoneVocabOnWeb.status).toBe(400);
    expect((await phoneVocabOnWeb.json()).error).toContain("phone vocabulary");

    const okDial = await mkEvalFlow({
      transport: "phone",
      config: { stepsPrefix: '- type: call.dial\n  number: "+1 (555) 010-1234"\n- type: call.wait_answered\n', stepsSuffix: "- type: call.hangup\n" },
    });
    expect(okDial.ok).toBe(true);
    created.push((await okDial.json()).id);

    // Phone evalFlow with EMPTY Setup: creatable, but running it is refused at
    // the source (unified-steps §4 — nothing would establish a call).
    const bare = await mkEvalFlow({ transport: "phone" });
    const bareWf = await bare.json();
    created.push(bareWf.id);
    const run = await fetch(`${BASE_URL}/api/eval-flows/${bareWf.id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ region: "na-us-ashburn", targetTier: "private" }),
    });
    expect(run.status).toBe(400);
    expect((await run.json()).error).toContain("establish no call");

    // Trigger-only Setup (restful.request, no call.dial): authorable, but the
    // run names the R7 gap.
    const triggerOnly = await mkEvalFlow({
      transport: "phone",
      config: { stepsPrefix: '- type: restful.request\n  method: POST\n  url: "https://x.example/call"\n' },
    });
    expect(triggerOnly.ok).toBe(true);
    const triggerWf = await triggerOnly.json();
    created.push(triggerWf.id);
    const runTrigger = await fetch(`${BASE_URL}/api/eval-flows/${triggerWf.id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ region: "na-us-ashburn", targetTier: "private" }),
    });
    expect(runTrigger.status).toBe(400);
    expect((await runTrigger.json()).error).toContain("DialF R7");
  });

  it("PATCH can flip transport", async () => {
    const res = await mkEvalFlow({});
    const wf = await res.json();
    created.push(wf.id);
    const patch = await fetch(`${BASE_URL}/api/eval-flows/${wf.id}`, {
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

// Practical round-trip: the whole steps model through the REAL API — save
// validation, the run gate, snapshot freezing, and the config merge the
// daemon will read. This is the server half of what the daemon splitter
// consumes (the daemon half is tests/phone-eval.test.ts's runPhoneJob).
d("unified steps — full run path (API round-trip)", () => {
  let cookie: string;
  let evalFlowId: number;
  let evalSetId: number;
  let jobId: number;

  const SETUP = '- type: call.dial\n  number: "+1 408 837 5890"\n- type: call.wait_answered\n';
  const TEARDOWN = "- type: call.hangup\n";
  const SCENARIO = "name: steps-roundtrip\nsteps:\n  - type: audio.play\n    corpus_id: known_q1\n  - type: audio.wait_for_speech\n    end_timeout_ms: 30000\n";

  beforeAll(async () => {
    const login = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@vox.local", password: "admin123456" }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
  });

  afterAll(async () => {
    if (!hasDb) return;
    if (jobId) await pool.query(`DELETE FROM eval_jobs WHERE id = $1`, [jobId]);
    if (evalFlowId) await pool.query(`DELETE FROM eval_flows WHERE id = $1`, [evalFlowId]);
    if (evalSetId) await pool.query(`DELETE FROM eval_sets WHERE id = $1`, [evalSetId]);
  });

  const post = (path: string, body: Record<string, unknown>) =>
    fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });

  it("create → run → frozen snapshot + merged job config carry the steps the daemon will split", async () => {
    const providers = await storage.getAllProviders();
    const wfRes = await post("/api/eval-flows", {
      name: `steps-rt-wf-${suffix}`, providerId: providers[0].id, transport: "phone",
      config: { framework: "aeval", stepsPrefix: SETUP, stepsSuffix: TEARDOWN },
    });
    expect(wfRes.ok).toBe(true);
    evalFlowId = (await wfRes.json()).id;

    const esRes = await post("/api/eval-sets", {
      name: `steps-rt-es-${suffix}`, visibility: "public", config: { scenario: SCENARIO },
    });
    expect(esRes.ok).toBe(true);
    evalSetId = (await esRes.json()).id;

    const runRes = await post(`/api/eval-flows/${evalFlowId}/run`, {
      evalSetId, region: "na-us-seattle", targetTier: "private",
    });
    expect(runRes.ok, `run failed: ${await runRes.clone().text()}`).toBe(true);
    jobId = (await runRes.json()).job.id;

    const job = await storage.getEvalJob(jobId);
    expect(job!.transport).toBe("phone"); // stamped column

    // The FROZEN snapshot carries the steps — the restful endpoint and all
    // provenance reads use this copy, never the live row.
    const snapConfig = (job!.snapshot as any).evalFlow.config as Record<string, unknown>;
    expect(snapConfig.stepsPrefix).toBe(SETUP);
    expect(snapConfig.stepsSuffix).toBe(TEARDOWN);

    // The merged job config is the daemon's input: evalFlow steps + eval-set
    // scenario, exactly what executePhoneJob parses and splits.
    const jobConfig = job!.config as Record<string, unknown>;
    expect(jobConfig.stepsPrefix).toBe(SETUP);
    expect(jobConfig.stepsSuffix).toBe(TEARDOWN);
    expect(String(jobConfig.scenario)).toContain("audio.play");

    // Editing the live evalFlow's steps never rewrites the frozen job.
    const patch = await fetch(`${BASE_URL}/api/eval-flows/${evalFlowId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ config: { framework: "aeval", stepsPrefix: '- type: call.dial\n  number: "+1 999 999 9999"\n', stepsSuffix: TEARDOWN } }),
    });
    expect(patch.ok).toBe(true);
    const reread = await storage.getEvalJob(jobId);
    expect(((reread!.snapshot as any).evalFlow.config as Record<string, unknown>).stepsPrefix).toBe(SETUP);
  });

  it("PATCH revalidates the RESULTING transport/config pair: a web evalFlow with platform steps can't silently flip to phone", async () => {
    const providers = await storage.getAllProviders();
    const wfRes = await post("/api/eval-flows", {
      name: `steps-rt-flip-${suffix}`, providerId: providers[0].id, transport: "web",
      config: { framework: "aeval", stepsPrefix: "- type: platform.setup\n  platform_id: livekit\n" },
    });
    expect(wfRes.ok).toBe(true);
    const flipWfId = (await wfRes.json()).id as number;
    try {
      // Transport-only flip: the EXISTING config is re-validated against phone.
      const flip = await fetch(`${BASE_URL}/api/eval-flows/${flipWfId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ transport: "phone" }),
      });
      expect(flip.status).toBe(400);
      expect((await flip.json()).error).toContain("web-session vocabulary");

      // Flipping transport TOGETHER with a valid phone config succeeds.
      const flipWithConfig = await fetch(`${BASE_URL}/api/eval-flows/${flipWfId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ transport: "phone", config: { framework: "aeval", stepsPrefix: SETUP, stepsSuffix: TEARDOWN } }),
      });
      expect(flipWithConfig.ok).toBe(true);
      expect((await flipWithConfig.json()).transport).toBe("phone");
    } finally {
      await pool.query(`DELETE FROM eval_flows WHERE id = $1`, [flipWfId]);
    }
  });
});

// An evalFlow whose framework this build can't run (only reachable as a
// pre-existing row — the validator rejects it at save) must never produce
// a job: refused at the run route, and its schedule disabled by the
// scheduler rather than firing failures forever.
d("unsupported framework — run refused, schedule disabled", () => {
  let cookie: string;
  let wfId: number;
  let scheduleId: number;
  let evalSetId: number;

  beforeAll(async () => {
    const login = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@vox.local", password: "admin123456" }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0];

    const providers = await storage.getAllProviders();
    // Written through storage, bypassing the validator — exactly the shape a
    // pre-existing row has after its framework is removed from the build.
    const wf = await storage.createEvalFlow({
      name: `unsupported-fw-${suffix}`, ownerId: 1, providerId: providers[0].id,
      visibility: "private", config: { framework: "some-removed-framework", scenario: undefined },
    } as any);
    wfId = wf.id;
    const es = await storage.createEvalSet({
      name: `unsupported-fw-es-${suffix}`, ownerId: 1, visibility: "private",
      config: { scenario: "steps: []" },
    } as any);
    evalSetId = es.id;
    const sched = await storage.createEvalSchedule({
      name: `unsupported-fw-sched-${suffix}`, evalFlowId: wf.id, evalSetId: es.id,
      region: "na-us-seattle", targetTier: "private", scheduleType: "recurring",
      cronExpression: "0 * * * *", isEnabled: true, createdBy: 1,
      nextRunAt: new Date(Date.now() - 60_000), // due now
    } as any);
    scheduleId = sched.id;
  });

  afterAll(async () => {
    if (!hasDb) return;
    await pool.query(`DELETE FROM eval_jobs WHERE eval_flow_id = $1`, [wfId]);
    if (scheduleId) await pool.query(`DELETE FROM eval_schedules WHERE id = $1`, [scheduleId]);
    if (wfId) await pool.query(`DELETE FROM eval_flows WHERE id = $1`, [wfId]);
    if (evalSetId) await pool.query(`DELETE FROM eval_sets WHERE id = $1`, [evalSetId]);
  });

  it("the run route refuses it instead of creating a job that fails at the daemon", async () => {
    const res = await fetch(`${BASE_URL}/api/eval-flows/${wfId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ evalSetId, region: "na-us-seattle", targetTier: "private" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("cannot run");
  });

  it("the scheduler disables its schedule on the next tick", async () => {
    const { processScheduledJobs } = await import("../server/scheduler");
    await processScheduledJobs();
    const after = await storage.getEvalSchedule(scheduleId);
    expect(after!.isEnabled).toBe(false);
    // And it created nothing.
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM eval_jobs WHERE eval_flow_id = $1`, [wfId]);
    expect(rows[0].n).toBe(0);
  });
});
