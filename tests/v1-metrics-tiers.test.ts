import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage, pool } from "../server/storage";

// The public v1 metrics API (GET /api/v1/metrics/realtime and /leaderboard)
// served mainline only, with no transport filter at all — phone results would
// have mixed into web ones — and no way to read community or your own private
// metrics. It now takes:
//   tier      = mainline (default) | community — public, no key
//             | mine — the caller's own private evals, needs an API key
//   transport = web (default) | phone — never mixed
//   hours     = optional window
// With no parameters a request gets what it always got (mainline, web).
//
// Fixtures: one result per tier on a provider of this suite's own, so the
// assertions can't be confused by other data on the shared dev DB.

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const d = process.env.DATABASE_URL ? describe : describe.skip;

d("v1 metrics: tier, transport, hours", () => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const emails = [`v1tier-me-${stamp}@example.com`, `v1tier-other-${stamp}@example.com`];
  const jobIds: number[] = [];
  let providerId = "";
  let meId = 0;
  let otherId = 0;
  let meCookie = "";
  let meKey = "";
  const ids: Record<string, number> = {}; // result id per fixture

  async function user(email: string): Promise<{ id: number; cookie: string }> {
    const admin = ((await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@vox.local", password: "admin123456" }),
    })).headers.get("set-cookie") || "").split(";")[0];
    const { token } = await (await fetch(`${BASE_URL}/api/admin/invite`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: admin }, body: JSON.stringify({ email, plan: "premium" }),
    })).json();
    await fetch(`${BASE_URL}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: email.split("@")[0].replace(/-/g, ""), password: "TestPass123!", token }),
    });
    const id = (await pool.query("SELECT id FROM users WHERE email = $1", [email])).rows[0].id as number;
    const cookie = ((await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "TestPass123!" }),
    })).headers.get("set-cookie") || "").split(";")[0];
    return { id, cookie };
  }

  /** A completed job + result whose frozen snapshot puts it in a given tier. */
  async function fixture(name: string, o: {
    flow: { visibility: "public" | "private"; isMainline: boolean; ownerId: number };
    set: { visibility: "public" | "private"; isMainline: boolean; ownerId: number };
    creatorPlan: string; dispatchTier: string; transport: "web" | "phone"; createdBy: number; latency: number;
  }) {
    const job = await storage.createEvalJob({
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: o.createdBy, siteId: "na-us-seattle-01",
      targetRegion: null, targetTier: null, config: {}, status: "completed",
      snapshot: {
        provider: { id: providerId, name: "p", platformId: null },
        evalFlow: { name: "f", organizationId: null, config: {}, ...o.flow },
        evalSet: { name: "s", config: {}, ...o.set },
        creatorPlan: o.creatorPlan, transport: o.transport,
      } as any,
      priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    jobIds.push(job.id);
    await pool.query("UPDATE eval_jobs SET token_dispatch_tier = $2, completed_at = now() WHERE id = $1", [job.id, o.dispatchTier]);
    const r = await storage.createEvalResult({ evalJobId: job.id, providerId, siteId: "na-us-seattle-01", responseLatencyMedian: o.latency } as any);
    ids[name] = r.id;
  }

  const get = async (path: string, auth?: { cookie?: string; key?: string }) => {
    const headers: Record<string, string> = {};
    if (auth?.cookie) headers.Cookie = auth.cookie;
    if (auth?.key) headers.Authorization = `Bearer ${auth.key}`;
    const res = await fetch(`${BASE_URL}${path}`, { headers });
    return { status: res.status, body: await res.json() };
  };
  /** Which of this suite's fixtures a realtime response contains. */
  const mine = (data: Array<{ id: number }>) =>
    Object.entries(ids).filter(([, id]) => data.some((r) => r.id === id)).map(([n]) => n).sort();

  beforeAll(async () => {
    // Old timestamp: /api/providers lists newest first and other suites take
    // its first entry — they must not pick this one.
    providerId = (await storage.createProvider({ name: `v1 tiers ${stamp}`, sku: "convoai", description: "test", createdAt: new Date("2000-01-01T00:00:00Z") } as any)).id;
    const me = await user(emails[0]);
    const other = await user(emails[1]);
    meId = me.id; otherId = other.id; meCookie = me.cookie;
    meKey = (await (await fetch(`${BASE_URL}/api/user/api-keys`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: meCookie }, body: JSON.stringify({ name: `v1tier-${stamp}` }),
    })).json()).key;

    const scout = (await pool.query("SELECT id FROM users WHERE email = $1", ["scout@vox.ai"])).rows[0].id as number;
    const ml = (id: number) => ({ visibility: "public" as const, isMainline: true, ownerId: id });
    await fixture("mainline-web", { flow: ml(scout), set: ml(scout), creatorPlan: "principal", dispatchTier: "public", transport: "web", createdBy: scout, latency: 900 });
    await fixture("mainline-phone", { flow: ml(scout), set: ml(scout), creatorPlan: "principal", dispatchTier: "public", transport: "phone", createdBy: scout, latency: 1500 });
    await fixture("community-web", {
      flow: { visibility: "public", isMainline: false, ownerId: otherId }, set: { visibility: "public", isMainline: false, ownerId: otherId },
      creatorPlan: "premium", dispatchTier: "public", transport: "web", createdBy: otherId, latency: 1100,
    });
    await fixture("mine-web", {
      flow: { visibility: "private", isMainline: false, ownerId: meId }, set: { visibility: "private", isMainline: false, ownerId: meId },
      creatorPlan: "premium", dispatchTier: "private", transport: "web", createdBy: meId, latency: 1200,
    });
    await fixture("mine-phone", {
      flow: { visibility: "private", isMainline: false, ownerId: meId }, set: { visibility: "private", isMainline: false, ownerId: meId },
      creatorPlan: "premium", dispatchTier: "private", transport: "phone", createdBy: meId, latency: 1700,
    });
    await fixture("others-private", {
      flow: { visibility: "private", isMainline: false, ownerId: otherId }, set: { visibility: "private", isMainline: false, ownerId: otherId },
      creatorPlan: "premium", dispatchTier: "private", transport: "web", createdBy: otherId, latency: 1300,
    });
  });

  afterAll(async () => {
    if (jobIds.length) await pool.query("DELETE FROM eval_jobs WHERE id = ANY($1)", [jobIds]);
    await pool.query("DELETE FROM api_keys WHERE created_by = ANY(SELECT id FROM users WHERE email = ANY($1))", [emails]).catch(() => {});
    if (providerId) await pool.query("DELETE FROM providers WHERE id = $1", [providerId]).catch(() => {});
  });

  it("no parameters: what it always returned — mainline, web — and the meta says so", async () => {
    const r = await get("/api/v1/metrics/realtime");
    expect(r.status).toBe(200);
    expect(mine(r.body.data)).toEqual(["mainline-web"]); // not the phone one — never mixed
    expect(r.body.meta).toMatchObject({ tier: "mainline", transport: "web", hours: null, count: r.body.data.length });
    // The same fields as before.
    expect(Object.keys(r.body.data.find((x: { id: number }) => x.id === ids["mainline-web"])).sort()).toEqual(
      expect.arrayContaining(["id", "provider", "siteId", "responseLatency", "interruptLatency", "networkResilience", "naturalness", "noiseReduction", "timestamp"]),
    );
  });

  it("transport=phone: phone results only", async () => {
    const r = await get("/api/v1/metrics/realtime?transport=phone");
    expect(mine(r.body.data)).toEqual(["mainline-phone"]);
    expect(r.body.meta.transport).toBe("phone");
  });

  it("tier=community: public, no key", async () => {
    const r = await get("/api/v1/metrics/realtime?tier=community");
    expect(r.status).toBe(200);
    expect(mine(r.body.data)).toEqual(["community-web"]);
    expect(r.body.meta.tier).toBe("community");
  });

  it("tier=mine: no key → 401", async () => {
    const r = await get("/api/v1/metrics/realtime?tier=mine");
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/needs an API key/);
  });

  it("tier=mine with my key: my private results only — never someone else's — per transport", async () => {
    const web = await get("/api/v1/metrics/realtime?tier=mine", { key: meKey });
    expect(web.status).toBe(200);
    expect(mine(web.body.data)).toEqual(["mine-web"]);
    const phone = await get("/api/v1/metrics/realtime?tier=mine&transport=phone", { key: meKey });
    expect(mine(phone.body.data)).toEqual(["mine-phone"]);
  });

  it("tier=mine from a disabled account's still-open session → 401", async () => {
    expect((await get("/api/v1/metrics/realtime?tier=mine", { cookie: meCookie })).status).toBe(200);
    await pool.query("UPDATE users SET is_enabled = false WHERE id = $1", [meId]);
    try {
      const r = await get("/api/v1/metrics/realtime?tier=mine", { cookie: meCookie });
      expect(r.status).toBe(401);
      expect(r.body.error).toMatch(/disabled/);
    } finally {
      await pool.query("UPDATE users SET is_enabled = true WHERE id = $1", [meId]);
    }
  });

  it("the leaderboard takes the same parameters, and the default is unchanged", async () => {
    const row = (data: Array<{ provider: string; responseLatency: number | null }>) => data.find((x) => x.provider === providerId);
    expect(row((await get("/api/v1/metrics/leaderboard")).body.data)?.responseLatency).toBe(900);
    expect(row((await get("/api/v1/metrics/leaderboard?transport=phone")).body.data)?.responseLatency).toBe(1500);
    expect(row((await get("/api/v1/metrics/leaderboard?tier=community")).body.data)?.responseLatency).toBe(1100);
    expect((await get("/api/v1/metrics/leaderboard?tier=mine")).status).toBe(401);
    const mineBoard = await get("/api/v1/metrics/leaderboard?tier=mine", { key: meKey });
    expect(row(mineBoard.body.data)?.responseLatency).toBe(1200); // mine-web only: not others-private (1300)
    expect(mineBoard.body.meta).toMatchObject({ tier: "mine", transport: "web" });
  });

  it("hours limits the window", async () => {
    await pool.query("UPDATE eval_results SET created_at = now() - interval '10 days' WHERE id = $1", [ids["mainline-web"]]);
    try {
      expect(mine((await get("/api/v1/metrics/realtime?hours=24")).body.data)).toEqual([]);
      expect(mine((await get("/api/v1/metrics/realtime?hours=720")).body.data)).toEqual(["mainline-web"]);
    } finally {
      await pool.query("UPDATE eval_results SET created_at = now() WHERE id = $1", [ids["mainline-web"]]);
    }
  });

  it("bad values are refused", async () => {
    for (const q of ["tier=everything", "transport=carrier-pigeon", "hours=0", "hours=x"]) {
      expect((await get(`/api/v1/metrics/realtime?${q}`)).status).toBe(400);
      expect((await get(`/api/v1/metrics/leaderboard?${q}`)).status).toBe(400);
    }
    for (const q of ["limit=0", "limit=201", "limit=x"]) expect((await get(`/api/v1/metrics/realtime?${q}`)).status).toBe(400);
    // The console leaderboard validates hours the same way (it parseInt'ed anything).
    for (const q of ["hours=0", "hours=x"]) expect((await get(`/api/metrics/leaderboard?${q}`)).status).toBe(400);
  });

  it("realtime honours the documented limit (it was ignored)", async () => {
    const r = await get("/api/v1/metrics/realtime?limit=2");
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeLessThanOrEqual(2);
  });

  it("the console leaderboard is one transport per view too (it mixed them as well)", async () => {
    const row = (data: Array<{ provider?: string; providerId?: string; responseLatency?: number | null }>) =>
      data.find((x) => (x.providerId ?? x.provider) === providerId);
    // An hours window no other suite uses: the console leaderboard is cached by
    // its parameters, and another suite's earlier request (built before these
    // fixtures existed) would otherwise be served from the cache.
    const web = await get("/api/metrics/leaderboard?hours=87613");
    const phone = await get("/api/metrics/leaderboard?hours=87613&transport=phone");
    const pick = (b: unknown) => (Array.isArray(b) ? b : (b as { data: unknown[] }).data) as Array<{ provider?: string; providerId?: string; responseLatency?: number | null }>;
    expect(row(pick(web.body))).toBeDefined();
    expect(row(pick(phone.body))).toBeDefined();
    expect(row(pick(web.body))?.responseLatency).not.toBe(row(pick(phone.body))?.responseLatency);
  });
});
