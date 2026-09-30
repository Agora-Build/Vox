import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage, pool } from "../server/storage";
import { userBucket, getObjectStream, putObject, deleteObject } from "../server/s3";
import { createHash } from "crypto";
import { makeConversationWav, REPLY_GAP_S } from "./fixtures/make-conversation-wav";

// Tools → Analyze end to end, nothing faked (design 2026-09-30): a real stereo
// conversation uploaded into a real bucket, analyzed by the running local eval
// agent with the real aeval, the result read back through the API and My
// Evals, then deleted. Needs the dev stack (dev-local-run.sh start), an agent
// reporting 'analyze', and S3 settings in the environment (.env).
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const S3 = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
const ready = !!process.env.DATABASE_URL && S3.every((k) => !!process.env[k]);
const d = ready ? describe : describe.skip;

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  expect(res.ok).toBe(true);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

d("practical: Tools → Analyze, upload to My Evals", () => {
  let cookie = "";
  let userId = 0;
  let provider = { id: "", name: "" };
  let region = "";
  const wav = makeConversationWav();

  beforeAll(async () => {
    // An agent that can run it, heartbeating now; otherwise this proves nothing.
    const capable = await pool.query(
      `SELECT 1 FROM eval_agents a JOIN eval_agent_tokens t ON t.id = a.token_id
        WHERE a.capabilities ? 'analyze' AND a.last_seen_at > now() - interval '2 minutes'
          AND t.is_revoked = false AND t.dispatch_tier = 'public'`,
    );
    if (capable.rowCount === 0) throw new Error("no public eval agent reporting 'analyze' is online — restart dev-local-run.sh");

    const admin = await login("admin@vox.local", "admin123456");
    const stamp = `${Date.now()}`;
    const email = `practical-analyze-${stamp}@example.com`;
    const { token } = await (await fetch(`${BASE_URL}/api/admin/invite`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: admin }, body: JSON.stringify({ email, plan: "premium" }),
    })).json();
    expect((await fetch(`${BASE_URL}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: `practicalanalyze${stamp}`, password: "TestPass123!", token }),
    })).ok).toBe(true);
    userId = (await pool.query("SELECT id FROM users WHERE email = $1", [email])).rows[0].id;
    cookie = await login(email, "TestPass123!");

    // The user's own storage (Storage page), pointed at the dev bucket.
    const put = await fetch(`${BASE_URL}/api/user/storage-config`, {
      method: "PUT", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        s3Endpoint: process.env.S3_ENDPOINT, s3Bucket: process.env.S3_BUCKET, s3Region: process.env.S3_REGION || "auto",
        s3AccessKeyId: process.env.S3_ACCESS_KEY_ID, s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      }),
    });
    expect(put.ok).toBe(true);

    const p = (await storage.getAllProviders())[0];
    provider = { id: p.id, name: p.name };
    region = (await storage.getAllRegionLocations())[0].baseId;
  });

  afterAll(async () => {
    if (!userId) return;
    await pool.query("DELETE FROM eval_jobs WHERE created_by = $1", [userId]);
    await pool.query("DELETE FROM user_storage_config WHERE user_id = $1", [userId]);
  });

  it("uploads, is analyzed by a real agent, lands in My Evals, and deletes cleanly", async () => {
    // A non-ASCII name: it must survive into the download's header.
    const fileName = "通话 录音.wav";
    const q = new URLSearchParams({ provider: provider.id, region, source: "web", fileName });
    const up = await fetch(`${BASE_URL}/api/tools/analyze?${q}`, {
      method: "POST", headers: { "Content-Type": "audio/wav", Cookie: cookie }, body: wav,
    });
    expect(up.status).toBe(201);
    const { id } = await up.json();

    // The analysis runs on the local agent: poll until it's done. Analyses run
    // after eval runs (priority), and in the full gate other suites queue ~30
    // eval runs on this agent first: allow for that queue.
    const deadline = Date.now() + 20 * 60 * 1000;
    let detail: any;
    for (;;) {
      detail = await (await fetch(`${BASE_URL}/api/tools/analyze/${id}`, { headers: { Cookie: cookie } })).json();
      if (detail.job.status === "completed" || detail.job.status === "failed") break;
      if (Date.now() > deadline) throw new Error(`analysis ${id} still ${detail.job.status} after 20 min`);
      await new Promise((r) => setTimeout(r, 5000));
    }
    expect(detail.job.error ?? null).toBeNull();
    expect(detail.job.status).toBe("completed");

    // A real measurement of the conversation we built: its three turns, each
    // reply starting no sooner than the gap put before it.
    const turns = detail.result.rawData.response_metrics.latency.turn_level as Array<{ latency_ms: number }>;
    expect(turns).toHaveLength(3);
    for (const t of turns) expect(t.latency_ms).toBeGreaterThanOrEqual(REPLY_GAP_S * 1000);
    expect(detail.result.responseLatencyMedian).toBeGreaterThanOrEqual(REPLY_GAP_S * 1000);
    // aeval's speech-to-text, joined onto the turns; and nothing unmeasured
    // reported as a number.
    expect(turns.some((t: any) => typeof t.agent_transcript === "string" && t.agent_transcript.length > 0)).toBe(true);
    expect(turns.some((t: any) => typeof t.user_transcript === "string" && t.user_transcript.length > 0)).toBe(true);
    expect(detail.result).toMatchObject({ networkResilience: null, naturalness: null, noiseReduction: null });
    // Filed under the stated region, from no site.
    expect(detail.result.recordingRegion).toBe(region);
    expect(detail.result.siteId).toBeNull();
    expect(detail.result.providerId).toBe(provider.id);

    // In My Evals under that region; not in the Eval Jobs list.
    const mine = await storage.getMyEvalMetrics(userId, 24, { baseIds: [region] }, "web");
    expect(mine.some((r) => r.evalJobId === id)).toBe(true);
    const jobs = await (await fetch(`${BASE_URL}/api/eval-jobs?scope=mine&limit=100`, { headers: { Cookie: cookie } })).json();
    const listed = (Array.isArray(jobs) ? jobs : jobs.jobs ?? jobs.data ?? []) as Array<{ id: number }>;
    expect(listed.map((j) => j.id)).not.toContain(id);

    // The recording downloads byte for byte.
    const rec = await fetch(`${BASE_URL}/api/tools/analyze/${id}/recording`, { headers: { Cookie: cookie } });
    expect(rec.status).toBe(200);
    expect(rec.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent(fileName)}`);
    expect(Buffer.from(await rec.arrayBuffer()).equals(Buffer.from(wav))).toBe(true);

    // Delete: the row, its result and the object in the bucket all go.
    const key = (await storage.getEvalJob(id))!.snapshot!.analyze!.s3Key;
    expect((await fetch(`${BASE_URL}/api/tools/analyze/${id}`, { method: "DELETE", headers: { Cookie: cookie } })).status).toBe(204);
    expect((await fetch(`${BASE_URL}/api/tools/analyze/${id}`, { headers: { Cookie: cookie } })).status).toBe(404);
    expect(await storage.getEvalResultsByJob(id)).toEqual([]);
    // The row stays, marked deleted, so the daily cap still counts it.
    expect((await storage.getEvalJob(id))!.deletedAt).not.toBeNull();
    await expect(getObjectStream((await userBucket(userId))!, key)).rejects.toThrow();
  }, 25 * 60 * 1000);

  /** Poll an analysis until it finishes (completed or failed). */
  async function finished(id: number): Promise<any> {
    const deadline = Date.now() + 20 * 60 * 1000; // see above: the gate's eval-run queue
    for (;;) {
      const d = await (await fetch(`${BASE_URL}/api/tools/analyze/${id}`, { headers: { Cookie: cookie } })).json();
      if (d.job.status === "completed" || d.job.status === "failed") return d;
      if (Date.now() > deadline) throw new Error(`analysis ${id} still ${d.job.status} after 20 min`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  it("a batch of three, each with its own provider, region and source, lands in the right My Evals views", async () => {
    const providers = await storage.getAllProviders();
    const regions = (await storage.getAllRegionLocations()).filter((l) => l.isActive);
    const [pA, pB] = [providers[0].id, providers[1].id];
    const [r1, r2] = [regions[0].baseId, regions[1].baseId];
    const files = [
      { provider: pA, region: r1, source: "web", fileName: "one.wav" },
      { provider: pB, region: r2, source: "phone", fileName: "two.wav" },
      { provider: pA, region: r2, source: "web", fileName: "three.wav" },
    ];
    const ids: number[] = [];
    for (const f of files) { // one upload at a time per user
      const up = await fetch(`${BASE_URL}/api/tools/analyze?${new URLSearchParams(f)}`, {
        method: "POST", headers: { "Content-Type": "audio/wav", Cookie: cookie }, body: wav,
      });
      expect(up.status).toBe(201);
      ids.push((await up.json()).id);
    }
    const results = [];
    for (const id of ids) {
      const d = await finished(id);
      expect(d.job.error ?? null).toBeNull();
      results.push(d);
    }
    results.forEach((d, i) => {
      expect(d.result).toMatchObject({ providerId: files[i].provider, recordingRegion: files[i].region, siteId: null });
      expect(d.job.source).toBe(files[i].source);
      expect(d.result.responseLatencyMedian).toBeGreaterThanOrEqual(REPLY_GAP_S * 1000);
    });
    // Web and phone never mix; each result sits under its own region.
    const inView = async (transport: "web" | "phone", baseIds?: string[]) =>
      (await storage.getMyEvalMetrics(userId, 24, baseIds ? { baseIds } : undefined, transport)).map((r) => r.evalJobId);
    const web = await inView("web");
    const phone = await inView("phone");
    expect(web).toEqual(expect.arrayContaining([ids[0], ids[2]]));
    expect(web).not.toContain(ids[1]);
    expect(phone).toContain(ids[1]);
    expect(phone).not.toContain(ids[0]);
    const webR2 = await inView("web", [r2]);
    expect(webR2).toContain(ids[2]);
    expect(webR2).not.toContain(ids[0]);
  }, 30 * 60 * 1000);

  it("a recording changed in the bucket after upload is refused by the agent, and nothing is stored", async () => {
    // The object in the bucket isn't the one Core recorded (same size, other
    // bytes), as if the uploader replaced it: the real agent must refuse it.
    const bucket = (await userBucket(userId))!;
    const key = `vox-analyze/${userId}/tampered-${Date.now()}.wav`;
    const tampered = Buffer.from(wav); tampered[1000] ^= 0xff;
    await putObject(bucket, key, tampered, "audio/wav");
    const provider = (await storage.getAllProviders())[0];
    const job = await storage.createEvalJob({
      kind: "analyze", evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: userId,
      siteId: null, targetRegion: null, targetTier: null, config: {},
      snapshot: { provider: { id: provider.id, name: provider.name, platformId: null }, evalFlow: null, evalSet: null, creatorPlan: "premium", transport: "web",
        analyze: { fileName: "tampered.wav", s3Key: key, sha256: createHash("sha256").update(Buffer.from(wav)).digest("hex"),
          sizeBytes: wav.length, durationSec: 20, recordingRegion: region, storage: { endpoint: bucket.endpoint, bucket: bucket.bucket } } } as any,
      status: "pending", priority: -10, retryCount: 0, maxRetries: 3,
    } as any);
    try {
      const d = await finished(job.id);
      expect(d.job.status).toBe("failed");
      expect(d.job.error).toMatch(/isn't the recording that was uploaded/);
      expect(d.result).toBeNull();
    } finally {
      await deleteObject(bucket, key).catch(() => {});
    }
  }, 25 * 60 * 1000);
});
