import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Network tags — freezing at claim (designs/2026-10-22-network-tags-design.md
// "Detection", "Freezing at claim"). Unit tests for buildJobTags with an
// injected ASN lookup (no mmdb needed), plus integration over the claim SQL in
// a private, freshly migrated database (nothing to leak into the dev DB).

await vi.hoisted(async () => {
  if (process.env.DATABASE_URL) {
    const { prepareIsolatedCoreDb } = await import("./helpers/isolated-core-db");
    process.env.DATABASE_URL = await prepareIsolatedCoreDb(process.env.DATABASE_URL, "vox_test_network_tags_claim");
  }
});
import { storage, pool, buildJobSnapshot } from "../server/storage";
import { buildJobTags, type AsnLookupFn } from "../server/job-tags";
import type { EvalFlow } from "../shared/schema";
import type { LineLookup } from "../shared/tags";

const starlinkAsn: AsnLookupFn = () => ({ asn: 14593, org: "SpaceX Services, Inc." });
const attAsn: AsnLookupFn = () => ({ asn: 7018, org: "AT&T Services, Inc." });
const noAsn: AsnLookupFn = () => null;

const PHONE = { kind: "eval", transport: "phone" };
const WEB = { kind: "eval", transport: "web" };
const ANALYZE = { kind: "analyze", transport: "web" };

const lookup = (value: string): LineLookup => ({
  value, carrierName: "Twilio - SMS/MMS-SVR", lineType: "nonFixedVoip",
  lookedUpAt: "2026-10-22T00:00:00.000Z", number: "…1234",
});

describe("buildJobTags (unit, injected ASN lookup)", () => {
  it("orders flow, detected line, agent, detected isp, detected link", () => {
    const tags = buildJobTags({
      job: PHONE,
      snapshotFlow: { tags: [{ key: "line", value: "bandwidth" }, { key: "codec", value: "opus" }], lineLookup: lookup("twilio") },
      agent: { tags: [{ key: "isp", value: "comcast" }], linkType: "wifi", observedIp: "203.0.113.7" },
    }, attAsn);
    expect(tags).toEqual([
      { key: "line", value: "bandwidth", source: "flow" },
      { key: "codec", value: "opus", source: "flow" },
      { key: "line", value: "twilio", source: "detected" },
      { key: "isp", value: "comcast", source: "agent" },
      { key: "isp", value: "att", source: "detected" },
      { key: "link", value: "wifi", source: "detected" },
    ]);
  });

  it("keeps an agent hand-set tag even when it repeats a detected key", () => {
    const tags = buildJobTags({
      job: PHONE,
      snapshotFlow: null,
      agent: { tags: [{ key: "link", value: "ethernet" }], linkType: "wifi", observedIp: "203.0.113.7" },
    }, noAsn);
    expect(tags).toEqual([
      { key: "link", value: "ethernet", source: "agent" },
      { key: "link", value: "wifi", source: "detected" },
    ]);
  });

  it("no IP → no detected isp (and the lookup is not even asked)", () => {
    const spy = vi.fn(attAsn);
    const tags = buildJobTags({ job: PHONE, snapshotFlow: null, agent: { tags: [], linkType: null, observedIp: null } }, spy);
    expect(tags).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("no ASN answer → no detected isp", () => {
    expect(buildJobTags({ job: PHONE, snapshotFlow: null, agent: { tags: [], linkType: null, observedIp: "203.0.113.7" } }, noAsn)).toEqual([]);
  });

  it("unmapped ASN falls back to the normalised org name", () => {
    const tags = buildJobTags({ job: PHONE, snapshotFlow: null, agent: { tags: [], linkType: null, observedIp: "203.0.113.7" } },
      () => ({ asn: 64512, org: "Example Fiber Co" }));
    expect(tags).toEqual([{ key: "isp", value: "example-fiber-co", source: "detected" }]);
  });

  it("satellite ISP with no link reported → link:satellite detected", () => {
    const tags = buildJobTags({ job: PHONE, snapshotFlow: null, agent: { tags: [], linkType: null, observedIp: "203.0.113.7" } }, starlinkAsn);
    expect(tags).toEqual([
      { key: "isp", value: "starlink", source: "detected" },
      { key: "link", value: "satellite", source: "detected" },
    ]);
  });

  it("a reported link wins over the satellite inference", () => {
    const tags = buildJobTags({ job: PHONE, snapshotFlow: null, agent: { tags: [], linkType: "ethernet", observedIp: "203.0.113.7" } }, starlinkAsn);
    expect(tags).toEqual([
      { key: "isp", value: "starlink", source: "detected" },
      { key: "link", value: "ethernet", source: "detected" },
    ]);
  });

  it("old snapshot without tags/lineLookup → no flow tags", () => {
    expect(buildJobTags({ job: PHONE, snapshotFlow: { name: "old" } as any, agent: { tags: [], linkType: null, observedIp: null } }, noAsn)).toEqual([]);
  });

  it("a web job with a leftover number lookup gets no detected line (finding 2)", () => {
    const tags = buildJobTags({
      job: WEB,
      snapshotFlow: { tags: [{ key: "line", value: "bandwidth" }], lineLookup: lookup("twilio") },
      agent: { tags: [], linkType: "wifi", observedIp: null },
    }, noAsn);
    expect(tags).toEqual([
      { key: "line", value: "bandwidth", source: "flow" },
      { key: "link", value: "wifi", source: "detected" },
    ]);
  });

  it("an analysis gets no tags at all — not even the agent's vantage point (finding 1)", () => {
    const spy = vi.fn(attAsn);
    const tags = buildJobTags({
      job: ANALYZE,
      snapshotFlow: { tags: [{ key: "codec", value: "opus" }], lineLookup: lookup("twilio") },
      agent: { tags: [{ key: "isp", value: "comcast" }], linkType: "wifi", observedIp: "203.0.113.7" },
    }, spy);
    expect(tags).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("drops malformed stored values rather than freezing them", () => {
    const tags = buildJobTags({
      job: PHONE,
      snapshotFlow: { tags: [{ key: "Bad Key!", value: "x" }, { key: "line", value: "twilio" }] as any, lineLookup: null },
      agent: { tags: "nope" as any, linkType: "carrier-pigeon", observedIp: null },
    }, noAsn);
    expect(tags).toEqual([{ key: "line", value: "twilio", source: "flow" }]);
  });
});

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("claim freezes eval_jobs.tags (integration, both claim paths)", () => {
  let providerId: string;
  let flowId: number;

  beforeAll(async () => {
    await pool.query(`INSERT INTO users(id,username,email,plan,is_admin,is_enabled)
      VALUES(1,'TagsAdmin','tags-admin@test.local','principal',true,true),
            (2,'TagsScout','tags-scout@test.local','principal',false,true)`);
    await pool.query("SELECT setval(pg_get_serial_sequence('users','id'),2)");
    providerId = (await pool.query(`SELECT id FROM providers ORDER BY id LIMIT 1`)).rows[0].id;
    flowId = (await pool.query(
      `INSERT INTO eval_flows (name, owner_id, provider_id, tags, line_lookup)
       VALUES ('tags-flow', 2, $1, $2::jsonb, $3::jsonb) RETURNING id`,
      [providerId, JSON.stringify([{ key: "line", value: "bandwidth" }]), JSON.stringify(lookup("twilio"))],
    )).rows[0].id;
  });
  afterAll(async () => { await pool.end(); });

  const liveFlow = async (): Promise<EvalFlow> => (await storage.getEvalFlow(flowId))!;

  const mkToken = (name: string, siteId: string, tier = "public", createdBy = 1) =>
    storage.createEvalAgentToken({
      name, tokenHash: `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      siteId, dispatchTier: tier, createdBy,
    } as any);

  const mkAgent = async (tokenId: number, siteId: string, opts: { tags: unknown[]; linkType: string | null; ip: string | null }) => {
    const a = await storage.createEvalAgent({ tokenId, name: `tags-a-${Date.now()}-${Math.random()}`, siteId, state: "idle", metadata: {} } as any);
    await pool.query(`UPDATE eval_agents SET tags = $2::jsonb, link_type = $3, observed_ip = $4 WHERE id = $1`,
      [a.id, JSON.stringify(opts.tags), opts.linkType, opts.ip]);
    return a;
  };

  // Phone by default: the detected `line` is frozen only onto phone jobs
  // (the stamped eval_jobs.transport, taken from snapshot.transport).
  const mkJob = async (fields: { targetTokenId?: number; targetRegion?: string; targetTier?: string; transport?: "web" | "phone"; kind?: "eval" | "analyze" }) =>
    storage.createEvalJob({
      evalFlowId: flowId, triggerType: 2, evalSetId: null, createdBy: 2, creatorOrgId: null,
      siteId: null, targetTokenId: fields.targetTokenId ?? null,
      targetRegion: fields.targetRegion ?? null, targetTier: fields.targetTier ?? null,
      kind: fields.kind ?? "eval",
      config: {}, snapshot: { ...buildJobSnapshot(await liveFlow(), null, null, "principal"), transport: fields.transport ?? "phone" },
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);

  const identity = (tok: any) => ({
    id: tok.id, siteId: tok.siteId, region: tok.region, dispatchTier: tok.dispatchTier,
    createdBy: tok.createdBy, ownerOrgId: null, locationTrust: "trusted",
    phoneCapable: true, analyzeCapable: true,
  });

  const allSources = [
    { key: "line", value: "bandwidth", source: "flow" },
    { key: "line", value: "twilio", source: "detected" },
    { key: "isp", value: "comcast", source: "agent" },
    { key: "isp", value: "att", source: "detected" },
    { key: "link", value: "wifi", source: "detected" },
  ];

  const storedTags = async (jobId: number) =>
    (await pool.query(`SELECT tags FROM eval_jobs WHERE id = $1`, [jobId])).rows[0].tags;

  it("targeted claim (claimEvalJob): all sources land on the job; later edits never change it", async () => {
    const tok = await mkToken(`tags-tgt-${Date.now()}`, "na-us-ashburn-01");
    const agent = await mkAgent(tok.id, tok.siteId!, { tags: [{ key: "isp", value: "comcast" }], linkType: "wifi", ip: "203.0.113.7" });
    const job = await mkJob({ targetTokenId: tok.id });
    expect(job.tags ?? null).toBeNull(); // pending: nothing frozen yet

    const claimed = await storage.claimEvalJob(job.id, agent.id, identity(tok), { asnLookup: attAsn });
    expect(claimed?.tags).toEqual(allSources);
    expect(await storedTags(job.id)).toEqual(allSources);

    // Edit the live flow and the agent afterwards — the job keeps what it froze.
    await storage.updateEvalFlow(flowId, { tags: [{ key: "line", value: "telnyx" }], lineLookup: lookup("vonage") } as any);
    await pool.query(`UPDATE eval_agents SET tags = '[{"key":"isp","value":"verizon"}]'::jsonb, link_type = 'cellular', observed_ip = NULL WHERE id = $1`, [agent.id]);
    expect(await storedTags(job.id)).toEqual(allSources);
    // restore the flow for the next test
    await storage.updateEvalFlow(flowId, { tags: [{ key: "line", value: "bandwidth" }], lineLookup: lookup("twilio") } as any);
  });

  it("pooled claim (getClaimableJobsForToken → claimEvalJob): listed untagged, frozen with all sources at claim", async () => {
    const tok = await mkToken(`tags-pool-${Date.now()}`, "na-us-ashburn-02");
    const agent = await mkAgent(tok.id, tok.siteId!, { tags: [{ key: "isp", value: "comcast" }], linkType: "wifi", ip: "203.0.113.8" });
    const job = await mkJob({ targetRegion: "na-us-ashburn", targetTier: "public" });

    const listed = (await storage.getClaimableJobsForToken(identity(tok))).find((j) => j.id === job.id);
    expect(listed).toBeDefined();
    expect(listed!.tags ?? null).toBeNull();

    const claimed = await storage.claimEvalJob(listed!.id, agent.id, identity(tok), { asnLookup: attAsn });
    expect(claimed?.tags).toEqual(allSources);

    await storage.updateEvalFlow(flowId, { tags: [], lineLookup: null } as any);
    await pool.query(`UPDATE eval_agents SET tags = '[]'::jsonb, link_type = NULL WHERE id = $1`, [agent.id]);
    expect(await storedTags(job.id)).toEqual(allSources);
    await storage.updateEvalFlow(flowId, { tags: [{ key: "line", value: "bandwidth" }], lineLookup: lookup("twilio") } as any);
  });

  it("agent without an observed IP → no detected isp", async () => {
    const tok = await mkToken(`tags-noip-${Date.now()}`, "na-us-ashburn-03");
    const agent = await mkAgent(tok.id, tok.siteId!, { tags: [], linkType: null, ip: null });
    const job = await mkJob({ targetTokenId: tok.id });
    const claimed = await storage.claimEvalJob(job.id, agent.id, identity(tok), { asnLookup: attAsn });
    expect(claimed?.tags).toEqual([
      { key: "line", value: "bandwidth", source: "flow" },
      { key: "line", value: "twilio", source: "detected" },
    ]);
  });

  it("satellite ISP with no link reported → link:satellite detected", async () => {
    const tok = await mkToken(`tags-sat-${Date.now()}`, "na-us-ashburn-04");
    const agent = await mkAgent(tok.id, tok.siteId!, { tags: [], linkType: null, ip: "203.0.113.9" });
    const job = await mkJob({ targetRegion: "na-us-ashburn", targetTier: "public" });
    const claimed = await storage.claimEvalJob(job.id, agent.id, identity(tok), { asnLookup: starlinkAsn });
    expect(claimed?.tags).toEqual([
      { key: "line", value: "bandwidth", source: "flow" },
      { key: "line", value: "twilio", source: "detected" },
      { key: "isp", value: "starlink", source: "detected" },
      { key: "link", value: "satellite", source: "detected" },
    ]);
  });

  it("a web job whose snapshot carries a leftover lineLookup gets no detected line (finding 2)", async () => {
    const tok = await mkToken(`tags-web-${Date.now()}`, "na-us-ashburn-06");
    const agent = await mkAgent(tok.id, tok.siteId!, { tags: [], linkType: "wifi", ip: null });
    const job = await mkJob({ targetTokenId: tok.id, transport: "web" });
    expect(job.transport).toBe("web");
    const claimed = await storage.claimEvalJob(job.id, agent.id, identity(tok), { asnLookup: attAsn });
    expect(claimed?.tags).toEqual([
      { key: "line", value: "bandwidth", source: "flow" },
      { key: "link", value: "wifi", source: "detected" },
    ]);
  });

  it("an analysis claim freezes no tags — the agent's vantage point isn't the recording's (finding 1)", async () => {
    const tok = await mkToken(`tags-an-${Date.now()}`, "na-us-ashburn-07");
    const agent = await mkAgent(tok.id, tok.siteId!, { tags: [{ key: "isp", value: "comcast" }], linkType: "wifi", ip: "203.0.113.10" });
    const job = await mkJob({ kind: "analyze", transport: "web" });
    const claimed = await storage.claimEvalJob(job.id, agent.id, identity(tok), { asnLookup: attAsn });
    expect(claimed).toBeDefined();
    expect(claimed?.siteId ?? null).toBeNull();
    expect(claimed?.tags).toEqual([]);
    expect(await storedTags(job.id)).toEqual([]);
  });

  it("a job whose snapshot predates tags gets only agent/detected tags", async () => {
    const tok = await mkToken(`tags-old-${Date.now()}`, "na-us-ashburn-05");
    const agent = await mkAgent(tok.id, tok.siteId!, { tags: [{ key: "isp", value: "comcast" }], linkType: null, ip: null });
    const job = await storage.createEvalJob({
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: 2, creatorOrgId: null,
      siteId: null, targetTokenId: tok.id,
      config: {}, snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    const claimed = await storage.claimEvalJob(job.id, agent.id, identity(tok), { asnLookup: noAsn });
    expect(claimed?.tags).toEqual([{ key: "isp", value: "comcast", source: "agent" }]);
  });
});
