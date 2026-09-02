import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { storage, db } from "../server/storage";
import { evalJobs, evalResults, providers } from "../shared/schema";
import { BASE_NA, BASE_EU } from "./helpers/regions";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("zero-trust metrics gates", () => {
  const jobIds: number[] = []; const resultIds: number[] = [];
  let providerId: string;
  let publicSnap: Record<string, unknown>;

  // seed one completed job+result per case (NB: the results FK column is
  // evalJobId, and providerId must be a REAL seeded provider id)
  const seed = async (over: {
    tier: "public" | "shared" | "private" | "team"; trust: string | null; siteId: string | null;
  }) => {
    const job = (await db.insert(evalJobs).values({
      createdBy: 1, status: "completed", config: {}, snapshot: publicSnap,
      tokenDispatchTier: over.tier, locationTrust: over.trust, siteId: over.siteId,
    } as typeof evalJobs.$inferInsert).returning())[0];
    jobIds.push(job.id);
    const result = (await db.insert(evalResults).values({
      evalJobId: job.id, providerId, siteId: over.siteId,
      responseLatencyMedian: 500,
    } as typeof evalResults.$inferInsert).returning())[0];
    resultIds.push(result.id);
    return result.id;
  };

  // trustedShared/anonShared/legacyShared/unverifiedShared exercise the
  // COMMUNITY trust gate: tokenDispatchTier='shared' is required for a row to
  // even be eligible for the community board ("tier as restriction" —
  // confirmed by tests/tier-classification.test.ts's shared-tier arm).
  let trustedShared: number, anonShared: number, legacyShared: number, unverifiedShared: number;

  // myPrivateTrusted/myPrivateUnverified exercise the MY-EVALS region scope
  // (unverified / baseIds OR-composition). Deviation from the brief: the
  // brief's draft reused the community fixtures (tier='shared') for the
  // my-evals assertions too, but `myEvalConditions` (server/storage.ts ~1599)
  // only surfaces a public-content job when tokenDispatchTier is 'private' or
  // 'team' AND createdBy matches — a 'shared'-tier public-content job is by
  // design never visible in My Evals (see
  // tests/tier-classification.test.ts:128 "public-tier agent + public content
  // stays OUT of My Evals (still Community's)"; the same holds for 'shared').
  // So the my-evals region-scope fixtures below use tier='private' instead,
  // which is what actually satisfies myEvalConditions's agent-tier arm.
  let myPrivateTrusted: number, myPrivateUnverified: number;

  beforeAll(async () => {
    providerId = (await db.select().from(providers).limit(1))[0].id;
    publicSnap = {
      workflow: { visibility: "public", isMainline: false, ownerId: 1 },
      evalSet: { visibility: "public", isMainline: false, ownerId: 1 },
      provider: { id: providerId }, creatorPlan: "premium",
    };
    trustedShared = await seed({ tier: "shared", trust: "trusted", siteId: `${BASE_NA}-88` });
    anonShared    = await seed({ tier: "shared", trust: "anonymized", siteId: `${BASE_EU}-88` });
    legacyShared  = await seed({ tier: "shared", trust: null, siteId: `${BASE_NA}-89` });
    unverifiedShared = await seed({ tier: "shared", trust: "anonymized", siteId: null });
    myPrivateTrusted = await seed({ tier: "private", trust: "trusted", siteId: `${BASE_NA}-90` });
    myPrivateUnverified = await seed({ tier: "private", trust: "anonymized", siteId: null });
  });
  afterAll(async () => {
    await db.delete(evalResults).where(inArray(evalResults.id, resultIds));
    await db.delete(evalJobs).where(inArray(evalJobs.id, jobIds));
  });

  it("community includes trusted + legacy(NULL) shared rows, excludes anonymized", async () => {
    const rows = await storage.getCommunityMetrics(undefined, undefined);
    const ids = rows.map(r => r.id);
    expect(ids).toContain(trustedShared);
    expect(ids).toContain(legacyShared);
    expect(ids).not.toContain(anonShared);
    expect(ids).not.toContain(unverifiedShared); // no region AND untrusted
  });

  it("unverified scope selects NULL-siteId rows for my-evals", async () => {
    const rows = await storage.getMyEvalMetrics(1, undefined, { unverified: true });
    expect(rows.map(r => r.id)).toContain(myPrivateUnverified);
    expect(rows.map(r => r.id)).not.toContain(myPrivateTrusted);
    expect(rows.map(r => r.id)).not.toContain(trustedShared); // shared tier never reaches My Evals
  });

  it("unverified + baseIds compose as OR", async () => {
    const rows = await storage.getMyEvalMetrics(1, undefined, { baseIds: [BASE_NA], unverified: true });
    const ids = rows.map(r => r.id);
    expect(ids).toContain(myPrivateUnverified);
    expect(ids).toContain(myPrivateTrusted);
  });

  it("getAvailableRegions strips the site suffix and reports hasUnverified", async () => {
    const avail = await storage.getAvailableRegions("myEvals", undefined, 1);
    expect(avail.baseIds).toContain(BASE_NA);
    expect(avail.hasUnverified).toBe(true);
    const community = await storage.getAvailableRegions("community");
    expect(community.baseIds).toContain(BASE_NA);
    expect(community.baseIds).not.toContain(`${BASE_NA}-88`); // baseIds, not siteIds
  });
});
