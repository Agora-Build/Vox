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

d("restfulTrigger workflow-config validation", () => {
  let cookie: string;
  const created: number[] = [];

  beforeAll(async () => {
    cookie = await adminLogin();
  });

  afterAll(async () => {
    if (!hasDb || created.length === 0) return;
    await pool.query(`DELETE FROM workflows WHERE id = ANY($1::int[])`, [created]);
  });

  const mkWorkflow = async (config: Record<string, unknown>) => {
    const providers = await storage.getAllProviders();
    return fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: `phB_wf_${suffix}_${Math.random().toString(36).slice(2, 8)}`,
        providerId: providers[0].id, transport: "phone", config,
      }),
    });
  };

  it("accepts a valid restfulTrigger", async () => {
    const res = await mkWorkflow({
      restfulTrigger: {
        method: "POST",
        url: "https://api.example.com/v1/calls",
        headers: { Authorization: "Bearer ${secrets.PHB_KEY}" },
        body: { to: "${phoneNumber}" },
        expectStatus: [200, 201],
        timeoutMs: 20000,
      },
    });
    expect(res.ok).toBe(true);
    created.push((await res.json()).id);
  });

  it("rejects a bad method, non-https url, and oversized timeout", async () => {
    const bad = async (trigger: Record<string, unknown>) => {
      const res = await mkWorkflow({ restfulTrigger: { method: "POST", url: "https://x.example/y", ...trigger } });
      expect(res.status).toBe(400);
    };
    await bad({ method: "BREW" });
    await bad({ url: "ftp://x.example/y" });
    await bad({ timeoutMs: 999999 });
    await bad({ unknownField: 1 });
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
    // getSecretsForJob returns the workflow owner's RUNTIME rows only.
    const admin = await storage.getUserByEmail("admin@vox.local");
    const providers = await storage.getAllProviders();
    const wf = await storage.createWorkflow({
      name: `phB-wf-${suffix}`, ownerId: admin!.id, providerId: providers[0].id,
      visibility: "private", config: {},
    } as any);
    const job = await storage.createEvalJob({
      workflowId: wf.id, triggerType: 2, evalSetId: null, createdBy: admin!.id,
      siteId: null, targetRegion: "na-us-ashburn", targetTier: "private",
      config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    try {
      const rows = await storage.getSecretsForJob(job.id);
      expect(rows.find((s) => s.name === secretName)).toBeUndefined();
    } finally {
      await pool.query(`DELETE FROM eval_jobs WHERE id = $1`, [job.id]);
      await pool.query(`DELETE FROM workflows WHERE id = $1`, [wf.id]);
    }
  });
});
