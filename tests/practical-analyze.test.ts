import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage, pool } from "../server/storage";
import { getUserObjectStream } from "../server/s3";
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
    const q = new URLSearchParams({ provider: provider.id, region, source: "web", fileName: "conversation.wav" });
    const up = await fetch(`${BASE_URL}/api/tools/analyze?${q}`, {
      method: "POST", headers: { "Content-Type": "audio/wav", Cookie: cookie }, body: wav,
    });
    expect(up.status).toBe(201);
    const { id } = await up.json();

    // The analysis runs on the local agent: poll until it's done.
    const deadline = Date.now() + 10 * 60 * 1000;
    let detail: any;
    for (;;) {
      detail = await (await fetch(`${BASE_URL}/api/tools/analyze/${id}`, { headers: { Cookie: cookie } })).json();
      if (detail.job.status === "completed" || detail.job.status === "failed") break;
      if (Date.now() > deadline) throw new Error(`analysis ${id} still ${detail.job.status} after 10 min`);
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
    expect(Buffer.from(await rec.arrayBuffer()).equals(Buffer.from(wav))).toBe(true);

    // Delete: the row, its result and the object in the bucket all go.
    const key = (await storage.getEvalJob(id))!.snapshot!.analyze!.s3Key;
    expect((await fetch(`${BASE_URL}/api/tools/analyze/${id}`, { method: "DELETE", headers: { Cookie: cookie } })).status).toBe(204);
    expect((await fetch(`${BASE_URL}/api/tools/analyze/${id}`, { headers: { Cookie: cookie } })).status).toBe(404);
    expect(await storage.getEvalResultsByJob(id)).toEqual([]);
    await expect(getUserObjectStream(userId, key)).rejects.toThrow();
  }, 15 * 60 * 1000);
});
