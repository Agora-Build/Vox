import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { createServer } from "http";
import { setOrganizations, resetOrganizations, type OrganizationsProvider } from "../server/organizations";
import { CoreOrganizations } from "../server/organizations-core";
import { membershipFor, authenticateApiKey } from "../server/auth";
import { storage, pool, encryptValue, hashToken } from "../server/storage";
import { processScheduledJobs, runMaintenanceTasks } from "../server/scheduler";
import { registerRoutes } from "../server/routes";

// Every method throws — this exercises "provider installed but failing", which
// must stay distinguishable from "provider absent" (see server/organizations.ts).
const failing: OrganizationsProvider = {
  getMembership: async () => { throw new Error("db blip"); },
  getMemberships: async () => { throw new Error("db blip"); },
  getOrganization: async () => { throw new Error("db blip"); },
  listMembers: async () => { throw new Error("db blip"); },
  countMembers: async () => { throw new Error("db blip"); },
  countOrgAdmins: async () => { throw new Error("db blip"); },
  listOrganizations: async () => { throw new Error("db blip"); },
  createOrganization: async () => { throw new Error("db blip"); },
  updateOrganization: async () => { throw new Error("db blip"); },
  setVerified: async () => { throw new Error("db blip"); },
  addMember: async () => { throw new Error("db blip"); },
  setMemberRole: async () => { throw new Error("db blip"); },
  removeMember: async () => { throw new Error("db blip"); },
  listOrgSecrets: async () => { throw new Error("db blip"); },
  upsertOrgSecret: async () => { throw new Error("db blip"); },
  deleteOrgSecret: async () => { throw new Error("db blip"); },
};

describe("absence and failure semantics", () => {
  beforeEach(() => resetOrganizations());

  it("membershipFor returns null under an ABSENT provider (inert, fails closed)", async () => {
    expect(await membershipFor({} as never, 1)).toBeNull();
  });

  it("membershipFor RETHROWS under a FAILING provider — failure must stay distinguishable from 'no org'", async () => {
    setOrganizations(failing);
    await expect(membershipFor({} as never, 1)).rejects.toThrow("db blip");
  });
});

// ---------------------------------------------------------------------------
// Design §7: while the organizations provider is unavailable, the org feature
// is INERT — not broken. A full tick of BOTH background workers must leave the
// database byte-identical: no schedule disabled, no next_run moved, no job
// created, no job failed by a sweep, no broker mint burned. The ticks are
// imported and called directly (that is why server/scheduler.ts exists), so
// this exercises the real workers in-process, not the dev server.
// ---------------------------------------------------------------------------

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

// A workflow whose platform.setup references two login-class (brokered) org
// secrets — the shape that makes the tick take the session path (detectSessionNeed
// → "need" → sessionPoolViolation → stampOwnerSession/ensureSession).
const LOGIN_STEPS = (email: string, password: string) => `
- type: platform.setup
  platform_id: agora
  params:
    email: \${secrets.${email}}
    password: \${secrets.${password}}
`;

d("plugin absence causes zero persistent writes", () => {
  let orgId: number, creatorId: number, soloId: number;
  let orgWorkflowId: number, orgEvalSetId: number, orgScheduleId: number, teamJobId: number;
  let soloScheduleId: number;
  let apiKey: string;
  let app: express.Express;

  // Everything this suite may legally touch. A write ANYWHERE in these tables
  // (schedule enable/next-run/run-count, a new or failed job, a minted session)
  // breaks the equality in the zero-writes assertions.
  async function snapshot() {
    const schedules = await pool.query(
      `SELECT id, is_enabled, next_run_at, last_run_at, run_count, updated_at
         FROM eval_schedules WHERE created_by = ANY($1::int[]) ORDER BY id`,
      [[creatorId, soloId]],
    );
    const jobs = await pool.query(
      `SELECT id, status, error, target_tier, completed_at, updated_at
         FROM eval_jobs WHERE created_by = ANY($1::int[]) ORDER BY id`,
      [[creatorId, soloId]],
    );
    const sessions = await pool.query(
      `SELECT count(*)::int AS n FROM web_sessions WHERE organization_id = $1 OR user_id = ANY($2::int[])`,
      [orgId, [creatorId, soloId]],
    );
    return {
      schedules: schedules.rows,
      jobCount: jobs.rows.length,
      jobs: jobs.rows,
      sessions: sessions.rows[0].n as number,
    };
  }

  // Re-arm the org schedule so every test starts from "enabled and due".
  async function armOrgSchedule() {
    await pool.query(
      `UPDATE eval_schedules SET is_enabled = true, next_run_at = NOW() - INTERVAL '1 minute',
         last_run_at = NULL, run_count = 0 WHERE id = $1`,
      [orgScheduleId],
    );
  }

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const providerId = (await storage.getAllProviders())[0]!.id;

    const org = await storage.createOrganization({ name: `abs-org-${suffix}` } as any);
    orgId = org.id;
    creatorId = (await storage.createUser({
      username: `absc${suffix}`, email: `absc${suffix}@example.com`, organizationId: orgId, plan: "premium",
    } as any)).id;
    soloId = (await storage.createUser({
      username: `abss${suffix}`, email: `abss${suffix}@example.com`, plan: "premium",
    } as any)).id;

    // Login-class org secrets, so the org workflow genuinely needs a Core mint.
    const emailSecret = `ABS_LOGIN_EMAIL_${suffix.replace(/-/g, "_")}`;
    const passwordSecret = `ABS_LOGIN_PASSWORD_${suffix.replace(/-/g, "_")}`;
    for (const name of [emailSecret, passwordSecret]) {
      await storage.upsertOrgSecret(orgId, name, encryptValue("x"), creatorId, { brokerType: "auth-session" });
    }

    const orgWorkflow = await storage.createWorkflow({
      name: `abs-wf-${suffix}`, ownerId: creatorId, organizationId: orgId, providerId,
      visibility: "public", // public + org-owned: the run-route arm's exact shape
      config: { stepsPrefix: LOGIN_STEPS(emailSecret, passwordSecret) },
    } as any);
    orgWorkflowId = orgWorkflow.id;
    orgEvalSetId = (await storage.createEvalSet({
      name: `abs-es-${suffix}`, ownerId: creatorId, organizationId: orgId, visibility: "public", config: {},
    } as any)).id;

    orgScheduleId = (await storage.createEvalSchedule({
      name: `abs-sched-${suffix}`, workflowId: orgWorkflowId, evalSetId: orgEvalSetId,
      region: "na-us-ashburn", targetTier: "team", scheduleType: "recurring",
      cronExpression: "*/5 * * * *", isEnabled: true,
      nextRunAt: new Date(Date.now() - 60 * 1000), createdBy: creatorId, organizationId: orgId,
    } as any)).id;

    // A pending TEAM job old enough for the expired-pending backstop sweep.
    teamJobId = (await storage.createEvalJob({
      workflowId: orgWorkflowId, evalSetId: orgEvalSetId, triggerType: 2, createdBy: creatorId,
      creatorOrgId: orgId, siteId: null, targetRegion: "na-us-ashburn", targetTier: "team",
      config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any)).id;
    await pool.query(
      `UPDATE eval_jobs SET created_at = NOW() - INTERVAL '30 hours', updated_at = NOW() - INTERVAL '30 hours' WHERE id = $1`,
      [teamJobId],
    );

    // Personal control: no org anywhere on the path, no session need.
    const soloWorkflowId = (await storage.createWorkflow({
      name: `abs-solo-wf-${suffix}`, ownerId: soloId, providerId, visibility: "private", config: {},
    } as any)).id;
    const soloEvalSetId = (await storage.createEvalSet({
      name: `abs-solo-es-${suffix}`, ownerId: soloId, visibility: "private", config: {},
    } as any)).id;
    soloScheduleId = (await storage.createEvalSchedule({
      name: `abs-solo-sched-${suffix}`, workflowId: soloWorkflowId, evalSetId: soloEvalSetId,
      region: "na-us-ashburn", targetTier: "private", scheduleType: "recurring",
      cronExpression: "*/5 * * * *", isEnabled: false, // armed only by the third test
      nextRunAt: new Date(Date.now() - 60 * 1000), createdBy: soloId,
    } as any)).id;

    apiKey = `vox_live_abs${suffix.replace(/-/g, "")}`;
    await storage.createApiKey({
      name: `abs-key-${suffix}`, keyHash: hashToken(apiKey), keyPrefix: apiKey.slice(0, 16), createdBy: creatorId,
    } as any);

    // In-process API surface: the dev server always installs a provider
    // (server/index.ts), so the 501 arm can only be observed here, where the
    // holder is genuinely empty. API-key auth keeps it session-free.
    app = express();
    app.use(express.json());
    app.use(authenticateApiKey);
    await registerRoutes(createServer(app), app);
  });

  beforeEach(async () => {
    resetOrganizations();
    await armOrgSchedule();
  });

  // Later suites in this process must see Core's provider again.
  afterAll(() => setOrganizations(new CoreOrganizations(storage)));

  it("scheduler + maintenance ticks with provider ABSENT change nothing", async () => {
    const before = await snapshot();
    await processScheduledJobs();
    await runMaintenanceTasks();
    expect(await snapshot()).toEqual(before); // ZERO rows changed — design §7, both workers
  });

  it("a FAILING provider takes the same path — skip, never disable", async () => {
    setOrganizations(failing);
    const before = await snapshot();
    await processScheduledJobs();
    expect(await snapshot()).toEqual(before);
  });

  it("personal schedules still dispatch while orgs are absent", async () => {
    await pool.query(
      `UPDATE eval_schedules SET is_enabled = true, next_run_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
      [soloScheduleId],
    );
    await processScheduledJobs();
    const jobs = await pool.query(`SELECT id FROM eval_jobs WHERE schedule_id = $1`, [soloScheduleId]);
    expect(jobs.rows.length).toBe(1);
    const sched = await storage.getEvalSchedule(soloScheduleId);
    expect(sched?.isEnabled).toBe(true);
    expect(sched!.nextRunAt!.getTime()).toBeGreaterThan(Date.now()); // advanced, not disabled
    await pool.query(`UPDATE eval_schedules SET is_enabled = false WHERE id = $1`, [soloScheduleId]);
  });

  it("running a PUBLIC org-owned workflow with the provider absent is 501 and writes no job", async () => {
    const before = await snapshot();
    const res = await request(app)
      .post(`/api/v1/workflows/${orgWorkflowId}/run`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ evalSetId: orgEvalSetId, region: "na-us-ashburn", targetTier: "private" });
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: "Organizations feature not enabled" });
    expect((await snapshot()).jobCount).toBe(before.jobCount);
  });
});
