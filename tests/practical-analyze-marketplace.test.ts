import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "crypto";
import { storage, pool } from "../server/storage";
import { computeCharge, computeFee } from "../plugins/shared-agents/server/pricing";
import { makeConversationWav } from "./fixtures/make-conversation-wav";

// Tools → Analyze on a marketplace agent, for credits (design 2026-09-30):
// the uploader picks the agent and consents to its operator receiving the
// recording; one analysis costs one unit at the agent's price, held at upload
// and captured when a result comes back. The agent side is driven over HTTP
// (register with the 'analyze' capability, list, claim, fetch, complete), the
// money through the real credits and shared-agents plugins, the file through
// the real bucket.
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const S3 = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
const ready = !!process.env.DATABASE_URL && S3.every((k) => !!process.env[k]);
const d = ready ? describe : describe.skip;
const PRICE = 10;

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  expect(res.ok).toBe(true);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}
const call = (cookie: string, method: string, path: string, body?: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body),
  });
/**
 * What the operator (the admin, who owns the test agents) was paid for this
 * job: its capture entries on this job's settlement. The admin's whole balance
 * moves with other suites that dispatch as admin concurrently, so it isn't
 * compared.
 */
async function operatorPaidFor(jobId: number): Promise<number> {
  const settlementId = String(((await storage.getEvalJob(jobId))!.snapshot as { settlementContext?: { settlementId?: number } }).settlementContext?.settlementId);
  const r = await pool.query(
    `SELECT coalesce(sum(e.amount), 0)::int paid FROM plugin_credits.ledger_entries e
       JOIN plugin_credits.accounts a ON a.id = e.account_id
      WHERE e.ref_type = 'shared-agent-dispatch' AND e.ref_id = $1 AND e.reason = 'capture'
        AND a.kind = 'user' AND a.user_ref = (SELECT id FROM users WHERE email = 'admin@vox.local')`,
    [settlementId],
  );
  return r.rows[0].paid;
}
const balance = async (cookie: string) => (await (await call(cookie, "GET", "/api/plugins/credits/balance")).json()).credits as number;

d("practical: Analyze on a marketplace agent, for credits", () => {
  let admin = "";
  const renters: Array<{ id: number; cookie: string }> = [];
  const tokenIds: number[] = [];
  let region = "";
  let provider = "";
  let paidAgent: { tokenId: number; raw: string; agentId: number; leaseId: string };
  let plainTokenId = 0;
  const wav = makeConversationWav();

  async function renter(credits: number): Promise<{ id: number; cookie: string }> {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const email = `analyze-paid-${stamp}@example.com`;
    const { token } = await (await call(admin, "POST", "/api/admin/invite", { email, plan: "premium" })).json();
    expect((await fetch(`${BASE_URL}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: `analyzepaid${stamp}`, password: "TestPass123!", token }),
    })).ok).toBe(true);
    const id = (await pool.query("SELECT id FROM users WHERE email = $1", [email])).rows[0].id as number;
    const cookie = await login(email, "TestPass123!");
    expect((await call(cookie, "PUT", "/api/user/storage-config", {
      s3Endpoint: process.env.S3_ENDPOINT, s3Bucket: process.env.S3_BUCKET, s3Region: process.env.S3_REGION || "auto",
      s3AccessKeyId: process.env.S3_ACCESS_KEY_ID, s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    })).ok).toBe(true);
    if (credits > 0) {
      expect((await call(admin, "POST", "/api/plugins/credits/grants", { userId: id, credits, reason: "analyze-paid-test", idempotencyKey: `analyze-paid-${stamp}` })).ok).toBe(true);
    }
    const r = { id, cookie };
    renters.push(r);
    return r;
  }

  /** A shared (marketplace) token whose agent reports `capabilities`. */
  async function sharedAgent(capabilities: string[]) {
    const base = (await storage.getAllRegionLocations()).find((l) => l.isActive)!.baseId;
    const t = await (await call(admin, "POST", "/api/eval-agent-tokens", {
      name: `analyze-paid-${Date.now()}-${Math.random()}`, regionLocationBaseId: base, dispatchTier: "public",
    })).json();
    tokenIds.push(t.id);
    const reg = await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST", headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "analyze-paid-agent", capabilities }),
    });
    expect(reg.ok).toBe(true);
    const agent = await reg.json();
    expect((await call(admin, "PATCH", `/api/eval-agent-tokens/${t.id}`, { dispatchTier: "shared", pricePerUnit: PRICE })).ok).toBe(true);
    return { tokenId: t.id as number, raw: t.token as string, agentId: agent.id as number, leaseId: agent.leaseId as string };
  }

  const upload = (cookie: string, q: Record<string, string>) =>
    fetch(`${BASE_URL}/api/tools/analyze?${new URLSearchParams({ provider, region, source: "web", fileName: "paid.wav", ...q })}`, {
      method: "POST", headers: { "Content-Type": "audio/wav", Cookie: cookie }, body: wav,
    });

  beforeAll(async () => {
    admin = await login("admin@vox.local", "admin123456");
    region = (await storage.getAllRegionLocations()).find((l) => l.isActive)!.baseId;
    provider = (await storage.getAllProviders())[0].id;
    paidAgent = await sharedAgent(["analyze"]);
    plainTokenId = (await sharedAgent([])).tokenId;
  });

  afterAll(async () => {
    const ids = renters.map((r) => r.id);
    if (ids.length) {
      await pool.query("DELETE FROM eval_jobs WHERE created_by = ANY($1)", [ids]);
      await pool.query("DELETE FROM user_storage_config WHERE user_id = ANY($1)", [ids]);
    }
    for (const id of tokenIds) await call(admin, "POST", `/api/eval-agent-tokens/${id}/revoke`);
  });

  it("offers only marketplace agents that can analyze, with their price", async () => {
    const r = await renter(0);
    const agents = await (await call(r.cookie, "GET", "/api/tools/analyze/agents")).json() as Array<{ tokenId: number; pricePerUnit: number }>;
    expect(agents).toContainEqual(expect.objectContaining({ tokenId: paidAgent.tokenId, pricePerUnit: PRICE }));
    expect(agents.map((a) => a.tokenId)).not.toContain(plainTokenId);
  });

  it("refuses without consent, for an agent that can't analyze, and without enough credits", async () => {
    const r = await renter(0);
    const noConsent = await upload(r.cookie, { agent: String(paidAgent.tokenId) });
    expect(noConsent.status).toBe(400);
    expect((await noConsent.json()).error).toMatch(/consent/i);
    const cannot = await upload(r.cookie, { agent: String(plainTokenId), consent: "1" });
    expect(cannot.status).toBe(400);
    expect((await cannot.json()).error).toMatch(/can't run analyses/i);
    const broke = await upload(r.cookie, { agent: String(paidAgent.tokenId), consent: "1" });
    expect(broke.status).toBe(402);
    // Nothing queued, nothing left in the bucket's way.
    expect((await pool.query("SELECT count(*)::int c FROM eval_jobs WHERE created_by = $1", [r.id])).rows[0].c).toBe(0);
  });

  it("holds the price at upload, runs on that agent only, and pays its operator on the result", async () => {
    const r = await renter(100);
    const renterBefore = await balance(r.cookie);

    const up = await upload(r.cookie, { agent: String(paidAgent.tokenId), consent: "1" });
    expect(up.status).toBe(201);
    const { id } = await up.json();
    const charge = computeCharge(PRICE, 1);
    expect(await balance(r.cookie)).toBe(renterBefore - charge); // held
    const job = (await storage.getEvalJob(id))!;
    expect(job).toMatchObject({ targetTokenId: paidAgent.tokenId, kind: "analyze" });
    expect(job.snapshot).toMatchObject({ recordingConsent: true });

    // The paid agent sees it (as the bare minimum), claims it, fetches the file.
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${paidAgent.raw}` };
    const listed = await (await fetch(`${BASE_URL}/api/eval-agent/jobs`, { headers: auth })).json();
    expect(listed).toContainEqual({ id, kind: "analyze", transport: "web", status: "pending", config: {} });
    const claim = await fetch(`${BASE_URL}/api/eval-agent/jobs/${id}/claim`, {
      method: "POST", headers: auth, body: JSON.stringify({ agentId: paidAgent.agentId, leaseId: paidAgent.leaseId }),
    });
    expect(claim.status).toBe(200);
    const file = await fetch(`${BASE_URL}/api/eval-agent/jobs/${id}/upload?leaseId=${paidAgent.leaseId}`, { headers: auth });
    expect(file.status).toBe(200);
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(file.headers.get("x-vox-upload-sha256")).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(bytes.equals(Buffer.from(wav))).toBe(true);

    const done = await fetch(`${BASE_URL}/api/eval-agent/jobs/${id}/complete`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ agentId: paidAgent.agentId, leaseId: paidAgent.leaseId, results: { responseLatencyMedian: 1200, networkResilience: null, naturalness: null, noiseReduction: null, rawData: {} } }),
    });
    expect(done.ok).toBe(true);

    // Settled: the operator gets the charge less the platform fee; the renter stays charged.
    expect(await operatorPaidFor(id)).toBe(charge - computeFee(charge));
    expect(await balance(r.cookie)).toBe(renterBefore - charge);
    const detail = await (await call(r.cookie, "GET", `/api/tools/analyze/${id}`)).json();
    expect(detail.job).toMatchObject({ status: "completed", runOn: "marketplace" });
    expect(detail.result).toMatchObject({ responseLatencyMedian: 1200, recordingRegion: region });
  }, 120_000);

  it("an analysis the agent fails is refunded at once, and its operator isn't paid", async () => {
    const r = await renter(100);
    const renterBefore = await balance(r.cookie);
    const up = await upload(r.cookie, { agent: String(paidAgent.tokenId), consent: "1" });
    expect(up.status).toBe(201);
    const { id } = await up.json();
    expect(await balance(r.cookie)).toBe(renterBefore - computeCharge(PRICE, 1)); // held

    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${paidAgent.raw}` };
    expect((await fetch(`${BASE_URL}/api/eval-agent/jobs/${id}/claim`, {
      method: "POST", headers: auth, body: JSON.stringify({ agentId: paidAgent.agentId, leaseId: paidAgent.leaseId }),
    })).status).toBe(200);
    expect((await fetch(`${BASE_URL}/api/eval-agent/jobs/${id}/complete`, {
      method: "POST", headers: auth, body: JSON.stringify({ agentId: paidAgent.agentId, leaseId: paidAgent.leaseId, error: "aeval analyze exited 1" }),
    })).ok).toBe(true);

    expect(await balance(r.cookie)).toBe(renterBefore); // refunded
    expect(await operatorPaidFor(id)).toBe(0);           // nothing paid
    const detail = await (await call(r.cookie, "GET", `/api/tools/analyze/${id}`)).json();
    expect(detail.job).toMatchObject({ status: "failed", error: "aeval analyze exited 1" });
    expect(detail.result).toBeNull();
  }, 120_000);

  it("a paid analysis deleted while queued is refunded by the settlement sweep", async () => {
    const r = await renter(100);
    const before = await balance(r.cookie);
    const up = await upload(r.cookie, { agent: String(paidAgent.tokenId), consent: "1" });
    expect(up.status).toBe(201);
    const { id } = await up.json();
    expect(await balance(r.cookie)).toBe(before - computeCharge(PRICE, 1));
    expect((await call(r.cookie, "DELETE", `/api/tools/analyze/${id}`)).status).toBe(204);
    // The scheduler's reap-settle sweep releases the hold (after its 1-minute grace).
    const deadline = Date.now() + 4 * 60 * 1000;
    while ((await balance(r.cookie)) !== before && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 5000));
    }
    expect(await balance(r.cookie)).toBe(before);
    expect((await storage.getEvalJob(id))!.settlementDoneAt).not.toBeNull();
  }, 6 * 60 * 1000);

  it("revoking the agent fails its queued paid analysis and refunds it at once (#214)", async () => {
    const r = await renter(100);
    const before = await balance(r.cookie);
    const agentToRevoke = await sharedAgent(["analyze"]);
    const up = await upload(r.cookie, { agent: String(agentToRevoke.tokenId), consent: "1" });
    expect(up.status).toBe(201);
    const { id } = await up.json();
    expect(await balance(r.cookie)).toBe(before - computeCharge(PRICE, 1)); // held
    expect((await call(admin, "POST", `/api/eval-agent-tokens/${agentToRevoke.tokenId}/revoke`)).ok).toBe(true);
    const job = (await storage.getEvalJob(id))!;
    expect(job).toMatchObject({ status: "failed", error: "Its eval agent was revoked." });
    expect(await balance(r.cookie)).toBe(before); // refunded now, not after a reaper
    // And it can't be dispatched to again.
    const again = await upload(r.cookie, { agent: String(agentToRevoke.tokenId), consent: "1" });
    expect(again.status).toBe(400);
  }, 120_000);

  it("deleting a finished paid analysis whose payment wasn't settled captures it first (#219)", async () => {
    const r = await renter(100);
    const renterBefore = await balance(r.cookie);
    const up = await upload(r.cookie, { agent: String(paidAgent.tokenId), consent: "1" });
    expect(up.status).toBe(201);
    const { id } = await up.json();
    // Finished with a result, but its settle never ran (as when it threw on
    // completion): the hold is still held.
    await pool.query("UPDATE eval_jobs SET status = 'completed', completed_at = now(), eval_agent_id = $2 WHERE id = $1", [id, paidAgent.agentId]);
    await storage.createAnalyzeResult({ evalJobId: id, providerId: provider, siteId: null, responseLatencyMedian: 900 } as any);
    expect((await call(r.cookie, "DELETE", `/api/tools/analyze/${id}`)).status).toBe(204);
    const charge = computeCharge(PRICE, 1);
    expect(await operatorPaidFor(id)).toBe(charge - computeFee(charge));            // paid for the real result
    expect(await balance(r.cookie)).toBe(renterBefore - charge);                    // not refunded
    expect((await storage.getEvalJob(id))!.settlementDoneAt).not.toBeNull();
  }, 120_000);

  it("revoking an agent while it runs a paid analysis fails it and refunds at once (#214)", async () => {
    const r = await renter(100);
    const before = await balance(r.cookie);
    const agent = await sharedAgent(["analyze"]);
    const up = await upload(r.cookie, { agent: String(agent.tokenId), consent: "1" });
    expect(up.status).toBe(201);
    const { id } = await up.json();
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${agent.raw}` };
    expect((await fetch(`${BASE_URL}/api/eval-agent/jobs/${id}/claim`, {
      method: "POST", headers: auth, body: JSON.stringify({ agentId: agent.agentId, leaseId: agent.leaseId }),
    })).status).toBe(200);
    expect((await storage.getEvalJob(id))!.status).toBe("running");
    expect((await call(admin, "POST", `/api/eval-agent-tokens/${agent.tokenId}/revoke`)).ok).toBe(true);
    expect(await storage.getEvalJob(id)).toMatchObject({ status: "failed", error: "Its eval agent was revoked." });
    expect(await balance(r.cookie)).toBe(before); // refunded now, not after the backstop
  }, 120_000);

  it("deleting a paid analysis that is still finishing (result not stored yet) waits, and refunds nothing", async () => {
    const r = await renter(100);
    const before = await balance(r.cookie);
    const up = await upload(r.cookie, { agent: String(paidAgent.tokenId), consent: "1" });
    expect(up.status).toBe(201);
    const { id } = await up.json();
    // Marked completed, but its result isn't stored yet (the complete route is mid-way).
    await pool.query("UPDATE eval_jobs SET status = 'completed', completed_at = now(), eval_agent_id = $2 WHERE id = $1", [id, paidAgent.agentId]);
    const res = await call(r.cookie, "DELETE", `/api/tools/analyze/${id}`);
    expect(res.status).toBe(409);
    expect(await balance(r.cookie)).toBe(before - computeCharge(PRICE, 1)); // still held, not refunded
    expect(await operatorPaidFor(id)).toBe(0);
    const job = (await storage.getEvalJob(id))!;
    expect(job.settlementDoneAt).toBeNull();
    expect(job.deletedAt).toBeNull();
    // Once the result is stored, the delete goes through and pays the operator.
    await storage.createAnalyzeResult({ evalJobId: id, providerId: provider, siteId: null, responseLatencyMedian: 900 } as any);
    expect((await call(r.cookie, "DELETE", `/api/tools/analyze/${id}`)).status).toBe(204);
    expect(await operatorPaidFor(id)).toBe(computeCharge(PRICE, 1) - computeFee(computeCharge(PRICE, 1)));
  }, 120_000);
});
