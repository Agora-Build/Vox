import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage, pool } from "../server/storage";

// Part 2 analysis (designs/2026-10-22-network-tags-design.md "Group by region",
// "Last mile vs datacenter" → Analysis, "Agent badge follows access"):
//
// - `groupBy=region` on the console metrics views and /api/v1/metrics/*: the
//   group is the result's region — its site's location base, or for an
//   uploaded analysis its recording region — else `unattributed`.
// - Leaderboard rows carry `lastMile` / `datacenter` columns (same averages +
//   count) unless an `access` tag filter is set.
// - GET /api/eval-agents exposes accessClass/accessReason/simCarrier, never the
//   IP, the raw netSignals or our SIM number.
//
// Fixtures own their data: providers of this run's own, run-unique site ids
// (so no other suite's results share a region), and windows no other suite uses.

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const d = process.env.DATABASE_URL ? describe : describe.skip;

type JT = { key: string; value: string; source: "flow" | "agent" | "detected"; reason?: string };

d("metrics: groupBy=region and leaderboard access columns", () => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  // Run-unique location bases: `<base>-NN` sites map to `<base>`.
  const BASE_A = `na-us-ra${stamp}`, BASE_B = `eu-de-rb${stamp}`, REC = `apac-in-rec${stamp}`;
  const RAW = 100 + (Number(stamp.slice(-6)) % 60);
  const LONG = 50000 + (Number(stamp.slice(-6)) % 40000) + 7;
  const jobIds: number[] = [];
  const providers: string[] = [];
  const ids: Record<string, number> = {};
  let regionProvider = "", accessProvider = "";
  let scoutId = 0, meId = 0, meCookie = "";
  const email = `ntr-me-${stamp}@example.com`;

  async function login(e: string, password: string) {
    return ((await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: e, password }),
    })).headers.get("set-cookie") || "").split(";")[0];
  }

  type Tier = "mainline" | "mine";
  async function fixture(name: string, opts: {
    provider: string; tier: Tier; siteId: string | null; latency: number; tags?: JT[] | null;
    kind?: "eval" | "analyze"; recordingRegion?: string | null;
  }) {
    const owner = opts.tier === "mainline" ? scoutId : meId;
    const pub = opts.tier === "mainline";
    const side = { visibility: pub ? "public" : "private", isMainline: pub, ownerId: owner };
    const job = await storage.createEvalJob({
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: owner, siteId: opts.siteId,
      targetRegion: null, targetTier: null, config: {}, status: "completed",
      snapshot: {
        provider: { id: opts.provider, name: "p", platformId: null },
        evalFlow: { name: "f", organizationId: null, config: {}, ...side },
        evalSet: { name: "s", config: {}, ...side },
        creatorPlan: pub ? "principal" : "premium", transport: "web",
      } as any,
      priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    jobIds.push(job.id);
    await pool.query(
      "UPDATE eval_jobs SET token_dispatch_tier = $2, completed_at = now(), tags = $3::jsonb, kind = $4, transport = 'web' WHERE id = $1",
      [job.id, pub ? "public" : "private", opts.tags == null ? null : JSON.stringify(opts.tags), opts.kind ?? "eval"],
    );
    const r = await storage.createEvalResult({
      evalJobId: job.id, providerId: opts.provider, siteId: opts.siteId, responseLatencyMedian: opts.latency,
      interruptLatencyMedian: opts.latency / 10, recordingRegion: opts.recordingRegion ?? null,
    } as any);
    ids[name] = r.id;
  }

  const get = async (path: string, cookie?: string) => {
    const res = await fetch(`${BASE_URL}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
    return { status: res.status, body: await res.json() };
  };
  const rowsOf = <T extends { providerId?: string; provider?: string }>(rows: T[], provider: string) =>
    rows.filter((r) => (r.providerId ?? r.provider) === provider);
  /** id → tagValue, for this suite's raw rows. */
  const groups = (data: Array<{ id: number; tagValue?: string }>) =>
    Object.fromEntries(Object.entries(ids).filter(([, id]) => data.some((r) => r.id === id))
      .map(([n, id]) => [n, data.find((r) => r.id === id)!.tagValue]));
  const access = (value: string, reason: string): JT => ({ key: "access", value, source: "detected", reason });

  beforeAll(async () => {
    const mk = async (n: string) => {
      const id = (await storage.createProvider({ name: `${n} ${stamp}`, sku: "convoai", description: "test", createdAt: new Date("2000-01-01T00:00:00Z") } as any)).id;
      providers.push(id);
      return id;
    };
    regionProvider = await mk("net region");
    accessProvider = await mk("net access");
    scoutId = (await pool.query("SELECT id FROM users WHERE email = $1", ["scout@vox.ai"])).rows[0].id as number;
    const admin = await login("admin@vox.local", "admin123456");
    const { token } = await (await fetch(`${BASE_URL}/api/admin/invite`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: admin }, body: JSON.stringify({ email, plan: "premium" }),
    })).json();
    await fetch(`${BASE_URL}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: email.split("@")[0].replace(/-/g, ""), password: "TestPass123!", token }),
    });
    meId = (await pool.query("SELECT id FROM users WHERE email = $1", [email])).rows[0].id as number;
    meCookie = await login(email, "TestPass123!");

    // Region fixtures (mainline): two sites in BASE_A, one in BASE_B, one with no site.
    await fixture("a1", { provider: regionProvider, tier: "mainline", siteId: `${BASE_A}-01`, latency: 1000 });
    await fixture("a2", { provider: regionProvider, tier: "mainline", siteId: `${BASE_A}-02`, latency: 1200 });
    await fixture("b1", { provider: regionProvider, tier: "mainline", siteId: `${BASE_B}-01`, latency: 2000 });
    await fixture("none", { provider: regionProvider, tier: "mainline", siteId: null, latency: 3000 });
    // My Evals: an uploaded analysis (no site, a recording region) and a private run at a site.
    await fixture("analysis", { provider: regionProvider, tier: "mine", siteId: null, latency: 4000, kind: "analyze", recordingRegion: REC });
    await fixture("mine-b", { provider: regionProvider, tier: "mine", siteId: `${BASE_B}-03`, latency: 5000 });

    // Access fixtures (mainline), all at one site: 2 last mile, 1 datacenter, 1 unknown, 1 untagged.
    const SITE = `${BASE_A}-09`;
    await fixture("lm1", { provider: accessProvider, tier: "mainline", siteId: SITE, latency: 1000, tags: [access("lastmile", "v1: mobile-asn")] });
    await fixture("lm2", { provider: accessProvider, tier: "mainline", siteId: SITE, latency: 1200, tags: [access("lastmile", "v1: eyeball-asn + residential-rdns")] });
    await fixture("dc1", { provider: accessProvider, tier: "mainline", siteId: SITE, latency: 2000, tags: [access("datacenter", "v1: dc-range")] });
    await fixture("unk1", { provider: accessProvider, tier: "mainline", siteId: SITE, latency: 3000, tags: [access("unknown", "v1: insufficient")] });
    // A hand-set access value (no route can store one) must feed neither column.
    await fixture("untagged", { provider: accessProvider, tier: "mainline", siteId: SITE, latency: 4000, tags: [{ key: "access", value: "lastmile", source: "agent" }] });
    // A second site in another region, one last-mile result: its own row.
    await fixture("lm-b", { provider: accessProvider, tier: "mainline", siteId: `${BASE_B}-09`, latency: 1500, tags: [access("lastmile", "v1: mobile-asn")] });
  });

  afterAll(async () => {
    if (jobIds.length) await pool.query("DELETE FROM eval_jobs WHERE id = ANY($1)", [jobIds]);
    for (const p of providers) await pool.query("DELETE FROM providers WHERE id = $1", [p]).catch(() => {});
    if (meId) await pool.query("DELETE FROM users WHERE id = $1", [meId]).catch(() => {});
  });

  // ---- groupBy=region ----

  it("console realtime (raw rows): the site's location base, or unattributed", async () => {
    const r = await get(`/api/metrics/realtime?hours=${RAW}&groupBy=region`);
    expect(r.status).toBe(200);
    expect(groups(rowsOf(r.body, regionProvider))).toEqual({ a1: BASE_A, a2: BASE_A, b1: BASE_B, none: "unattributed" });
  });

  it("console realtime (bucketed): groups by region in SQL", async () => {
    const r = await get(`/api/metrics/realtime?hours=${LONG}&groupBy=region`);
    expect(r.status).toBe(200);
    const rows = rowsOf(r.body as Array<{ providerId: string; tagValue: string; responseLatency: number }>, regionProvider);
    expect(Object.fromEntries(rows.map((x) => [x.tagValue, x.responseLatency])))
      .toEqual({ [BASE_A]: 1100, [BASE_B]: 2000, unattributed: 3000 });
  });

  it("my-evals: an analysis groups by its recording region, raw and bucketed", async () => {
    const raw = await get(`/api/metrics/my-evals?hours=${RAW}&groupBy=region`, meCookie);
    expect(raw.status).toBe(200);
    expect(groups(rowsOf(raw.body, regionProvider))).toEqual({ analysis: REC, "mine-b": BASE_B });
    const bucketed = await get(`/api/metrics/my-evals?hours=${LONG}&groupBy=region`, meCookie);
    const rows = rowsOf(bucketed.body as Array<{ providerId: string; tagValue: string; responseLatency: number }>, regionProvider);
    expect(Object.fromEntries(rows.map((x) => [x.tagValue, x.responseLatency]))).toEqual({ [REC]: 4000, [BASE_B]: 5000 });
  });

  it("console leaderboard: one row per provider × site × region", async () => {
    const rows = rowsOf((await get(`/api/metrics/leaderboard?hours=${LONG}&groupBy=region`)).body as Array<{ providerId: string; siteId: string | null; tagValue: string; responseLatency: number }>, regionProvider);
    expect(rows.map((x) => [x.siteId, x.tagValue, x.responseLatency]).sort()).toEqual([
      [`${BASE_A}-01`, BASE_A, 1000],
      [`${BASE_A}-02`, BASE_A, 1200],
      [`${BASE_B}-01`, BASE_B, 2000],
      [null, "unattributed", 3000],
    ].sort());
  });

  it("v1 realtime and leaderboard group by region too, and echo it in meta", async () => {
    const rt = await get(`/api/v1/metrics/realtime?groupBy=region&limit=200`);
    expect(rt.status).toBe(200);
    expect(rt.body.meta).toMatchObject({ groupBy: "region" });
    expect(groups(rowsOf(rt.body.data, regionProvider))).toEqual({ a1: BASE_A, a2: BASE_A, b1: BASE_B, none: "unattributed" });

    const mine = await get(`/api/v1/metrics/realtime?tier=mine&groupBy=region`, meCookie);
    expect(groups(rowsOf(mine.body.data, regionProvider))).toEqual({ analysis: REC, "mine-b": BASE_B });

    const lb = await get(`/api/v1/metrics/leaderboard?groupBy=region`);
    expect(lb.body.meta).toMatchObject({ groupBy: "region" });
    const rows = rowsOf(lb.body.data as Array<{ provider: string; tagValue: string; responseLatency: number }>, regionProvider);
    expect(rows.map((x) => [x.tagValue, x.responseLatency]).sort()).toEqual([[BASE_A, 1000], [BASE_A, 1200], [BASE_B, 2000], ["unattributed", 3000]].sort());
    const mineLb = await get(`/api/v1/metrics/leaderboard?tier=mine&groupBy=region`, meCookie);
    expect(rowsOf(mineLb.body.data as Array<{ provider: string; tagValue: string }>, regionProvider).map((x) => x.tagValue).sort()).toEqual([REC, BASE_B].sort());
  });

  it("region is not a tag: tag=region:… is a 400", async () => {
    for (const path of ["/api/metrics/realtime", "/api/metrics/leaderboard", "/api/v1/metrics/realtime", "/api/v1/metrics/leaderboard"]) {
      const r = await get(`${path}?tag=region:${BASE_A}`);
      expect(r.status, path).toBe(400);
      expect(r.body.error).toMatch(/can't be a tag key/);
    }
  });

  // ---- Leaderboard access columns ----

  type Col = { count: number; responseLatency: number | null; interruptLatency: number | null };
  type LbRow = { providerId?: string; provider?: string; siteId: string; tagValue?: string; responseLatency: number; lastMile?: Col; datacenter?: Col };

  it("console leaderboard: last-mile and datacenter averages and counts per row", async () => {
    const rows = rowsOf((await get(`/api/metrics/leaderboard?hours=${LONG}`)).body as LbRow[], accessProvider);
    const row = rows.find((r) => r.siteId === `${BASE_A}-09`)!;
    expect(row.responseLatency).toBe(2240); // all five
    expect(row.lastMile).toMatchObject({ count: 2, responseLatency: 1100, interruptLatency: 110 });
    expect(row.datacenter).toMatchObject({ count: 1, responseLatency: 2000, interruptLatency: 200 });
    const other = rows.find((r) => r.siteId === `${BASE_B}-09`)!;
    expect(other.lastMile).toMatchObject({ count: 1, responseLatency: 1500 });
    expect(other.datacenter).toMatchObject({ count: 0, responseLatency: null, interruptLatency: null });
  });

  it("console leaderboard: access columns on each group when grouped", async () => {
    const rows = rowsOf((await get(`/api/metrics/leaderboard?hours=${LONG}&groupBy=region`)).body as LbRow[], accessProvider);
    const a = rows.find((r) => r.tagValue === BASE_A)!;
    expect(a.lastMile).toMatchObject({ count: 2, responseLatency: 1100 });
    expect(a.datacenter).toMatchObject({ count: 1, responseLatency: 2000 });
  });

  it("an access filter drops the columns (the view is one class already)", async () => {
    const rows = rowsOf((await get(`/api/metrics/leaderboard?hours=${LONG}&tag=access:lastmile`)).body as LbRow[], accessProvider);
    const row = rows.find((r) => r.siteId === `${BASE_A}-09`)!;
    expect(row.responseLatency).toBe(1100);
    expect(row).not.toHaveProperty("lastMile");
    expect(row).not.toHaveProperty("datacenter");
  });

  it("v1 leaderboard: the same columns, absent with an access filter", async () => {
    const lb = await get(`/api/v1/metrics/leaderboard`);
    const row = rowsOf(lb.body.data as LbRow[], accessProvider).find((r) => r.siteId === `${BASE_A}-09`)!;
    expect(row.responseLatency).toBe(2240);
    expect(row.lastMile).toMatchObject({ count: 2, responseLatency: 1100, interruptLatency: 110 });
    expect(row.datacenter).toMatchObject({ count: 1, responseLatency: 2000 });
    const filtered = await get(`/api/v1/metrics/leaderboard?tag=access:datacenter`);
    const f = rowsOf(filtered.body.data as LbRow[], accessProvider);
    expect(f.map((r) => [r.siteId, r.responseLatency])).toEqual([[`${BASE_A}-09`, 2000]]);
    expect(f[0]).not.toHaveProperty("lastMile");
    expect(f[0]).not.toHaveProperty("datacenter");
  });

  it("groupBy=access already works through the tag machinery", async () => {
    const rows = rowsOf((await get(`/api/metrics/leaderboard?hours=${LONG}&groupBy=access`)).body as LbRow[], accessProvider)
      .filter((r) => r.siteId === `${BASE_A}-09`);
    expect(Object.fromEntries(rows.map((r) => [r.tagValue, r.responseLatency])))
      .toEqual({ lastmile: 1100, datacenter: 2000, unknown: 3000, untagged: 4000 });
  });
});

d("GET /api/eval-agents: access class and reason, never the IP, signals or SIM number", () => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `ntr-agent-${stamp}@example.com`;
  let userId = 0, cookie = "", tokenId = 0, agentId = 0;

  beforeAll(async () => {
    const login = async (e: string, p: string) => ((await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: e, password: p }),
    })).headers.get("set-cookie") || "").split(";")[0];
    const admin = await login("admin@vox.local", "admin123456");
    const { token } = await (await fetch(`${BASE_URL}/api/admin/invite`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: admin }, body: JSON.stringify({ email, plan: "premium" }),
    })).json();
    await fetch(`${BASE_URL}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: email.split("@")[0].replace(/-/g, ""), password: "TestPass123!", token }),
    });
    userId = (await pool.query("SELECT id FROM users WHERE email = $1", [email])).rows[0].id as number;
    cookie = await login(email, "TestPass123!");
    const tok = await (await fetch(`${BASE_URL}/api/eval-agent-tokens`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ name: `ntr-token-${stamp}` }),
    })).json();
    tokenId = tok.id;
    const reg = await (await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok.token}` },
      body: JSON.stringify({ name: `ntr agent ${stamp}`, metadata: {} }),
    })).json();
    agentId = reg.id;
    // What the location check and the SIM matcher would have written.
    await pool.query(
      `UPDATE eval_agents SET access_class = 'lastmile', access_reason = 'v1: mobile-asn', sim_carrier = 't-mobile',
         sim_reason = 'v1: sim-match 310-260', sim_number_redacted = '…4321', observed_ip = '203.0.113.77',
         net_signals = '{"cloudMetadata": false, "publicIpOnInterface": false}'::jsonb WHERE id = $1`,
      [agentId],
    );
  });

  afterAll(async () => {
    if (tokenId) {
      await pool.query("DELETE FROM eval_agents WHERE token_id = $1", [tokenId]).catch(() => {});
      await pool.query("DELETE FROM eval_agent_tokens WHERE id = $1", [tokenId]).catch(() => {});
    }
    if (userId) await pool.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => {});
  });

  it("exposes accessClass, accessReason and the carrier slug only", async () => {
    const res = await fetch(`${BASE_URL}/api/eval-agents`, { headers: { Cookie: cookie } });
    const row = (await res.json()).find((a: { id: number }) => a.id === agentId);
    expect(row).toMatchObject({ accessClass: "lastmile", accessReason: "v1: mobile-asn", simCarrier: "t-mobile" });
    const text = JSON.stringify(row);
    for (const banned of ["observedIp", "observed_ip", "203.0.113.77", "netSignals", "net_signals", "cloudMetadata", "publicIpOnInterface", "simNumberRedacted", "4321", "simReason"]) {
      expect(text, banned).not.toContain(banned);
    }
  });
});
