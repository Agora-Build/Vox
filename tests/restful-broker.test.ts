import * as yamlLib from "js-yaml";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage, pool } from "../server/storage";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

// Phase B of Phone vs Agent (designs/2026-09-21-phone-vs-agent-design.md §5):
// the `restful` secret class rides the existing broker-type registry — creation
// accepts it, reclassification to runtime is blocked for ANY brokered class,
// and the structural withhold (brokerType != null ⇒ Core-only) covers it with
// zero changes, regression-locked here.

const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const adminLogin = async (): Promise<string> => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@vox.local", password: "admin123456" }),
  });
  expect(login.ok).toBe(true);
  return login.headers.get("set-cookie")!.split(";")[0];
};

describe("resolveRestfulTemplate (unit)", () => {
  const trigger = {
    method: "POST" as const,
    url: "https://t.example/v1/calls?key=${secrets.API_KEY}",
    headers: { Authorization: "Bearer ${secrets.API_KEY}" },
    body: { to: "${phoneNumber}", nested: [{ note: "ref ${secrets.OTHER}" }] },
    expectStatus: [201],
  };

  it("resolves secrets + phoneNumber everywhere and reports used values", async () => {
    const { resolveRestfulTemplate } = await import("../server/restful-exec");
    const out = resolveRestfulTemplate(trigger, { API_KEY: "sek1", OTHER: "sek2" }, { phoneNumber: "+15550001111" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.request.url).toBe("https://t.example/v1/calls?key=sek1");
    expect(out.request.headers!.Authorization).toBe("Bearer sek1");
    expect((out.request.body as any).to).toBe("+15550001111");
    expect((out.request.body as any).nested[0].note).toBe("ref sek2");
    expect(out.usedSecretValues.sort()).toEqual(["sek1", "sek2"]);
  });

  it("percent-encodes ${phoneNumber} in the URL position only (carrier formats carry spaces/parens)", async () => {
    const { resolveRestfulTemplate } = await import("../server/restful-exec");
    const out = resolveRestfulTemplate(
      { method: "POST", url: "https://t.example/dial/${phoneNumber}", body: { to: "${phoneNumber}" } },
      {},
      { phoneNumber: "+1 (555) 010-1234" },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.request.url).toBe(`https://t.example/dial/${encodeURIComponent("+1 (555) 010-1234")}`);
    expect((out.request.body as any).to).toBe("+1 (555) 010-1234"); // body stays raw
  });

  it("unresolved secret name errors with the name only; missing phoneNumber errors", async () => {
    const { resolveRestfulTemplate } = await import("../server/restful-exec");
    const bad = resolveRestfulTemplate(trigger, { API_KEY: "sek1" }, { phoneNumber: "+1" });
    expect(bad).toEqual({ ok: false, error: "unresolved secret reference: OTHER" });
    const noPhone = resolveRestfulTemplate(trigger, { API_KEY: "sek1", OTHER: "sek2" }, {});
    expect(noPhone.ok).toBe(false);
  });
});

describe("executeViaBroker (unit, injected fetch)", () => {
  const target = { id: 1, url: "http://rest-broker.internal:9101", mintSecret: "ms-secret" };

  it("happy path: posts to /execute with bearer auth, computes ok from expectStatus", async () => {
    const { executeViaBroker } = await import("../server/broker-registry");
    const calls: any[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ status: 201, bodyExcerpt: "id=7" }), { status: 200 });
    }) as any;
    const out = await executeViaBroker(target, { method: "POST", url: "https://t.example/x", expectStatus: [201] }, [], fetchImpl);
    expect(out).toEqual({ status: 201, ok: true, bodyExcerpt: "id=7" });
    expect(calls[0].url).toBe(`${target.url}/execute`);
    expect(calls[0].init.headers.authorization).toBe("Bearer ms-secret");
  });

  it("redacts needles in bodyExcerpt and caps it", async () => {
    const { executeViaBroker } = await import("../server/broker-registry");
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ status: 200, bodyExcerpt: `token=sekret123 ${"x".repeat(5000)}` }), { status: 200 })) as any;
    const out = await executeViaBroker(target, { method: "GET", url: "https://t.example/x" }, ["sekret123"], fetchImpl);
    expect(out.bodyExcerpt).not.toContain("sekret123");
    expect(out.bodyExcerpt.length).toBeLessThanOrEqual(2048);
    expect(out.ok).toBe(true); // default expectStatus = 2xx
  });

  it("broker failure throws a redacted, capped message", async () => {
    const { executeViaBroker } = await import("../server/broker-registry");
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "upstream said sekret123 is wrong" }), { status: 502 })) as any;
    await expect(
      executeViaBroker(target, { method: "GET", url: "https://t.example/x" }, ["sekret123"], fetchImpl),
    ).rejects.toThrow(/broker exec failed: 502(?!.*sekret123)/);
  });

  it("out-of-expectStatus target status yields ok:false without throwing", async () => {
    const { executeViaBroker } = await import("../server/broker-registry");
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ status: 404, bodyExcerpt: "not found" }), { status: 200 })) as any;
    const out = await executeViaBroker(target, { method: "GET", url: "https://t.example/x" }, [], fetchImpl);
    expect(out).toEqual({ status: 404, ok: false, bodyExcerpt: "not found" });
  });
});

d("restful.request step validation (evalFlow Setup Steps)", () => {
  let cookie: string;
  const created: number[] = [];

  beforeAll(async () => {
    cookie = await adminLogin();
  });

  afterAll(async () => {
    if (!hasDb || created.length === 0) return;
    await pool.query(`DELETE FROM eval_flows WHERE id = ANY($1::int[])`, [created]);
  });

  const mkEvalFlow = async (config: Record<string, unknown>) => {
    const providers = await storage.getAllProviders();
    return fetch(`${BASE_URL}/api/eval-flows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: `phB_wf_${suffix}_${Math.random().toString(36).slice(2, 8)}`,
        providerId: providers[0].id, transport: "phone", config,
      }),
    });
  };

  const stepYaml = (fields: Record<string, unknown>) =>
    yamlLib.dump([{ type: "restful.request", ...fields }]);

  it("accepts a valid restful.request Setup step", async () => {
    const res = await mkEvalFlow({
      stepsPrefix: stepYaml({
        method: "POST",
        url: "https://api.example.com/v1/calls",
        headers: { Authorization: "Bearer ${secrets.PHB_KEY}" },
        body: { to: "${phoneNumber}" },
        expectStatus: [200, 201],
        timeoutMs: 20000,
      }),
    });
    expect(res.ok).toBe(true);
    created.push((await res.json()).id);
  });

  it("rejects a bad method, non-https url, oversized timeout, unknown field, and Teardown placement", async () => {
    const bad = async (fields: Record<string, unknown>) => {
      const res = await mkEvalFlow({ stepsPrefix: stepYaml({ method: "POST", url: "https://x.example/y", ...fields }) });
      expect(res.status).toBe(400);
    };
    await bad({ method: "BREW" });
    await bad({ url: "ftp://x.example/y" });
    await bad({ timeoutMs: 999999 });
    await bad({ unknownField: 1 });
    // restful.request is a pre-call Setup step — Teardown placement is illegal.
    const teardown = await mkEvalFlow({ stepsSuffix: stepYaml({ method: "POST", url: "https://x.example/y" }) });
    expect(teardown.status).toBe(400);
    expect((await teardown.json()).error).toContain("illegal in Teardown");
  });

  it("rejects the deleted restfulTrigger config key with a pointer error", async () => {
    const res = await mkEvalFlow({ restfulTrigger: { method: "POST", url: "https://x.example/y" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("restful.request step");
  });
});

d("POST /api/eval-agent/jobs/:jobId/restful (integration, fake broker)", () => {
  let ownerId: number;
  let tokId: number;
  let agentId: number;
  let jobId: number;
  let noTriggerJobId: number;
  let nonLeadingJobId: number;
  let brokerId: number;
  let evalFlowId: number;
  let fakeBroker: import("http").Server;
  let brokerPort: number;
  const brokerSeen: any[] = [];
  const rawAgentToken = `phB_exec_agent_${suffix}`;
  const rawRegToken = `phB_exec_reg_${suffix}`;
  const secretName = `PHB_EXEC_KEY_${suffix}`;

  beforeAll(async () => {
    const { hashToken } = await import("../server/storage");
    const { encryptValue } = await import("../server/storage");
    const http = await import("http");

    // Fake REST broker: records what Core sends, replies like a broker would.
    fakeBroker = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        brokerSeen.push({ auth: req.headers.authorization, body: JSON.parse(data || "{}") });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: 201, bodyExcerpt: `created; sawAuth=${JSON.parse(data).headers?.Authorization}` }));
      });
    });
    await new Promise<void>((r) => fakeBroker.listen(0, "127.0.0.1", () => r()));
    brokerPort = (fakeBroker.address() as any).port;

    // Owner + restful secret + evalFlow with a trigger template.
    ownerId = (await storage.createUser({
      username: `phBexec${suffix}`, email: `phBexec${suffix}@example.com`,
    } as any)).id;
    await storage.createOrUpdateSecret(ownerId, secretName, encryptValue("sekret123"), { brokerType: "restful" });
    const providers = await storage.getAllProviders();
    const wf = await storage.createEvalFlow({
      name: `phB_exec_wf_${suffix}`, ownerId, providerId: providers[0].id,
      transport: "phone", visibility: "private",
      config: {
        stepsPrefix: [
          "- type: restful.request",
          "  method: POST",
          '  url: "https://target.example/v1/calls"',
          "  headers:",
          `    Authorization: "Bearer \${secrets.${secretName}}"`,
          "  body:",
          '    to: "${phoneNumber}"',
          "  expectStatus: [201]",
          "",
        ].join("\n"),
      },
    } as any);
    evalFlowId = wf.id;

    // Agent token + agent + claimed phone job with the FROZEN snapshot.
    const tok = await storage.createEvalAgentToken({
      name: `phB_exec_tok_${suffix}`, tokenHash: hashToken(rawAgentToken),
      siteId: "na-us-ashburn-01", dispatchTier: "private", createdBy: ownerId,
    } as any);
    tokId = tok.id;
    agentId = (await storage.createEvalAgent({
      tokenId: tok.id, name: `phB_exec_ag_${suffix}`, siteId: "na-us-ashburn-01",
      state: "idle", metadata: {}, capabilities: ["phone"],
    } as any)).id;

    const { buildJobSnapshot } = await import("../server/storage");
    const snap = buildJobSnapshot(wf, null, providers[0], "basic");
    const mkJob = async (snapshot: any) => {
      const j = await storage.createEvalJob({
        evalFlowId: wf.id, triggerType: 2, evalSetId: null, createdBy: ownerId,
        siteId: null, targetRegion: "na-us-ashburn", targetTier: "private",
        config: {}, snapshot, status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
      } as any);
      const claimed = await storage.claimEvalJob(j.id, agentId, {
        id: tok.id, siteId: "na-us-ashburn-01", region: "na-us-ashburn", dispatchTier: "private",
        createdBy: ownerId, ownerOrgId: null, locationTrust: "trusted", phoneCapable: true,
      } as any);
      expect(claimed).toBeDefined();
      return j.id;
    };
    jobId = await mkJob(snap);
    noTriggerJobId = await mkJob({ ...snap, evalFlow: { ...snap.evalFlow!, config: {} } });
    // A snapshot whose restful step is NOT in the leading run (save-time
    // validation forbids this — built directly to prove the endpoint is
    // self-contained about the ordering rule).
    nonLeadingJobId = await mkJob({
      ...snap,
      evalFlow: {
        ...snap.evalFlow!,
        config: {
          stepsPrefix: '- type: call.dial\n  number: "+15551234"\n- type: restful.request\n  method: POST\n  url: "https://target.example/v1/calls"\n',
        },
      },
    });

    // Register the fake broker through the REAL registration flow so the dev
    // server's in-process mint-secret cache is populated.
    await storage.createBrokerRegistrationToken({
      name: `phB_exec_breg_${suffix}`, tokenHash: hashToken(rawRegToken), createdBy: ownerId,
    } as any);
    const reg = await fetch(`${BASE_URL}/api/brokers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawRegToken}` },
      body: JSON.stringify({ name: `phB-rest-${suffix}`, brokerType: "restful", url: `http://localhost:${brokerPort}` }),
    });
    expect(reg.ok).toBe(true);
    brokerId = (await reg.json()).brokerId;
  });

  afterAll(async () => {
    if (!hasDb) return;
    await new Promise<void>((r) => fakeBroker?.close(() => r()));
    await pool.query(`DELETE FROM brokers WHERE id = $1`, [brokerId]);
    await pool.query(`DELETE FROM broker_registration_tokens WHERE name = $1`, [`phB_exec_breg_${suffix}`]);
    await pool.query(`DELETE FROM eval_jobs WHERE id = ANY($1::int[])`, [[jobId, noTriggerJobId, nonLeadingJobId].filter(Boolean)]);
    await pool.query(`DELETE FROM eval_agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM eval_agent_tokens WHERE id = $1`, [tokId]);
    await pool.query(`DELETE FROM eval_flows WHERE id = $1`, [evalFlowId]);
    await pool.query(`DELETE FROM secrets WHERE name = $1`, [secretName]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [ownerId]);
  });

  const callEndpoint = (id: number, body: Record<string, unknown> = {}) =>
    fetch(`${BASE_URL}/api/eval-agent/jobs/${id}/restful`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawAgentToken}` },
      body: JSON.stringify({ agentId, stepIndex: 0, variables: { phoneNumber: "+15550001111" }, ...body }),
    });

  it("resolves the frozen template, dispatches via the broker, returns a redacted result", async () => {
    const res = await callEndpoint(jobId);
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.status).toBe(201);
    expect(out.ok).toBe(true);
    // The broker echoed the resolved Authorization header; Core must redact it.
    expect(out.bodyExcerpt).not.toContain("sekret123");

    // What Core actually sent to the broker: mint-secret auth + fully resolved template.
    expect(brokerSeen.length).toBe(1);
    expect(brokerSeen[0].auth).toMatch(/^Bearer .+/);
    expect(brokerSeen[0].body.url).toBe("https://target.example/v1/calls");
    expect(brokerSeen[0].body.headers.Authorization).toBe("Bearer sekret123");
    expect(brokerSeen[0].body.body.to).toBe("+15550001111");
  });

  it("400 when the snapshot's Setup has no restful.request at the index (or no steps at all)", async () => {
    const res = await callEndpoint(noTriggerJobId);
    expect(res.status).toBe(400);
    // Index addressing is strict: pointing past the script or at a non-restful
    // step is a 400, and the stepIndex itself is mandatory.
    const past = await callEndpoint(jobId, { stepIndex: 7 });
    expect(past.status).toBe(400);
    const missing = await callEndpoint(jobId, { stepIndex: undefined });
    expect(missing.status).toBe(400);
    // Self-contained ordering: a restful step outside the leading run is
    // refused even though it IS a restful.request at that index.
    const nonLeading = await callEndpoint(nonLeadingJobId, { stepIndex: 1 });
    expect(nonLeading.status).toBe(400);
    expect((await nonLeading.json()).error).toContain("leading");
    // phoneNumber substitutes into the URL — anything outside the dialable
    // shape (URL delimiters, authority syntax) is refused at the boundary.
    const redirect = await callEndpoint(jobId, { variables: { phoneNumber: "evil.example/#" } });
    expect(redirect.status).toBe(400);
    expect((await redirect.json()).error).toContain("phone number");
  });

  it("503 when no live restful broker exists", async () => {
    await pool.query(`UPDATE brokers SET last_seen_at = NOW() - interval '1 hour' WHERE id = $1`, [brokerId]);
    const res = await callEndpoint(jobId);
    expect(res.status).toBe(503);
    await pool.query(`UPDATE brokers SET last_seen_at = NOW() WHERE id = $1`, [brokerId]);
  });
});

d("GET /api/broker-types offers every known class", () => {
  it("returns all KNOWN_BROKER_TYPES with a live flag (not just live ones)", async () => {
    const cookie = await adminLogin();
    const res = await fetch(`${BASE_URL}/api/broker-types`, { headers: { Cookie: cookie } });
    expect(res.ok).toBe(true);
    const types = (await res.json()) as Array<{ id: string; live: boolean }>;
    const ids = types.map((t) => t.id).sort();
    // The secret-class dropdown must offer restful even with no live broker —
    // configuring ahead of broker deployment is legitimate; execution fails
    // visibly at run time (503) when none is live.
    expect(ids).toEqual(["auth-session", "restful"]);
    expect(types.every((t) => typeof t.live === "boolean")).toBe(true);
  });
});

d("restful secret class", () => {
  let cookie: string;
  const secretName = `PHB_TRIGGER_KEY_${suffix}`;

  beforeAll(async () => {
    cookie = await adminLogin();
  });

  afterAll(async () => {
    if (!hasDb) return;
    await pool.query(`DELETE FROM secrets WHERE name = $1`, [secretName]);
  });

  const postSecret = (body: Record<string, unknown>) =>
    fetch(`${BASE_URL}/api/secrets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: secretName, value: "v1", ...body }),
    });

  it("accepts brokerType 'restful' and echoes it", async () => {
    const res = await postSecret({ brokerType: "restful" });
    expect(res.ok).toBe(true);
    expect((await res.json()).brokerType).toBe("restful");
  });

  it("rejects an unknown brokerType", async () => {
    const res = await postSecret({ brokerType: "jetpack" });
    expect(res.status).toBe(400);
  });

  it("value-only update preserves the class; explicit null reclassification is blocked", async () => {
    const keep = await postSecret({ value: "v2" });
    expect(keep.ok).toBe(true);
    expect((await keep.json()).brokerType).toBe("restful");

    const downgrade = await postSecret({ value: "v3", brokerType: null });
    expect(downgrade.status).toBe(400);
  });

  it("is structurally withheld from the job-secrets path", async () => {
    // getSecretsForJob returns the evalFlow owner's RUNTIME rows only.
    const admin = await storage.getUserByEmail("admin@vox.local");
    const providers = await storage.getAllProviders();
    const wf = await storage.createEvalFlow({
      name: `phB-wf-${suffix}`, ownerId: admin!.id, providerId: providers[0].id,
      visibility: "private", config: {},
    } as any);
    const job = await storage.createEvalJob({
      evalFlowId: wf.id, triggerType: 2, evalSetId: null, createdBy: admin!.id,
      siteId: null, targetRegion: "na-us-ashburn", targetTier: "private",
      config: {}, snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    try {
      const rows = await storage.getSecretsForJob(job.id);
      expect(rows.find((s) => s.name === secretName)).toBeUndefined();
    } finally {
      await pool.query(`DELETE FROM eval_jobs WHERE id = $1`, [job.id]);
      await pool.query(`DELETE FROM eval_flows WHERE id = $1`, [wf.id]);
    }
  });
});
