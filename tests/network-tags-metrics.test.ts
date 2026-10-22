import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage, pool } from "../server/storage";

// Network tags on the metrics views (designs/2026-10-22-network-tags-design.md
// "Which value a board uses", "Analysis"): `tag=key:value` (repeatable, AND)
// and `groupBy=key` on the console /api/metrics/{realtime,community,my-evals,
// leaderboard} and the public /api/v1/metrics/{realtime,leaderboard}.
//
// Fixtures: completed jobs + results on a provider of this suite's own (old
// timestamp, as in v1-metrics-tiers.test.ts), with eval_jobs.tags set by hand.
// Every tag VALUE carries this run's stamp, so cache keys are unique per run
// and nothing else on the shared dev DB can match a filter.

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const d = process.env.DATABASE_URL ? describe : describe.skip;

type JT = { key: string; value: string; source: "flow" | "agent" | "detected" };

d("metrics: tag= and groupBy=", () => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const v = (name: string) => `${name}-${stamp}`; // a run-unique tag value
  const STARLINK = v("starlink"), ATT = v("att"), TWILIO = v("twilio"), BANDWIDTH = v("bandwidth");
  // Windows no other suite uses (the console caches by parameters): RAW ≤ 7 days
  // keeps realtime rows per job; LONG makes realtime bucket by day.
  const RAW = 100 + (Number(stamp.slice(-6)) % 60);
  const LONG = 50000 + (Number(stamp.slice(-6)) % 40000);
  const emails = [`ntm-me-${stamp}@example.com`, `ntm-other-${stamp}@example.com`];
  const jobIds: number[] = [];
  const ids: Record<string, number> = {};
  let providerId = "";
  let meId = 0, otherId = 0, meCookie = "";

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

  type Tier = "mainline" | "community" | "mine";
  async function fixture(name: string, tier: Tier, tags: JT[] | null, latency: number) {
    const owner = tier === "mainline" ? scoutId : tier === "community" ? otherId : meId;
    const pub = tier !== "mine";
    const side = { visibility: pub ? "public" : "private", isMainline: tier === "mainline", ownerId: owner };
    const job = await storage.createEvalJob({
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: owner, siteId: "na-us-seattle-01",
      targetRegion: null, targetTier: null, config: {}, status: "completed",
      snapshot: {
        provider: { id: providerId, name: "p", platformId: null },
        evalFlow: { name: "f", organizationId: null, config: {}, ...side },
        evalSet: { name: "s", config: {}, ...side },
        creatorPlan: tier === "mainline" ? "principal" : "premium", transport: "web",
      } as any,
      priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    jobIds.push(job.id);
    await pool.query("UPDATE eval_jobs SET token_dispatch_tier = $2, completed_at = now(), tags = $3::jsonb WHERE id = $1",
      [job.id, pub ? "public" : "private", tags === null ? null : JSON.stringify(tags)]);
    const r = await storage.createEvalResult({ evalJobId: job.id, providerId, siteId: "na-us-seattle-01", responseLatencyMedian: latency } as any);
    ids[name] = r.id;
  }
  let scoutId = 0;

  const get = async (path: string, cookie?: string) => {
    const res = await fetch(`${BASE_URL}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
    return { status: res.status, body: await res.json() };
  };
  const q = (...tags: string[]) => tags.map((t) => `tag=${encodeURIComponent(t)}`).join("&");
  /** Which of this suite's fixtures a row list contains. */
  const mine = (data: Array<{ id: number }>) =>
    Object.entries(ids).filter(([, id]) => data.some((r) => r.id === id)).map(([n]) => n).sort();
  const ours = <T extends { providerId?: string; provider?: string }>(rows: T[]) =>
    rows.filter((r) => (r.providerId ?? r.provider) === providerId);

  beforeAll(async () => {
    providerId = (await storage.createProvider({ name: `net tags ${stamp}`, sku: "convoai", description: "test", createdAt: new Date("2000-01-01T00:00:00Z") } as any)).id;
    const me = await user(emails[0]);
    const other = await user(emails[1]);
    meId = me.id; otherId = other.id; meCookie = me.cookie;
    scoutId = (await pool.query("SELECT id FROM users WHERE email = $1", ["scout@vox.ai"])).rows[0].id as number;

    // Mainline
    await fixture("m1-handset-isp", "mainline", [{ key: "isp", value: ATT, source: "agent" }], 1000);
    await fixture("m2-handset+detected-isp", "mainline", [{ key: "isp", value: ATT, source: "agent" }, { key: "isp", value: STARLINK, source: "detected" }], 1100);
    await fixture("m3-flow-line", "mainline", [{ key: "line", value: TWILIO, source: "flow" }], 1200);
    await fixture("m4-flow+detected-line", "mainline", [
      { key: "line", value: TWILIO, source: "flow" }, { key: "line", value: BANDWIDTH, source: "detected" }, { key: "isp", value: STARLINK, source: "detected" },
    ], 1300);
    await fixture("m5-untagged", "mainline", null, 1600);
    // Community
    await fixture("c1-handset+detected-isp", "community", [{ key: "isp", value: ATT, source: "agent" }, { key: "isp", value: STARLINK, source: "detected" }], 2000);
    await fixture("c2-detected-isp+flow-line", "community", [{ key: "isp", value: STARLINK, source: "detected" }, { key: "line", value: TWILIO, source: "flow" }], 2100);
    // My Evals
    await fixture("e1-handset+detected-isp", "mine", [{ key: "isp", value: ATT, source: "agent" }, { key: "isp", value: STARLINK, source: "detected" }], 3000);
  });

  afterAll(async () => {
    if (jobIds.length) await pool.query("DELETE FROM eval_jobs WHERE id = ANY($1)", [jobIds]);
    if (providerId) await pool.query("DELETE FROM providers WHERE id = $1", [providerId]).catch(() => {});
  });

  it("mainline ignores a hand-set-only isp but uses a detected one", async () => {
    expect(mine((await get(`/api/metrics/realtime?hours=${RAW}&${q(`isp:${STARLINK}`)}`)).body))
      .toEqual(["m2-handset+detected-isp", "m4-flow+detected-line"]);
    // m1/m2's hand-set att never counts on mainline.
    expect(mine((await get(`/api/metrics/realtime?hours=${RAW}&${q(`isp:${ATT}`)}`)).body)).toEqual([]);
  });

  it("community honors the agent's hand-set isp over the detected one", async () => {
    expect(mine((await get(`/api/metrics/community?hours=${RAW}&${q(`isp:${ATT}`)}`)).body)).toEqual(["c1-handset+detected-isp"]);
    expect(mine((await get(`/api/metrics/community?hours=${RAW}&${q(`isp:${STARLINK}`)}`)).body)).toEqual(["c2-detected-isp+flow-line"]);
  });

  it("my-evals uses the hand-set value too", async () => {
    expect(mine((await get(`/api/metrics/my-evals?hours=${RAW}&${q(`isp:${ATT}`)}`, meCookie)).body)).toEqual(["e1-handset+detected-isp"]);
    expect(mine((await get(`/api/metrics/my-evals?hours=${RAW}&${q(`isp:${STARLINK}`)}`, meCookie)).body)).toEqual([]);
  });

  it("a flow's line counts on mainline only when there is no detected line", async () => {
    expect(mine((await get(`/api/metrics/realtime?hours=${RAW}&${q(`line:${TWILIO}`)}`)).body)).toEqual(["m3-flow-line"]);
    expect(mine((await get(`/api/metrics/realtime?hours=${RAW}&${q(`line:${BANDWIDTH}`)}`)).body)).toEqual(["m4-flow+detected-line"]);
  });

  it("several tag filters must all match", async () => {
    expect(mine((await get(`/api/metrics/realtime?hours=${RAW}&${q(`isp:${STARLINK}`, `line:${BANDWIDTH}`)}`)).body)).toEqual(["m4-flow+detected-line"]);
    expect(mine((await get(`/api/metrics/realtime?hours=${RAW}&${q(`isp:${STARLINK}`, `line:${TWILIO}`)}`)).body)).toEqual([]);
  });

  it("rows carry their effective tags, and groupBy their group value", async () => {
    const r = await get(`/api/metrics/realtime?hours=${RAW}&${q(`isp:${STARLINK}`)}&groupBy=line`);
    const m4 = r.body.find((x: { id: number }) => x.id === ids["m4-flow+detected-line"]);
    expect(m4.tags).toEqual(expect.arrayContaining([{ key: "line", value: BANDWIDTH }, { key: "isp", value: STARLINK }]));
    expect(m4.tags).toHaveLength(2);
    expect(m4.tagValue).toBe(BANDWIDTH);
    expect(r.body.find((x: { id: number }) => x.id === ids["m2-handset+detected-isp"]).tagValue).toBe("untagged");
  });

  it("groupBy splits the console leaderboard by provider × site × value, with an untagged bucket", async () => {
    const rows = ours((await get(`/api/metrics/leaderboard?hours=${LONG}&groupBy=isp`)).body as Array<{ providerId: string; tagValue: string; responseLatency: number }>);
    const by = Object.fromEntries(rows.map((r) => [r.tagValue, r.responseLatency]));
    expect(by).toEqual({ [STARLINK]: 1200, untagged: 1267 }); // m2+m4; m1+m3+m5 (nothing dropped)
  });

  it("bucketed realtime groups by the tag in SQL", async () => {
    const r = await get(`/api/metrics/realtime?hours=${LONG}&${q(`isp:${STARLINK}`)}&groupBy=line`);
    expect(r.status).toBe(200);
    const rows = ours(r.body as Array<{ providerId: string; tagValue: string; responseLatency: number; tags: unknown }>);
    const by = Object.fromEntries(rows.map((x) => [x.tagValue, x.responseLatency]));
    expect(by).toEqual({ [BANDWIDTH]: 1300, untagged: 1100 });
    expect(rows.every((x) => x.tags === null)).toBe(true); // a bucket averages many jobs: no single tag set
  });

  it("the console leaderboard caches tag filters separately", async () => {
    const row = async (tag: string) => ours((await get(`/api/metrics/leaderboard?hours=${LONG}&${q(tag)}`)).body as Array<{ responseLatency: number }>);
    expect((await row(`isp:${STARLINK}`)).map((r) => r.responseLatency)).toEqual([1200]);
    expect(await row(`isp:${ATT}`)).toEqual([]); // hand-set only on mainline
    expect((await row(`line:${TWILIO}`)).map((r) => r.responseLatency)).toEqual([1200]);
  });

  it("v1 agrees with the console, carries tags, and echoes tag/groupBy in meta", async () => {
    const tag = `isp:${STARLINK}`;
    const v1 = await get(`/api/v1/metrics/realtime?${q(tag)}`);
    expect(v1.status).toBe(200);
    expect(mine(v1.body.data)).toEqual(mine((await get(`/api/metrics/realtime?hours=${RAW}&${q(tag)}`)).body));
    expect(v1.body.meta).toMatchObject({ tag: [tag], groupBy: null });
    expect(v1.body.data.find((x: { id: number }) => x.id === ids["m2-handset+detected-isp"]).tags).toEqual([{ key: "isp", value: STARLINK }]);

    const comm = await get(`/api/v1/metrics/realtime?tier=community&${q(`isp:${ATT}`)}`);
    expect(mine(comm.body.data)).toEqual(["c1-handset+detected-isp"]);
    const mineV1 = await get(`/api/v1/metrics/realtime?tier=mine&${q(`isp:${ATT}`)}`, meCookie);
    expect(mine(mineV1.body.data)).toEqual(["e1-handset+detected-isp"]);

    const lb = await get(`/api/v1/metrics/leaderboard?groupBy=isp`);
    expect(lb.body.meta).toMatchObject({ tag: [], groupBy: "isp" });
    const by = Object.fromEntries(ours(lb.body.data as Array<{ provider: string; tagValue: string; responseLatency: number }>).map((r) => [r.tagValue, r.responseLatency]));
    expect(by).toEqual({ [STARLINK]: 1200, untagged: 1267 });
  });

  it("no tag parameters: no tagValue on leaderboard rows (unchanged shape)", async () => {
    const lb = await get(`/api/v1/metrics/leaderboard`);
    const row = ours(lb.body.data as Array<{ provider: string }>)[0];
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("tagValue");
    expect(lb.body.meta).toMatchObject({ tag: [], groupBy: null });
  });

  it("bad tag / groupBy → 400 with the parser's message", async () => {
    const bad: Array<[string, RegExp]> = [
      ["tag=nocolon", /key:value/],
      ["tag=link:carrier-pigeon", /link/],
      ["groupBy=1abc", /groupBy/],
      ["groupBy=isp&groupBy=line", /single key/],
    ];
    for (const [qs, msg] of bad) {
      for (const path of ["/api/metrics/realtime", "/api/metrics/community", "/api/metrics/leaderboard", "/api/v1/metrics/realtime", "/api/v1/metrics/leaderboard"]) {
        const r = await get(`${path}?${qs}`);
        expect(r.status, `${path}?${qs}`).toBe(400);
        expect(r.body.error).toMatch(msg);
      }
      const r = await get(`/api/metrics/my-evals?${qs}`, meCookie);
      expect(r.status).toBe(400);
    }
  });
});
