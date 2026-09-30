import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage, pool } from "../server/storage";
import { makeWav } from "./fixtures/make-wav";

// Tools → Analyze API (design 2026-09-30), against the running dev server.
// Every refusal here happens before any S3 call, so the storage config below
// can hold placeholder values; the real upload → analysis path is
// tests/practical-analyze.test.ts.
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  expect(res.ok).toBe(true);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

/** A fresh user on `plan`, logged in. */
async function newUser(admin: string, plan: "basic" | "premium"): Promise<{ id: number; cookie: string }> {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const email = `analyze-api-${stamp}@example.com`;
  const inv = await fetch(`${BASE_URL}/api/admin/invite`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: admin }, body: JSON.stringify({ email, plan }),
  });
  const { token } = await inv.json();
  const reg = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: `analyzeapi${stamp}`, password: "TestPass123!", token }),
  });
  expect(reg.ok).toBe(true);
  const id = (await pool.query("SELECT id FROM users WHERE email = $1", [email])).rows[0].id as number;
  return { id, cookie: await login(email, "TestPass123!") };
}

d("Tools → Analyze API", () => {
  let admin = "";
  let user: { id: number; cookie: string };
  let other: { id: number; cookie: string };
  let provider = "";
  let region = "";
  const stereo = makeWav({ channels: 2, rate: 16000, bits: 16, seconds: 1 });

  const upload = (cookie: string, body: Uint8Array, q: Record<string, string>) =>
    fetch(`${BASE_URL}/api/tools/analyze?${new URLSearchParams(q)}`, {
      method: "POST", headers: { "Content-Type": "audio/wav", Cookie: cookie }, body,
    });
  const good = () => ({ provider, region, source: "web", fileName: "call.wav" });

  beforeAll(async () => {
    admin = await login("admin@vox.local", "admin123456");
    user = await newUser(admin, "premium");
    other = await newUser(admin, "premium");
    provider = (await storage.getAllProviders())[0].id;
    region = (await storage.getAllRegionLocations())[0].baseId;
  });

  afterAll(async () => {
    if (!user) return;
    const ids = [user.id, other.id];
    await pool.query("DELETE FROM eval_jobs WHERE created_by = ANY($1)", [ids]);
    await pool.query("DELETE FROM user_storage_config WHERE user_id = ANY($1)", [ids]);
  });

  it("without storage: 409, and says so", async () => {
    const res = await upload(user.cookie, stereo, good());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ needs: "storage" });
  });

  it("with storage: each bad input is refused with 400 and a reason", async () => {
    const put = await fetch(`${BASE_URL}/api/user/storage-config`, {
      method: "PUT", headers: { "Content-Type": "application/json", Cookie: user.cookie },
      body: JSON.stringify({ s3Endpoint: "https://s3.invalid", s3Bucket: "b", s3AccessKeyId: "placeholder-id", s3SecretAccessKey: "placeholder-secret" }),
    });
    expect(put.ok).toBe(true);

    const cases: Array<[Uint8Array, Record<string, string>, RegExp]> = [
      [makeWav({ channels: 1, rate: 16000, bits: 16, seconds: 1 }), good(), /stereo/],
      [new TextEncoder().encode("not audio at all, not even close"), good(), /WAV/],
      [stereo, { ...good(), provider: "nope" }, /provider/i],
      [stereo, { ...good(), region: "xx-nowhere" }, /region/i],
      [stereo, { ...good(), source: "carrier-pigeon" }, /source/i],
    ];
    for (const [body, q, reason] of cases) {
      const res = await upload(user.cookie, body, q);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(reason);
    }
    // Nothing was created by any of them.
    expect((await pool.query("SELECT count(*)::int c FROM eval_jobs WHERE created_by = $1", [user.id])).rows[0].c).toBe(0);
  });

  it("a Basic user is told Analyze needs Premium — before Core reads the body", async () => {
    const basic = await newUser(admin, "basic");
    try {
      const res = await upload(basic.cookie, stereo, good());
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ needs: "premium" });
      // A body over the upload limit: refused as Basic (409), not buffered
      // first and refused as too large (413).
      const big = await upload(basic.cookie, new Uint8Array(101 * 1024 * 1024), good());
      expect(big.status).toBe(409);
    } finally {
      await pool.query("DELETE FROM eval_jobs WHERE created_by = $1", [basic.id]);
    }
  });

  it("the daily cap: the 51st analysis today is refused, deleted ones included", async () => {
    // Deleting an analysis must not give back a slot: these were all deleted.
    const rows = Array.from({ length: 50 }, () => `(${user.id}, 'analyze', 2, 'failed', -10, '{}'::jsonb, now())`).join(",");
    await pool.query(`INSERT INTO eval_jobs (created_by, kind, trigger_type, status, priority, config, deleted_at) VALUES ${rows}`);
    try {
      const res = await upload(user.cookie, stereo, good());
      expect(res.status).toBe(429);
    } finally {
      await pool.query("DELETE FROM eval_jobs WHERE created_by = $1 AND kind = 'analyze'", [user.id]);
    }
  });

  it("someone else's analysis is not found, and can't be deleted or downloaded", async () => {
    const job = await storage.createEvalJob({
      kind: "analyze", evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: user.id,
      siteId: null, targetRegion: null, targetTier: null, config: {},
      snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: "premium", transport: "web",
        analyze: { fileName: "x.wav", s3Key: "vox-analyze/x.wav", sha256: "0", sizeBytes: 1, durationSec: 1, recordingRegion: region } } as any,
      status: "pending", priority: -10, retryCount: 0, maxRetries: 3,
    } as any);
    for (const [method, path] of [["GET", ""], ["GET", "/recording"], ["DELETE", ""]] as const) {
      const res = await fetch(`${BASE_URL}/api/tools/analyze/${job.id}${path}`, { method, headers: { Cookie: other.cookie } });
      expect(res.status).toBe(404);
    }
    // The owner sees it.
    const mine = await fetch(`${BASE_URL}/api/tools/analyze/${job.id}`, { headers: { Cookie: user.cookie } });
    expect(mine.status).toBe(200);
    expect((await mine.json()).job).toMatchObject({ id: job.id, fileName: "x.wav", recordingRegion: region, source: "web" });
    // An eval job's id is not an analysis.
    const evalJob = (await pool.query("SELECT id FROM eval_jobs WHERE kind = 'eval' LIMIT 1")).rows[0]?.id;
    if (evalJob) expect((await fetch(`${BASE_URL}/api/tools/analyze/${evalJob}`, { headers: { Cookie: admin } })).status).toBe(404);
  });

  it("a running analysis can't be deleted", async () => {
    const job = await storage.createEvalJob({
      kind: "analyze", evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: user.id,
      siteId: null, targetRegion: null, targetTier: null, config: {},
      snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: "premium" } as any,
      status: "running", priority: -10, retryCount: 0, maxRetries: 3,
    } as any);
    const res = await fetch(`${BASE_URL}/api/tools/analyze/${job.id}`, { method: "DELETE", headers: { Cookie: user.cookie } });
    expect(res.status).toBe(409);
  });

  it("a deleted analysis is gone from the list and the detail", async () => {
    const job = await storage.createEvalJob({
      kind: "analyze", evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: user.id,
      siteId: null, targetRegion: null, targetTier: null, config: {},
      snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: "premium" } as any,
      status: "completed", priority: -10, retryCount: 0, maxRetries: 3,
    } as any);
    await pool.query("UPDATE eval_jobs SET deleted_at = now() WHERE id = $1", [job.id]);
    const list = await (await fetch(`${BASE_URL}/api/tools/analyze`, { headers: { Cookie: user.cookie } })).json();
    expect(list.map((a: { id: number }) => a.id)).not.toContain(job.id);
    expect((await fetch(`${BASE_URL}/api/tools/analyze/${job.id}`, { headers: { Cookie: user.cookie } })).status).toBe(404);
  });

  it("if the file can't be removed from storage, delete says so, keeps the row, and stops it running", async () => {
    // Placeholder storage (s3.invalid) cannot be reached.
    const job = await storage.createEvalJob({
      kind: "analyze", evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: user.id,
      siteId: null, targetRegion: null, targetTier: null, config: {},
      snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: "premium", transport: "web",
        analyze: { fileName: "x.wav", s3Key: "vox-analyze/x.wav", sha256: "0", sizeBytes: 1, durationSec: 1, recordingRegion: region } } as any,
      status: "pending", priority: -10, retryCount: 0, maxRetries: 3,
    } as any);
    const res = await fetch(`${BASE_URL}/api/tools/analyze/${job.id}`, { method: "DELETE", headers: { Cookie: user.cookie } });
    expect(res.status).toBe(502);
    const after = (await storage.getEvalJob(job.id))!;
    expect(after.deletedAt).toBeNull();          // kept: its key is how a retry finds the file
    expect(after.status).toBe("failed");         // no agent claims it any more
    const list = await (await fetch(`${BASE_URL}/api/tools/analyze`, { headers: { Cookie: user.cookie } })).json();
    expect(list.map((a: { id: number }) => a.id)).toContain(job.id); // still there to delete again
  });

  it("the list shows only the caller's analyses", async () => {
    const res = await fetch(`${BASE_URL}/api/tools/analyze`, { headers: { Cookie: other.cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("an agent needs its token to fetch an upload", async () => {
    const res = await fetch(`${BASE_URL}/api/eval-agent/jobs/1/upload`);
    expect(res.status).toBe(401);
  });
});
