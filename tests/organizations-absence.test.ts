import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { createServer } from "http";
import { setOrganizations, resetOrganizations, type OrganizationsProvider } from "../server/organizations";
import { membershipFor, authenticateApiKey } from "../server/auth";
import { storage, pool, encryptValue, hashToken } from "../server/storage";
import { processScheduledJobs, runMaintenanceTasks } from "../server/scheduler";
import { registerRoutes, scheduleDispatchBlocked } from "../server/routes";
// The PLUGIN's own error class — deliberately imported from the plugin, not from
// Core, so the cross-boundary case at the bottom of this file throws the exact
// object the shipped provider throws.
import { AlreadyMemberError as PluginAlreadyMemberError } from "../plugins/organizations/server/types";

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

  // dispatchBlocked is computed per-request on the schedules listing map, never
  // persisted — this exercises the mapping helper directly (server/routes.ts).
  it("scheduleDispatchBlocked flags an org-owned schedule row when the provider is ABSENT", () => {
    const blocked = scheduleDispatchBlocked(42);
    expect(blocked).toEqual({ reason: "organizations-unavailable", detail: "Organization plugin/feature not enabled" });
  });

  it("scheduleDispatchBlocked is null for a personal (org-less) schedule row even when the provider is ABSENT", () => {
    expect(scheduleDispatchBlocked(null)).toBeNull();
  });

  it("scheduleDispatchBlocked is null for an org-owned schedule row once a provider is installed", () => {
    // PRESENCE is the whole test — the helper only asks whether a provider is
    // installed, so the `failing` one above is a legitimate (and sharper)
    // stand-in for "installed": the flag clears without any method being called.
    setOrganizations(failing);
    expect(scheduleDispatchBlocked(42)).toBeNull();
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

// Captured before anything can swap it, so the restore assertion compares
// against the genuine platform implementation.
const realSetIntervalRef = globalThis.setInterval;

// A evalflow whose platform.setup references two login-class (brokered) org
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
  let orgEvalflowId: number, orgEvalSetId: number, orgScheduleId: number;
  let teamJobId: number, sitedTeamJobId: number;
  let soloScheduleId: number;
  // The shape between the two above: a PERSONAL evalflow dispatched to the TEAM
  // tier. Legal to create (POST /api/eval-schedules gates team on hasOrg(user),
  // not on who owns the evalflow), and the one whose claimability depends on the
  // seam even though `evalflow.organizationId` is null.
  let personalEvalflowId: number, personalEvalSetId: number, teamPersonalScheduleId: number;
  // A PERSONAL schedule ROW pointing at the ORG-owned evalflow. run-now's org
  // arm is only reachable on this shape: when the schedule row is itself
  // org-owned, canEditResource's org-manager arm cannot answer under absence
  // (membership is null) and the route 403s before any org guard runs — safe,
  // but it proves nothing about the 501.
  let orgWfPersonalScheduleId: number;
  let apiKey: string;
  let app: express.Express;
  let mountTimers = 0; // setInterval calls intercepted while mounting registerRoutes

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

  // Re-arm both org-DEPENDENT schedules — the org-owned evalflow and the
  // personal evalflow on the team tier — so every test starts from "enabled and
  // due". Both must be skipped while the provider is unavailable; the tick is
  // free to process anything else.
  async function armOrgDependentSchedules() {
    await pool.query(
      `UPDATE eval_schedules SET is_enabled = true, next_run_at = NOW() - INTERVAL '1 minute',
         last_run_at = NULL, run_count = 0 WHERE id = ANY($1::int[])`,
      [[orgScheduleId, teamPersonalScheduleId]],
    );
  }

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const providerId = (await storage.getAllProviders())[0]!.id;

    const org = await storage.createOrganization({ name: `abs-org-${suffix}` } as any);
    orgId = org.id;
    // No membership is seeded for the creator: this suite's entire subject is a
    // provider that cannot answer, so membership is deliberately unresolvable —
    // every guard under test keys on the RESOURCE's organizationId (Core FK
    // columns, set below). Seeding the frozen users.organization_id column here
    // would carry no meaning post-flip.
    creatorId = (await storage.createUser({
      username: `absc${suffix}`, email: `absc${suffix}@example.com`, plan: "premium",
    } as any)).id;
    soloId = (await storage.createUser({
      username: `abss${suffix}`, email: `abss${suffix}@example.com`, plan: "premium",
    } as any)).id;

    // Login-class org secrets, so the org evalflow genuinely needs a Core mint.
    const emailSecret = `ABS_LOGIN_EMAIL_${suffix.replace(/-/g, "_")}`;
    const passwordSecret = `ABS_LOGIN_PASSWORD_${suffix.replace(/-/g, "_")}`;
    for (const name of [emailSecret, passwordSecret]) {
      // Seeded through the ciphertext-only writer the seam uses. (Was
      // storage.upsertOrgSecret, whose only remaining caller this was; that
      // plaintext-opts writer is deleted. `isTestAccount: false` is explicit
      // here where the old call let the column default — same stored row.)
      await storage.upsertOrgSecretRow(orgId, {
        name, encryptedValue: encryptValue("x"), brokerType: "auth-session",
        isTestAccount: false, createdBy: creatorId,
      });
    }

    const orgEvalflow = await storage.createEvalflow({
      name: `abs-wf-${suffix}`, ownerId: creatorId, organizationId: orgId, providerId,
      visibility: "public", // public + org-owned: the run-route arm's exact shape
      config: { stepsPrefix: LOGIN_STEPS(emailSecret, passwordSecret) },
    } as any);
    orgEvalflowId = orgEvalflow.id;
    orgEvalSetId = (await storage.createEvalSet({
      name: `abs-es-${suffix}`, ownerId: creatorId, organizationId: orgId, visibility: "public", config: {},
    } as any)).id;

    orgScheduleId = (await storage.createEvalSchedule({
      name: `abs-sched-${suffix}`, evalflowId: orgEvalflowId, evalSetId: orgEvalSetId,
      region: "na-us-ashburn", targetTier: "team", scheduleType: "recurring",
      cronExpression: "*/5 * * * *", isEnabled: true,
      nextRunAt: new Date(Date.now() - 60 * 1000), createdBy: creatorId, organizationId: orgId,
    } as any)).id;

    // One pending TEAM job per sweep, so BOTH exclusions are mutation-covered:
    //  - pooled (site_id NULL, target_region set) → failExpiredPendingJobs' 24h backstop
    //  - sited (site_id set, target_region NULL, no online agent for that site)
    //    → failPendingJobsWithNoAgent' 15min fast-fail
    // Both backdated 30h so both sweeps would fire if their predicate were dropped.
    const mkPendingTeamJob = (siteId: string | null, targetRegion: string | null) =>
      storage.createEvalJob({
        evalflowId: orgEvalflowId, evalSetId: orgEvalSetId, triggerType: 2, createdBy: creatorId,
        creatorOrgId: orgId, siteId, targetRegion, targetTier: "team",
        config: {}, snapshot: { provider: null, evalflow: null, evalSet: null, creatorPlan: null } as any,
        status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
      } as any);
    teamJobId = (await mkPendingTeamJob(null, "na-us-ashburn")).id;
    // A site no agent has ever registered for — the no-agent sweep's NOT EXISTS holds.
    sitedTeamJobId = (await mkPendingTeamJob(`na-us-absent-${suffix.slice(-6)}-01`, null)).id;
    await pool.query(
      `UPDATE eval_jobs SET created_at = NOW() - INTERVAL '30 hours', updated_at = NOW() - INTERVAL '30 hours'
         WHERE id = ANY($1::int[])`,
      [[teamJobId, sitedTeamJobId]],
    );

    // Personal schedule row on the ORG evalflow — run-now's org-arm fixture.
    // PRIVATE tier deliberately, so only the evalflow-ownership arm of the guard
    // can be what refuses it. Left disabled: the tick must never see it (it is a
    // route fixture, and getDueSchedules filters on is_enabled).
    orgWfPersonalScheduleId = (await storage.createEvalSchedule({
      name: `abs-orgwf-personal-sched-${suffix}`, evalflowId: orgEvalflowId, evalSetId: orgEvalSetId,
      region: "na-us-ashburn", targetTier: "private", scheduleType: "recurring",
      cronExpression: "*/5 * * * *", isEnabled: false,
      nextRunAt: new Date(Date.now() - 60 * 1000), createdBy: creatorId,
    } as any)).id;

    // Personal evalflow owned by the ORG MEMBER, scheduled onto the TEAM tier.
    // `organizationId` is null, so every guard that keys on evalflow ownership
    // waves it through — but the job it creates is team-tier, and a team-tier
    // job stamped creator_org_id NULL (which is what membership-by-absence
    // yields) can never be claimed by the team arm, now or after the provider
    // returns. No login secrets: this must fail on the tier, nothing else.
    personalEvalflowId = (await storage.createEvalflow({
      name: `abs-team-personal-wf-${suffix}`, ownerId: creatorId, providerId,
      visibility: "private", config: {},
    } as any)).id;
    personalEvalSetId = (await storage.createEvalSet({
      name: `abs-team-personal-es-${suffix}`, ownerId: creatorId, visibility: "private", config: {},
    } as any)).id;
    teamPersonalScheduleId = (await storage.createEvalSchedule({
      name: `abs-team-personal-sched-${suffix}`, evalflowId: personalEvalflowId, evalSetId: personalEvalSetId,
      region: "na-us-ashburn", targetTier: "team", scheduleType: "recurring",
      cronExpression: "*/5 * * * *", isEnabled: true,
      nextRunAt: new Date(Date.now() - 60 * 1000), createdBy: creatorId,
    } as any)).id;

    // Personal control: no org anywhere on the path, no session need.
    const soloEvalflowId = (await storage.createEvalflow({
      name: `abs-solo-wf-${suffix}`, ownerId: soloId, providerId, visibility: "private", config: {},
    } as any)).id;
    const soloEvalSetId = (await storage.createEvalSet({
      name: `abs-solo-es-${suffix}`, ownerId: soloId, visibility: "private", config: {},
    } as any)).id;
    soloScheduleId = (await storage.createEvalSchedule({
      name: `abs-solo-sched-${suffix}`, evalflowId: soloEvalflowId, evalSetId: soloEvalSetId,
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
    //
    // registerRoutes also installs two DB-writing timers that it never clears
    // (the clash match scheduler, 10s, and the clash schedule cron, 60s). In a
    // test process those would race the real dev server's copies against the
    // shared dev DB the moment this file ran longer than 10s. Neuter them at
    // the source: setInterval is stubbed for the duration of the mount only, so
    // no live handle is ever created, and restored immediately afterwards.
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((..._args: unknown[]) => {
      mountTimers++;
      return { unref: () => undefined, ref: () => undefined } as unknown as NodeJS.Timeout;
    }) as unknown as typeof globalThis.setInterval;
    try {
      app = express();
      app.use(express.json());
      app.use(authenticateApiKey);
      // Session shim. requireAuth and getCurrentUser read exactly one thing —
      // `req.session.userId` (server/auth.ts) — so a header-driven stub is
      // enough to reach the session-auth routes' absence arms in-process. No
      // store and no cookies: none of the routes under test write to the
      // session, and every authorization decision still runs for real.
      app.use((req, _res, next) => {
        const uid = req.header("x-test-user");
        if (uid) (req as unknown as { session: { userId: number } }).session = { userId: Number(uid) };
        next();
      });
      await registerRoutes(createServer(app), app);
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });

  beforeEach(async () => {
    resetOrganizations();
    await armOrgDependentSchedules();
  });

  // Leave the holder in the same state the file found it: EMPTY. After the
  // Release A flip there is no built-in provider to "restore" — the real one is
  // installed by the plugin at startup (server/index.ts), which never runs
  // in-process here, so absence is this file's honest baseline.
  afterAll(() => resetOrganizations());

  it("scheduler + maintenance ticks with provider ABSENT change nothing", async () => {
    const before = await snapshot();
    await processScheduledJobs();
    await runMaintenanceTasks();
    expect(await snapshot()).toEqual(before); // ZERO rows changed — design §7, both workers
  });

  it("a FAILING provider takes the same path — skip, never disable", async () => {
    setOrganizations(failing);
    const before = await snapshot();
    // Zero writes alone does not discriminate here: before the guard existed a
    // throw simply escaped into the per-schedule catch, which also wrote
    // nothing. Assert the schedule was *deliberately* skipped and counted —
    // that only happens on the guard's path (failure == absence, §4).
    const skipLines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      skipLines.push(args.map(String).join(" "));
    });
    try {
      await processScheduledJobs();
    } finally {
      spy.mockRestore();
    }
    expect(skipLines.some((l) => /org schedule\(s\) skipped — organizations unavailable/.test(l))).toBe(true);
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

  // The shape between the org schedule and the personal control: the evalflow is
  // personal (every ownership-keyed guard waves it through) but the TIER is team.
  // Dispatching it under absence would stamp creator_org_id NULL — a job the team
  // claim arm can never match, one per firing, surviving re-enable. The tick must
  // skip it exactly like an org-owned one.
  it("a TEAM-TIER schedule on a PERSONAL evalflow is skipped too — no NULL-org job is ever stamped", async () => {
    const before = await snapshot();
    await processScheduledJobs();
    const jobs = await pool.query(`SELECT id FROM eval_jobs WHERE schedule_id = $1`, [teamPersonalScheduleId]);
    expect(jobs.rows.length).toBe(0); // no doomed job
    const sched = await storage.getEvalSchedule(teamPersonalScheduleId);
    expect(sched?.isEnabled).toBe(true); // skipped, never disabled — it must resume by itself
    expect(await snapshot()).toEqual(before); // and next_run/run_count untouched
  });

  it("run-now on a team-tier PERSONAL-evalflow schedule is 501 and writes no job", async () => {
    const before = await snapshot();
    const res = await request(app)
      .post(`/api/eval-schedules/${teamPersonalScheduleId}/run-now`)
      .set("x-test-user", String(creatorId))
      .send({});
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: "Organizations feature not enabled" });
    expect((await snapshot()).jobCount).toBe(before.jobCount);
  });

  it("run-now on an ORG-evalflow schedule is 501 and writes no job", async () => {
    const before = await snapshot();
    const res = await request(app)
      .post(`/api/eval-schedules/${orgWfPersonalScheduleId}/run-now`)
      .set("x-test-user", String(creatorId))
      .send({});
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: "Organizations feature not enabled" });
    expect((await snapshot()).jobCount).toBe(before.jobCount);
  });

  it("console run of a PUBLIC org-owned evalflow is 501 and writes no job", async () => {
    const before = await snapshot();
    const res = await request(app)
      .post(`/api/evalflows/${orgEvalflowId}/run`)
      .set("x-test-user", String(creatorId))
      .send({ evalSetId: orgEvalSetId, region: "na-us-ashburn", targetTier: "private" });
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: "Organizations feature not enabled" });
    expect((await snapshot()).jobCount).toBe(before.jobCount);
  });

  it("console run of a PERSONAL evalflow onto the TEAM tier is 501 and writes no job", async () => {
    const before = await snapshot();
    const res = await request(app)
      .post(`/api/evalflows/${personalEvalflowId}/run`)
      .set("x-test-user", String(creatorId))
      .send({ evalSetId: personalEvalSetId, region: "na-us-ashburn", targetTier: "team" });
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: "Organizations feature not enabled" });
    expect((await snapshot()).jobCount).toBe(before.jobCount);
  });

  it("running a PUBLIC org-owned evalflow with the provider absent is 501 and writes no job", async () => {
    const before = await snapshot();
    const res = await request(app)
      .post(`/api/v1/evalflows/${orgEvalflowId}/run`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ evalSetId: orgEvalSetId, region: "na-us-ashburn", targetTier: "private" });
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: "Organizations feature not enabled" });
    expect((await snapshot()).jobCount).toBe(before.jobCount);
  });

  it("v1 run of a PERSONAL evalflow onto the TEAM tier is 501 and writes no job", async () => {
    const before = await snapshot();
    const res = await request(app)
      .post(`/api/v1/evalflows/${personalEvalflowId}/run`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ evalSetId: personalEvalSetId, region: "na-us-ashburn", targetTier: "team" });
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: "Organizations feature not enabled" });
    expect((await snapshot()).jobCount).toBe(before.jobCount);
  });

  // --- cross-boundary error identity (I1) ----------------------------------
  //
  // Not an absence case, but it needs exactly this file's machinery: a Core
  // ADAPTER exercised in-process against an INSTALLED provider that throws the
  // PLUGIN's own AlreadyMemberError class. Nothing else in the tree does that —
  // the plugin suites prove plugin-throws-plugin-class, Phase 1 proved
  // Core-catches-Core-class, and `instanceof` is false across the boundary
  // (distinct class objects), so the route's 400 arm was dead code against the
  // shipped provider until the name-based predicate replaced it.
  it("a PLUGIN-thrown AlreadyMemberError still maps to the route's 400, not a 500", async () => {
    setOrganizations({
      ...failing,
      // The race the 400 exists for: membership is absent at the auth boundary
      // (so the route's own pre-check waves the caller through) and appears
      // before the provider's precheck runs.
      getMembership: async () => null,
      getMemberships: async () => new Map(),
      createOrganization: async () => {
        throw new PluginAlreadyMemberError(`user ${soloId} already belongs to organization 2`);
      },
    });
    const before = await snapshot();
    const res = await request(app)
      .post("/api/organizations")
      .set("x-test-user", String(soloId))
      .send({ name: `xboundary-org-${Date.now()}` });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Already a member of an organization" });
    expect(await snapshot()).toEqual(before); // the seat write is downstream of the throw
  });

  it("mounting the API in-process leaves no live timer behind", () => {
    // registerRoutes installs DB-writing intervals it never clears (clash match
    // scheduler + schedule cron). They were intercepted during the mount, so no
    // real handle exists in this process and nothing can fire mid-suite.
    expect(mountTimers).toBeGreaterThanOrEqual(2);
    expect(globalThis.setInterval).toBe(realSetIntervalRef); // stub restored
  });
});
