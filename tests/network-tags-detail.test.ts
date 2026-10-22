import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage, pool } from "../server/storage";

// Network-tag filters on the chart drill-down, GET /api/metrics/:tier/detail
// (designs/2026-10-22-network-tags-design.md "Analysis"; plan ruling for
// Task 8): a filtered chart's zoom must never show unfiltered data, so the
// detail endpoint takes the same repeatable `tag=key:value` as its parent
// views, on the same board rule, at both raw and bucketed resolutions.
//
// Fixtures in the style of tests/network-tags-metrics.test.ts: completed jobs
// on a provider of this suite's own, eval_jobs.tags set by hand, every tag
// value stamped with this run so nothing else on the dev DB can match.

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const d = process.env.DATABASE_URL ? describe : describe.skip;

type JT = { key: string; value: string; source: "flow" | "agent" | "detected" };

d("metrics detail: tag=", () => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const STARLINK = `starlink-${stamp}`, ATT = `att-${stamp}`;
  const jobIds: number[] = [];
  const ids: Record<string, number> = {};
  let providerId = "";
  let scoutId = 0;
  let otherId = 0;

  async function fixture(name: string, tier: "mainline" | "community", tags: JT[] | null, latency: number) {
    const owner = tier === "mainline" ? scoutId : otherId;
    const side = { visibility: "public", isMainline: tier === "mainline", ownerId: owner };
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
    await pool.query("UPDATE eval_jobs SET token_dispatch_tier = 'public', completed_at = now(), tags = $2::jsonb WHERE id = $1",
      [job.id, tags === null ? null : JSON.stringify(tags)]);
    const r = await storage.createEvalResult({ evalJobId: job.id, providerId, siteId: "na-us-seattle-01", responseLatencyMedian: latency } as any);
    ids[name] = r.id;
  }

  const get = async (path: string) => {
    const res = await fetch(`${BASE_URL}${path}`);
    return { status: res.status, body: await res.json() };
  };
  const q = (...tags: string[]) => tags.map((t) => `tag=${encodeURIComponent(t)}`).join("&");
  const mine = (rows: Array<{ id: number }>) =>
    Object.entries(ids).filter(([, id]) => rows.some((r) => r.id === id)).map(([n]) => n).sort();
  const ours = <T extends { providerId?: string }>(rows: T[]) => rows.filter((r) => r.providerId === providerId);

  // A one-hour raw window around now, and a 10-day window that buckets by hour.
  const now = Date.now();
  const RAW = `from=${now - 3600000}&to=${now + 120000}`;
  const HOURLY = `from=${now - 10 * 86400000}&to=${now + 3600000}`;

  beforeAll(async () => {
    providerId = (await storage.createProvider({ name: `net tags detail ${stamp}`, sku: "convoai", description: "test", createdAt: new Date("2000-01-01T00:00:00Z") } as any)).id;
    scoutId = (await pool.query("SELECT id FROM users WHERE email = $1", ["scout@vox.ai"])).rows[0].id as number;
    otherId = (await pool.query("SELECT id FROM users WHERE email = $1", ["admin@vox.local"])).rows[0].id as number;
    await fixture("m1-detected-starlink", "mainline", [{ key: "isp", value: STARLINK, source: "detected" }], 1000);
    await fixture("m2-handset-att", "mainline", [{ key: "isp", value: ATT, source: "agent" }], 1400);
    await fixture("m3-untagged", "mainline", null, 1800);
    await fixture("c1-handset+detected", "community", [{ key: "isp", value: ATT, source: "agent" }, { key: "isp", value: STARLINK, source: "detected" }], 2000);
  });

  afterAll(async () => {
    if (jobIds.length) await pool.query("DELETE FROM eval_jobs WHERE id = ANY($1)", [jobIds]);
    if (providerId) await pool.query("DELETE FROM providers WHERE id = $1", [providerId]).catch(() => {});
  });

  it("raw detail returns only rows matching the tag filter, on the board's rule", async () => {
    const all = await get(`/api/metrics/realtime/detail?${RAW}`);
    expect(all.status).toBe(200);
    expect(all.body.resolution).toBe("raw");
    expect(mine(all.body.metrics)).toEqual(["m1-detected-starlink", "m2-handset-att", "m3-untagged"]);

    const starlink = await get(`/api/metrics/realtime/detail?${RAW}&${q(`isp:${STARLINK}`)}`);
    expect(mine(starlink.body.metrics)).toEqual(["m1-detected-starlink"]);
    // A hand-set-only isp never counts on mainline.
    expect(mine((await get(`/api/metrics/realtime/detail?${RAW}&${q(`isp:${ATT}`)}`)).body.metrics)).toEqual([]);
    // Community: hand-set beats detected.
    expect(mine((await get(`/api/metrics/community/detail?${RAW}&${q(`isp:${ATT}`)}`)).body.metrics)).toEqual(["c1-handset+detected"]);
    expect(mine((await get(`/api/metrics/community/detail?${RAW}&${q(`isp:${STARLINK}`)}`)).body.metrics)).toEqual([]);
  });

  it("bucketed detail applies the filter before averaging", async () => {
    const all = ours((await get(`/api/metrics/realtime/detail?${HOURLY}`)).body.metrics as Array<{ providerId: string; responseLatency: number }>);
    expect(all.map((r) => r.responseLatency)).toEqual([1400]); // the three mainline rows averaged
    const r = await get(`/api/metrics/realtime/detail?${HOURLY}&${q(`isp:${STARLINK}`)}`);
    expect(r.status).toBe(200);
    expect(r.body.resolution).toBe("hour");
    expect(ours(r.body.metrics as Array<{ providerId: string; responseLatency: number }>).map((x) => x.responseLatency)).toEqual([1000]);
  });

  it("a bad tag is a 400 with the parser's message", async () => {
    const r = await get(`/api/metrics/realtime/detail?${RAW}&tag=link:carrier-pigeon`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/link/);
  });
});
