import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

await vi.hoisted(async () => {
  if (process.env.DATABASE_URL) {
    const { prepareIsolatedCoreDb } = await import("./helpers/isolated-core-db");
    process.env.DATABASE_URL = await prepareIsolatedCoreDb(process.env.DATABASE_URL, "vox_test_location_check_gen");
  }
});

import { eq } from "drizzle-orm";
import { db, pool, storage, hashToken } from "../server/storage";
import { evalAgents, evalAgentTokens, users, insertEvalAgentSchema } from "../shared/schema";
import { runAgentLocationCheck, accessSignalsFrom, type DetectionDeps } from "../server/location";
import { createAccessData } from "../server/access-data";
import type { AgentNetSignals } from "../server/access-class";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const IP = "80.150.1.1";
const RDNS = "p5096a101.dip0.t-ipconnect.de";
const recheckAfterMs = 2 * 60 * 60 * 1000;
const core = { storage, runAgentLocationCheck, pool };
const signals = { cloudMetadata: false, publicIpOnInterface: false };
const access = createAccessData({ apnic: new Map([[3320, 38.27]]) });

function deps(overrides: Partial<DetectionDeps> = {}): DetectionDeps {
  return {
    geo: () => ({ city: "Frankfurt am Main", countryCode: "DE", countryName: "Germany", continentCode: "EU", lat: 50.11, lon: 8.68, accuracyKm: 20 }),
    asn: () => ({ asn: 3320, org: "Deutsche Telekom" }),
    torExits: new Set(), networkClass: () => null, networkClassLoaded: true,
    accessSignals: accessSignalsFrom(access), reverseDns: async () => RDNS,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describeDb("database-backed location check generations", () => {
  let tokenId: number;
  let agentId: number;
  let other: typeof core;
  const row = () => storage.getEvalAgent(agentId).then((agent) => agent!);
  const prepare = (instance: typeof core, netSignals?: AgentNetSignals, forceCheck = true) =>
    instance.storage.prepareEvalAgentLocationCheck(agentId, { ip: IP, netSignals, forceCheck, recheckAfterMs });
  const run = (instance: typeof core, observation: Awaited<ReturnType<typeof prepare>>, dispatchTier = "private", detection = deps()) =>
    instance.runAgentLocationCheck({
      agent: observation.agent, token: { id: tokenId, dispatchTier }, ip: IP, immediate: true,
      netSignals: observation.agent.netSignals ?? undefined,
      checkGeneration: observation.agent.locationCheckGen, deps: detection,
    });

  beforeAll(async () => {
    await db.insert(users).values({ id: 1, username: "location-gen-admin", email: "location-gen@test.local" }).onConflictDoNothing();
    const [token] = await db.insert(evalAgentTokens).values({
      name: "location-gen", tokenHash: hashToken(`location-gen-${Date.now()}`),
      dispatchTier: "private", createdBy: 1, siteId: null, region: null,
    }).returning();
    tokenId = token.id;
    const [agent] = await db.insert(evalAgents).values({ name: "location-gen", tokenId }).returning();
    agentId = agent.id;
    // Independent modules and pool model two Core instances sharing PostgreSQL.
    vi.resetModules();
    const otherStorage = await import("../server/storage");
    const otherLocation = await import("../server/location");
    other = { storage: otherStorage.storage, pool: otherStorage.pool, runAgentLocationCheck: otherLocation.runAgentLocationCheck };
    expect(other.pool).not.toBe(pool);
  });

  beforeEach(async () => {
    await db.update(evalAgents).set({
      observedIp: IP, netSignals: signals, locationCheckGen: 0,
      region: "na-us-seattle", siteId: "na-us-seattle-01", locationTrust: "trusted",
      locationSource: { stage: "initial" }, locationCheckedAt: new Date(),
      pendingRegion: null, pendingRegionCount: 0,
      accessClass: "lastmile", accessReason: "v1: eyeball-asn + residential-rdns", accessIp: IP, accessCheckedAt: new Date(),
    }).where(eq(evalAgents.id, agentId));
  });

  afterAll(async () => {
    await other?.pool.end();
    await pool.end();
  });

  it.each([
    ["private", "cloudMetadata"], ["public", "cloudMetadata"],
    ["private", "publicIpOnInterface"], ["public", "publicIpOnInterface"],
  ] as const)("%s: an older same-IP check cannot undo a newer %s classification", async (dispatchTier, field) => {
    const older = await prepare(core, { [field]: false });
    const started = deferred<void>();
    const finish = deferred<string>();
    const slow = run(core, older, dispatchTier, deps({
      geo: () => ({ city: "Seattle", countryCode: "US", countryName: "United States", continentCode: "NA", lat: 47.6, lon: -122.33, accuracyKm: 20 }),
      reverseDns: async () => { started.resolve(); return finish.promise; },
    }));
    await started.promise;
    try {
      // These inputs are already committed even though DNS has not finished.
      expect(await row()).toMatchObject({ netSignals: signals, locationCheckGen: older.agent.locationCheckGen });
      const newer = await prepare(other, { [field]: true });
      expect(newer.agent.locationCheckGen).toBeGreaterThan(older.agent.locationCheckGen);
      await run(other, newer, dispatchTier);
      const current = await row();
      expect(current.accessClass).toBe(field === "cloudMetadata" ? "datacenter" : "unknown");
      finish.resolve(RDNS);
      expect(await slow).toEqual({ region: current.region, siteId: current.siteId, locationTrust: current.locationTrust });
      expect(await row()).toEqual(current);
    } finally {
      finish.resolve(RDNS);
      await slow;
    }
  });

  it("A -> B -> A cannot revive the first A check, even though its signals match again", async () => {
    const older = await prepare(core, { cloudMetadata: false });
    const started = deferred<void>();
    const finish = deferred<string>();
    const slow = run(core, older, "private", deps({ reverseDns: async () => { started.resolve(); return finish.promise; } }));
    await started.promise;
    try {
      const middle = await prepare(other, { cloudMetadata: true });
      await run(other, middle);
      const newest = await prepare(other, { cloudMetadata: false });
      expect(newest.agent.locationCheckGen).toBeGreaterThan(middle.agent.locationCheckGen);
      await run(other, newest);
      const current = await row();
      expect(current.accessClass).toBe("lastmile");
      finish.resolve(RDNS);
      await slow;
      expect(await row()).toEqual(current);
    } finally {
      finish.resolve(RDNS);
      await slow;
    }
  });

  it("concurrent partial reports from separate Core instances preserve both fields", async () => {
    const observations = await Promise.all([
      prepare(core, { cloudMetadata: true }, false),
      prepare(other, { publicIpOnInterface: true }, false),
    ]);
    expect(observations.every((observation) => observation.shouldCheck)).toBe(true);
    expect(observations.map(({ agent }) => agent.locationCheckGen).sort()).toEqual([1, 2]);
    const current = await row();
    expect(current.netSignals).toEqual({ cloudMetadata: true, publicIpOnInterface: true });
    expect(observations.find(({ agent }) => agent.locationCheckGen === 2)?.agent).toEqual(current);
  });

  it("unchanged or absent signals neither lose fields nor supersede an existing check", async () => {
    const first = await prepare(core);
    const unchanged = await prepare(other, { cloudMetadata: false }, false);
    const absent = await prepare(other, undefined, false);
    expect(unchanged.shouldCheck).toBe(false);
    expect(absent.shouldCheck).toBe(false);
    expect(absent.agent.netSignals).toEqual(signals);
    expect(absent.agent.locationCheckGen).toBe(first.agent.locationCheckGen);
    await run(core, first);
    expect((await row()).accessClass).toBe("lastmile");
  });

  it("a heartbeat without an IP or signal update can preserve a fresh observation without an empty UPDATE", async () => {
    const before = await row();
    const observation = await storage.prepareEvalAgentLocationCheck(agentId, { recheckAfterMs });
    expect(observation.shouldCheck).toBe(false);
    expect(observation.agent).toEqual(before);
    expect(await row()).toEqual(before);
  });

  it("equivalent IPv4-mapped observations do not trigger another check", async () => {
    const observation = await storage.prepareEvalAgentLocationCheck(agentId, { ip: `::ffff:${IP}`, recheckAfterMs });
    expect(observation.shouldCheck).toBe(false);
    expect(observation.agent.locationCheckGen).toBe(0);
    expect(observation.agent.observedIp).toBe(IP);
  });

  it.each(["stale", "pending region", "changed IP", "missing IP binding", "registration"])("still reserves a generation for %s checks", async (trigger) => {
    await db.update(evalAgents).set({
      observedIp: IP,
      ...(trigger === "stale" ? { locationCheckedAt: new Date(Date.now() - recheckAfterMs - 1000) } : {}),
      ...(trigger === "pending region" ? { pendingRegion: "eu-de-frankfurt", pendingRegionCount: 1 } : {}),
      ...(trigger === "changed IP" ? { observedIp: "88.198.1.1" } : {}),
      ...(trigger === "missing IP binding" ? { accessIp: null } : {}),
    }).where(eq(evalAgents.id, agentId));
    const observation = await prepare(core, undefined, trigger === "registration");
    expect(observation.shouldCheck).toBe(true);
    expect(observation.agent.locationCheckGen).toBe(1);
    expect(observation.agent.observedIp).toBe(IP);
  });

  it.each(["private", "public"])("%s: stale no-data checks cannot overwrite trust/location via optional access fields", async (dispatchTier) => {
    const older = await prepare(core);
    const newer = await prepare(other, { cloudMetadata: true });
    await run(other, newer, dispatchTier);
    const current = await row();
    const result = await run(core, older, dispatchTier, deps({ geo: () => null, networkClassLoaded: false }));
    expect(await row()).toEqual(current);
    expect(result).toEqual({ region: current.region, siteId: current.siteId, locationTrust: current.locationTrust });
  });

  it("unloaded-data checks cannot write back their older generation", async () => {
    const older = await prepare(core);
    const newer = await prepare(other, { cloudMetadata: true });
    await run(other, newer);
    const current = await row();
    await run(core, older, "private", deps({ networkClassLoaded: false }));
    expect(await row()).toEqual(current);
  });

  it("migration adds a non-null bigint generation defaulting to zero; input cannot set it", async () => {
    const { rows } = await pool.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'eval_agents' AND column_name = 'location_check_gen'`);
    expect(rows[0]).toMatchObject({ data_type: "bigint", is_nullable: "NO", column_default: "0" });
    expect(insertEvalAgentSchema.parse({ name: "input", tokenId, locationCheckGen: 100 })).not.toHaveProperty("locationCheckGen");
  });

  it("migration backfills existing rows without altering their classification and is restart-safe", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE TEMP TABLE eval_agents (id int, observed_ip text, access_class text) ON COMMIT DROP");
      await client.query("INSERT INTO pg_temp.eval_agents VALUES (1, $1, 'lastmile')", [IP]);
      const migration = readFileSync("migrations/0064_location_check_gen.sql", "utf8");
      await client.query(migration);
      await client.query(migration);
      const { rows } = await client.query("SELECT * FROM pg_temp.eval_agents");
      expect(rows).toEqual([{ id: 1, observed_ip: IP, access_class: "lastmile", location_check_gen: "0" }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
