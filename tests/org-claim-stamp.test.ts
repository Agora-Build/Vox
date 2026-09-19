import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage, pool } from "../server/storage";
import { schemaForPlugin } from "../server/plugins/db";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

// Membership (and the org row it points at) lives in the organizations plugin's
// schema since the Release A flip. This suite's whole point is that the frozen
// `creatorOrgId` stamp survives a REAL membership change, so the org/membership
// fixtures are written where membership actually lives — raw SQL, matching the
// suite's existing raw-dev-DB seeding style (no provider is installed in-process
// here, and the claim path under test reads only opaque stamped integers).
const ORGS_SCHEMA = schemaForPlugin("organizations");

const mkOrg = async (name: string): Promise<number> => {
  const { rows } = await pool.query(
    `INSERT INTO ${ORGS_SCHEMA}.organizations (name) VALUES ($1) RETURNING id`, [name]);
  return rows[0].id;
};
const joinOrg = (orgId: number, userId: number, role: string) =>
  pool.query(
    `INSERT INTO ${ORGS_SCHEMA}.memberships (org_ref, user_ref, role) VALUES ($1, $2, $3)`,
    [orgId, userId, role]);
const leaveOrg = (orgId: number, userId: number) =>
  pool.query(
    `DELETE FROM ${ORGS_SCHEMA}.memberships WHERE org_ref = $1 AND user_ref = $2`,
    [orgId, userId]);

// Factories mirror tests/tier-pool-claim.test.ts (same dev-DB seeding style).
const mkToken = (name: string, siteId: string, tier: string, createdBy: number) =>
  storage.createEvalAgentToken({
    name, tokenHash: `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    siteId, dispatchTier: tier, createdBy,
  } as any);

const mkTeamJob = (createdBy: number, creatorOrgId: number | null) =>
  storage.createEvalJob({
    workflowId: null, triggerType: 2, evalSetId: null, createdBy,
    siteId: null, targetRegion: "na-us-ashburn", targetTier: "team",
    creatorOrgId,
    config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
    status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
  } as any);

d("R2: claimability is frozen at creation (design §11, pinned semantic change)", () => {
  let orgId: number, creatorId: number, tokenArg: any, agentId: number;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    orgId = await mkOrg(`r2-org-${suffix}`);
    creatorId = (await storage.createUser({
      username: `r2c${suffix}`, email: `r2c${suffix}@example.com`,
    } as any)).id;
    const memberId = (await storage.createUser({
      username: `r2m${suffix}`, email: `r2m${suffix}@example.com`,
    } as any)).id;
    await joinOrg(orgId, creatorId, "member");
    await joinOrg(orgId, memberId, "member");
    // The claiming side stays in the org throughout — only the CREATOR leaves.
    const tok = await mkToken(`r2-team-${suffix}`, "na-us-ashburn-01", "team", memberId);
    tokenArg = {
      id: tok.id, siteId: tok.siteId, region: tok.region, dispatchTier: tok.dispatchTier,
      createdBy: tok.createdBy, ownerOrgId: orgId, locationTrust: "trusted",
    };
    agentId = (await storage.createEvalAgent({
      tokenId: tok.id, name: `r2-agent-${suffix}`, siteId: tok.siteId, state: "idle", metadata: {},
    } as any)).id;
  });

  // The plugin-schema rows this suite seeds are its own to remove: without this,
  // every run left +1 organization and +1 membership behind in
  // plugin_organizations (the residue the final review measured, 814→815→816).
  // Ids are known, so the delete is exact — no name-pattern sweep.
  // (The Core-side fixtures — users, token, agent, jobs — are the pre-existing
  // #134 accumulation class with its own documented cleanup SQL in CLAUDE.md,
  // and deleting the user rows here would orphan the jobs that reference them.)
  afterAll(async () => {
    if (!hasDb || !orgId) return;
    await pool.query(`DELETE FROM ${ORGS_SCHEMA}.memberships WHERE org_ref = $1`, [orgId]);
    await pool.query(`DELETE FROM ${ORGS_SCHEMA}.organizations WHERE id = $1`, [orgId]);
  });

  it("a pending team job stays claimable after its creator leaves the org", async () => {
    const job = await mkTeamJob(creatorId, orgId); // the stamp — seam-resolved at the real creation sites
    await leaveOrg(orgId, creatorId); // creator leaves AFTER creation — a REAL un-join,
    // i.e. the membership row the provider serves is gone (writing the frozen
    // users.organization_id column would no longer change any answer).
    expect((await storage.getClaimableJobsForToken(tokenArg)).map((j) => j.id)).toContain(job.id);
    const claimed = await storage.claimEvalJob(job.id, agentId, tokenArg);
    expect(claimed?.id).toBe(job.id); // frozen: still claimable (was: unclaimable once the creator left)
  });

  it("a team job stamped with creatorOrgId null is never claimable via the team arm", async () => {
    const job = await mkTeamJob(creatorId, null);
    expect((await storage.getClaimableJobsForToken(tokenArg)).map((j) => j.id)).not.toContain(job.id);
    expect(await storage.claimEvalJob(job.id, agentId, tokenArg)).toBeUndefined();
  });
});
