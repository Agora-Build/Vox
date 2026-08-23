import { describe, it, expect, afterAll } from "vitest";
import { storage, db } from "../server/storage";
import { evalJobs, evalResults, providers } from "../shared/schema";
import { eq, inArray } from "drizzle-orm";
import { BASE_NA } from "./helpers/regions";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

// A snapshot that satisfies every CONTENT gate for Mainline: public+mainline
// workflow, public+mainline eval set, principal creator. Only the frozen agent
// tier then decides Mainline (public) vs Community (shared).
const mainlineSnapshot = (ownerId: number) => ({
  workflow: { name: "T1 WF", config: {}, visibility: "public", isMainline: true, ownerId, organizationId: null },
  evalSet: { name: "T1 ES", config: {}, visibility: "public", isMainline: true, ownerId },
  provider: { id: "unused" },
  creatorPlan: "principal",
});

d("frozen agent tier gates the leaderboard bucket (tier as restriction)", () => {
  const siteId = `${BASE_NA}-01`;
  const createdIds: number[] = [];

  afterAll(async () => {
    if (createdIds.length) await db.delete(evalJobs).where(inArray(evalJobs.id, createdIds));
  });

  async function seedCompletedJob(tokenDispatchTier: string): Promise<number> {
    const [provider] = await db.select().from(providers).limit(1);
    const [job] = await db.insert(evalJobs).values({
      siteId,
      status: "completed",
      createdBy: 1,
      config: {},
      snapshot: mainlineSnapshot(1) as any,
      tokenDispatchTier,
    } as any).returning();
    createdIds.push(job.id);
    await db.insert(evalResults).values({
      evalJobId: job.id,
      providerId: provider.id,
      siteId,
      responseLatencyMedian: 500,
    } as any);
    return job.id;
  }

  it("public-tier agent → Mainline; shared-tier agent → Community, never Mainline", async () => {
    const publicJobId = await seedCompletedJob("public");
    const sharedJobId = await seedCompletedJob("shared");

    const mainline = await storage.getMainlineEvalResults(500);
    const community = await storage.getCommunityEvalResults(500);

    const mainlineJobIds = new Set(mainline.map(r => r.evalJobId));
    const communityJobIds = new Set(community.map(r => r.evalJobId));

    // public-tier mainline-content → Mainline (and NOT double-counted in Community)
    expect(mainlineJobIds.has(publicJobId)).toBe(true);
    expect(communityJobIds.has(publicJobId)).toBe(false);

    // shared-tier same content → demoted to Community, excluded from Mainline
    expect(mainlineJobIds.has(sharedJobId)).toBe(false);
    expect(communityJobIds.has(sharedJobId)).toBe(true);
  });
});
