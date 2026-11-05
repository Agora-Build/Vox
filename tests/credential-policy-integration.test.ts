import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
await vi.hoisted(async () => {
  if (process.env.DATABASE_URL) {
    const { prepareIsolatedCoreDb } = await import("./helpers/isolated-core-db");
    process.env.DATABASE_URL = await prepareIsolatedCoreDb(process.env.DATABASE_URL, `vox_test_credential_policy_${process.pid}`);
    process.env.CREDENTIAL_ENCRYPTION_KEY = "ab".repeat(32);
  }
});
vi.mock("../server/auth-session", async (original) => ({
  ...await original<typeof import("../server/auth-session")>(), ensureSession: vi.fn().mockResolvedValue(undefined),
}));
import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { storage, pool, buildJobSnapshot, encryptValue, hashToken } from "../server/storage";
import { registerRoutes } from "../server/routes";
import { createCredentialTrialJob, credentialScopeKey, getCredentialTrialAllowance, jobMayUseCredentials, setCredentialTrialPolicy } from "../server/credential-trials";
import { resetOrganizations, setOrganizations, type Membership, type OrganizationsProvider, type OrgSecretRow } from "../server/organizations";
import { setMarketplace, type EvalMarketplace } from "../server/marketplace";
import { ownedCredentialPoolViolation } from "../server/auth-session";
import { processScheduledJobs } from "../server/scheduler";
import { isClaimable } from "../server/permissions";
import type { EvalFlow, EvalSet, InsertEvalJob, EvalJob } from "../shared/schema";

const d = process.env.DATABASE_URL ? describe : describe.skip;
d("credential policy: isolated PostgreSQL and HTTP contracts", () => {
  const app = express();
  const memberships = new Map<number, Membership>();
  const orgSecrets = new Map<number, OrgSecretRow[]>();
  const deleteOrgSecret = vi.fn(async (id: number, name: string) => {
    orgSecrets.set(id, (orgSecrets.get(id) ?? []).filter((s) => s.name !== name));
  });
  const orgs = {
    getMembership: async (id: number) => memberships.get(id) ?? null,
    getMemberships: async () => memberships,
    listOrgSecrets: async (id: number) => orgSecrets.get(id) ?? [], deleteOrgSecret,
  } as unknown as OrganizationsProvider;
  const authorizeDispatch = vi.fn(async () => ({ ok: true }));
  let flow: EvalFlow, set: EvalSet, providerId: string, region: string, tokenId: number, sharedId: number, agentId: number;
  const auth = (r: request.Test, id = 2) => r.set("x-test-user", String(id));
  const scope = () => credentialScopeKey(flow);
  const values = (callerId = 2): InsertEvalJob => ({
    evalFlowId: flow.id, evalSetId: set.id, createdBy: callerId, triggerType: 2, targetTier: "public", targetRegion: region,
    config: flow.config, snapshot: buildJobSnapshot(flow, set, null, "premium"), status: "pending",
  });
  const run = (body: Record<string, unknown> = {}, id = 2) => auth(request(app).post(`/api/eval-flows/${flow.id}/run`), id)
    .send({ evalSetId: set.id, region, targetTier: "public", requestId: randomUUID(), ...body });
  const enable = (budget = 100) => setCredentialTrialPolicy(scope(), { enabled: true, maxRuns30Days: budget });
  const count = async () => (await pool.query("SELECT count(*)::int AS n FROM credential_trial_usage")).rows[0].n;
  const identity = () => ({ id: tokenId, siteId: `${region}-01`, region, dispatchTier: "public", createdBy: 1, ownerOrgId: null, locationTrust: "trusted" });
  const claim = async (job: EvalJob) => (await storage.claimEvalJob(job.id, agentId, identity()))!;
  beforeAll(async () => {
    await pool.query("INSERT INTO users(id,username,email,plan,is_enabled,is_admin) VALUES(1,'credential-owner','owner@test.local','principal',true,false),(2,'credential-caller','caller@test.local','premium',true,false),(3,'credential-admin','admin@test.local','premium',true,true),(4,'credential-other','other@test.local','premium',true,false)");
    providerId = (await storage.createProvider({ name: "credential policy test", sku: "convoai" })).id;
    region = (await storage.getAllRegionLocations())[0].baseId;
    tokenId = (await storage.createEvalAgentToken({ name: "Mainline", tokenHash: hashToken("credential-test-agent"), createdBy: 1, dispatchTier: "public", siteId: `${region}-01` })).id;
    sharedId = (await storage.createEvalAgentToken({ name: "Shared", tokenHash: "credential-shared", createdBy: 3, dispatchTier: "shared", siteId: `${region}-02` })).id;
    agentId = (await storage.createEvalAgent({ name: "credential-test", tokenId, state: "idle", currentLeaseId: "credential-lease" })).id;
    await storage.createOrUpdateSecret(1, "RUN_KEY", encryptValue("owner-runtime-value"));
    await storage.createOrUpdateSecret(1, "LOGIN_EMAIL", encryptValue("owner@example.com"), { brokerType: "auth-session", isTestAccount: false });
    await storage.createOrUpdateSecret(1, "LOGIN_PASSWORD", encryptValue("test-password-only"), { brokerType: "auth-session", isTestAccount: false });
    app.use(express.json());
    app.use((req, _res, next) => { const id = req.header("x-test-user"); if (id) (req as unknown as { session: { userId: number } }).session = { userId: Number(id) }; next(); });
    const timers = vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref() {} } as NodeJS.Timeout);
    try { await registerRoutes(createServer(app), app); } finally { timers.mockRestore(); }
  });
  beforeEach(async () => {
    resetOrganizations(); setMarketplace(null); memberships.clear(); orgSecrets.clear(); deleteOrgSecret.mockClear(); authorizeDispatch.mockClear();
    await pool.query("DELETE FROM credential_trial_usage; DELETE FROM credential_trial_policies");
    flow = await storage.createEvalFlow({ name: "Credential flow", ownerId: 1, providerId, visibility: "public", config: { stepsPrefix: "- type: log\n  text: ${secrets.RUN_KEY}\n" } });
    set = await storage.createEvalSet({ name: "Owner set", ownerId: 1, visibility: "public", config: {} });
  });
  afterAll(async () => { resetOrganizations(); setMarketplace(null); await pool.end(); });

  it("requires opt-in; rejected admission creates neither a job nor usage", async () => {
    const before = (await pool.query("SELECT count(*)::int AS n FROM eval_jobs")).rows[0].n;
    await expect(createCredentialTrialJob(values())).rejects.toMatchObject({ status: 429 });
    await run().expect(429);
    expect(await count()).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM eval_jobs")).rows[0].n).toBe(before);
  });
  it("serializes simultaneous admissions and counts once per admitted job", async () => {
    await enable();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => createCredentialTrialJob(values())));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(await count()).toBe(5);
    expect(await getCredentialTrialAllowance(flow, 2)).toMatchObject({ available: false, remaining24Hours: 0, remaining30Days: 75 });
  });
  it("shares the owner's budget across callers and flows", async () => {
    await enable(2);
    const jobs = await Promise.allSettled([2, 3, 4, 2, 3, 4].map((id) => createCredentialTrialJob(values(id))));
    expect(jobs.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const sameOwnerFlow = await storage.createEvalFlow({ ...flow, name: "Another flow", id: undefined } as never);
    await expect(createCredentialTrialJob({ ...values(), evalFlowId: sameOwnerFlow.id, snapshot: buildJobSnapshot(sameOwnerFlow, set, null, "premium") })).rejects.toMatchObject({ status: 429 });
  });
  it("defaults flows to 5/80 and permits owner custom limits at creation and publication", async () => {
    expect(flow).toMatchObject({ trialLimit24Hours: 5, trialLimit30Days: 80 });
    const created = await auth(request(app).post("/api/eval-flows"), 1).send({ name: "Custom public trial", providerId, trialLimit24Hours: 7, trialLimit30Days: 90 }).expect(200);
    expect(created.body).toMatchObject({ trialLimit24Hours: 7, trialLimit30Days: 90 });
    await storage.updateEvalFlow(flow.id, { visibility: "private" });
    const published = await auth(request(app).patch(`/api/eval-flows/${flow.id}`), 1).send({ visibility: "public", trialLimit24Hours: 2, trialLimit30Days: 9 }).expect(200);
    expect(published.body).toMatchObject({ visibility: "public", trialLimit24Hours: 2, trialLimit30Days: 9 });
  });
  it.each([-1, 1.2, 10001, "5", null])("rejects invalid flow trial limits before create/update: %s", async (limit) => {
    await auth(request(app).post("/api/eval-flows"), 1).send({ name: "Invalid trial", providerId, trialLimit24Hours: limit }).expect(400);
    await auth(request(app).patch(`/api/eval-flows/${flow.id}`), 1).send({ trialLimit30Days: limit }).expect(400);
    expect((await storage.getEvalFlow(flow.id))?.trialLimit30Days).toBe(80);
  });
  it("only credential owners or same-org secret managers may change trial limits", async () => {
    for (const id of [2, 3]) await auth(request(app).patch(`/api/eval-flows/${flow.id}`), id).send({ trialLimit24Hours: 100 }).expect(403);
    setOrganizations(orgs);
    memberships.set(1, { organizationId: 10, role: "member" });
    memberships.set(2, { organizationId: 10, role: "admin" });
    flow = (await storage.updateEvalFlow(flow.id, { organizationId: 10 }))!;
    await auth(request(app).patch(`/api/eval-flows/${flow.id}`), 1).send({ trialLimit24Hours: 10 }).expect(403);
    await auth(request(app).post("/api/eval-flows"), 1).send({ name: "Org trial", providerId, organizationId: 10, trialLimit24Hours: 10 }).expect(403);
    await auth(request(app).patch(`/api/eval-flows/${flow.id}`), 2).send({ trialLimit24Hours: 10 }).expect(200);
    await auth(request(app).put(`/api/v1/eval-flows/${flow.id}`), 1).send({ trialLimit24Hours: 20 }).expect(403);
  });
  it("counts each flow independently and applies edited live limits without resetting usage", async () => {
    await enable();
    const other = await storage.createEvalFlow({ ...flow, id: undefined, name: "Independent trial flow" } as never);
    await createCredentialTrialJob(values());
    await storage.updateEvalFlow(flow.id, { trialLimit24Hours: 1 });
    await expect(createCredentialTrialJob(values())).rejects.toMatchObject({ status: 429 });
    await createCredentialTrialJob({ ...values(), evalFlowId: other.id, snapshot: buildJobSnapshot(other, set, null, "premium") });
    expect(await getCredentialTrialAllowance(other, 2)).toMatchObject({ remaining24Hours: 4 });
    flow = (await storage.updateEvalFlow(flow.id, { trialLimit24Hours: 3, trialLimit30Days: 4 }))!;
    const targets = await auth(request(app).get(`/api/eval-flows/${flow.id}/run-targets?evalSetId=${set.id}`)).expect(200);
    expect(targets.body.trial).toMatchObject({ trialLimit24Hours: 3, trialLimit30Days: 4, remaining24Hours: 2, remaining30Days: 3 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => createCredentialTrialJob(values())));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  });
  it("zero disables a flow and ownership transfers do not reset the caller's flow usage", async () => {
    await enable();
    await createCredentialTrialJob(values());
    flow = (await storage.updateEvalFlow(flow.id, { ownerId: 3, trialLimit24Hours: 1 }))!;
    await enable();
    await expect(createCredentialTrialJob(values())).rejects.toMatchObject({ status: 429 });
    flow = (await storage.updateEvalFlow(flow.id, { trialLimit24Hours: 0 }))!;
    await expect(createCredentialTrialJob(values(4))).rejects.toMatchObject({ status: 429 });
    expect(await count()).toBe(1);
  });
  it("flow deletion preserves aggregate owner charges", async () => {
    await enable(1);
    await createCredentialTrialJob(values());
    const other = await storage.createEvalFlow({ ...flow, id: undefined, name: "Budget after deletion" } as never);
    await storage.deleteEvalFlow(flow.id);
    expect((await pool.query("SELECT eval_flow_id FROM credential_trial_usage")).rows[0].eval_flow_id).toBeNull();
    await expect(createCredentialTrialJob({ ...values(), evalFlowId: other.id, snapshot: buildJobSnapshot(other, set, null, "premium") })).rejects.toMatchObject({ status: 429 });
  });
  it("enforces 80 per rolling 30 days independently of the daily limit", async () => {
    await enable();
    await pool.query("INSERT INTO credential_trial_usage(scope_key,eval_flow_id,caller_id,request_key,created_at) SELECT $1,$2,2,'seed-'||n,now()-interval '2 days' FROM generate_series(1,80) AS n", [scope(), flow.id]);
    await expect(createCredentialTrialJob(values())).rejects.toMatchObject({ status: 429 });
    expect(await getCredentialTrialAllowance(flow, 2)).toMatchObject({ remaining24Hours: 5, remaining30Days: 0 });
    await pool.query("UPDATE credential_trial_usage SET created_at=now()-interval '31 days'");
    expect(await createCredentialTrialJob(values())).toHaveProperty("id");
  });
  it("does not refund failed/canceled or deleted jobs", async () => {
    await enable();
    const job = await createCredentialTrialJob(values());
    await pool.query("UPDATE eval_jobs SET status='failed' WHERE id=$1", [job.id]);
    await pool.query("DELETE FROM eval_jobs WHERE id=$1", [job.id]);
    expect(await count()).toBe(1);
    expect(await getCredentialTrialAllowance(flow, 2)).toMatchObject({ remaining24Hours: 4 });
  });
  it("recovers lost responses idempotently, even at the allowance limit", async () => {
    await enable(1);
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => createCredentialTrialJob(values(), key)));
    expect(new Set(results.map((j) => j.id)).size).toBe(1);
    expect(await count()).toBe(1);
    const replay = await run({ requestId: key }).expect(200);
    expect(replay.body.job.id).toBe(results[0].id);
  });
  it("normalizes numeric-string eval-set IDs before concurrent trial replay", async () => {
    await enable(1);
    const key = randomUUID();
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`credential-trials:${scope()}`]);
    const pending = [String(set.id), String(set.id), set.id].map((evalSetId) =>
      run({ requestId: key, evalSetId }).then((response) => response));
    try {
      // Force every HTTP request past the early lookup and into locked admission.
      await vi.waitFor(async () => {
        const waiting = await pool.query("SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND l.locktype='advisory' AND NOT l.granted");
        expect(waiting.rows[0].n).toBeGreaterThanOrEqual(pending.length);
      }, { timeout: 5000 });
    } finally {
      await blocker.query("COMMIT");
      blocker.release();
    }
    const responses = await Promise.all(pending);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(new Set(responses.map((response) => response.body.job.id)).size).toBe(1);
    expect(responses[0].body.job.evalSetId).toBe(set.id);
    expect(await count()).toBe(1);
    await run({ requestId: key, evalSetId: String(set.id) }).expect(200);
  });
  it.each([undefined, null, true, [], {}, 0, -1, 1.5, "not-id", "12.5", 2147483648])("rejects invalid eval-set IDs before replay or admission: %j", async (evalSetId) => {
    await enable();
    const key = randomUUID();
    await run({ requestId: key }).expect(200);
    const response = await run({ requestId: key, evalSetId }).expect(400);
    expect(response.body.error).toMatch(/Eval set required|Invalid eval set id/);
    expect(await count()).toBe(1);
  });
  it("rejects malformed flow IDs before the replay and lookup paths can disagree", async () => {
    await enable();
    const key = randomUUID();
    await run({ requestId: key }).expect(200);
    for (const id of [`${flow.id}suffix`, "0", "-1", "1.5", "1e3", "2147483648"]) {
      await auth(request(app).post(`/api/eval-flows/${id}/run`)).send({
        evalSetId: set.id, region, targetTier: "public", requestId: key,
      }).expect(400);
    }
    expect(await count()).toBe(1);
  });
  it("keeps a submission idempotent across an ownership transfer and rejects reusing it for a different flow", async () => {
    await enable();
    const key = randomUUID();
    const original = await createCredentialTrialJob(values(), key);
    flow = (await storage.updateEvalFlow(flow.id, { ownerId: 3 }))!;
    await enable();
    const replay = await run({ requestId: key }).expect(200);
    expect(replay.body.job.id).toBe(original.id);
    expect(replay.body.job.snapshot.credentialTrial.scopeKey).toBe("user:1");
    expect(await count()).toBe(1);
    const other = await storage.createEvalFlow({ ...flow, id: undefined, name: "Other owner flow" } as never);
    await expect(createCredentialTrialJob({ ...values(), evalFlowId: other.id, snapshot: buildJobSnapshot(other, set, null, "premium") }, key)).rejects.toMatchObject({ status: 409 });
    expect(await count()).toBe(1);
  });
  it("rechecks flow visibility/ownership after taking the scope lock", async () => {
    await enable();
    await storage.updateEvalFlow(flow.id, { visibility: "private" });
    await expect(createCredentialTrialJob(values())).rejects.toMatchObject({ status: 409 });
    expect(await count()).toBe(0);
  });
  it("web trials use an immutable, durable credential scope, not caller-supplied overrides", async () => {
    await enable();
    const response = await run({ config: { stepsPrefix: "evil" }, snapshot: { credentialTrial: { scopeKey: "user:3", callerId: 3 } } }).expect(200);
    expect(response.body.job.config.stepsPrefix).toBe(flow.config && (flow.config as Record<string, unknown>).stepsPrefix);
    expect(response.body.job.snapshot.credentialTrial).toEqual({ scopeKey: scope(), callerId: 2 });
    const job = await claim(await storage.getEvalJob(response.body.job.id) as EvalJob);
    await storage.updateEvalFlow(flow.id, { ownerId: 3 });
    const secrets = await request(app).get(`/api/eval-agent/jobs/${job.id}/secrets?leaseId=credential-lease`).set("Authorization", "Bearer credential-test-agent").expect(200);
    expect(secrets.body).toEqual({ RUN_KEY: "owner-runtime-value" });
  });
  it("will not spend another owner's credentials for an unstamped/forged run", async () => {
    const job = await storage.createEvalJob({ ...values(), snapshot: { ...buildJobSnapshot(flow, set, null, "premium"), credentialTrial: { scopeKey: scope(), callerId: 2 } } });
    expect(await jobMayUseCredentials(job)).toBe(false);
    await claim(job);
    await request(app).get(`/api/eval-agent/jobs/${job.id}/secrets?leaseId=credential-lease`).set("Authorization", "Bearer credential-test-agent").expect(403);
  });
  it("refuses API-key/bearer trials, non-Mainline targets, and caller-controlled eval sets", async () => {
    await enable();
    await run().set("Authorization", "Bearer vox_live_test").expect(403);
    await run({ targetTier: "private" }).expect(403);
    const callerSet = await storage.createEvalSet({ name: "Untrusted", ownerId: 2, visibility: "public", config: {} });
    await run({ evalSetId: callerSet.id }).expect(403);
    expect(await count()).toBe(0);
  });
  it("does not charge owners a borrowed-trial allowance", async () => {
    await run({}, 1).expect(200);
    expect(await count()).toBe(0);
  });
  it("allows secret-free public runs without trial opt-in", async () => {
    flow = (await storage.updateEvalFlow(flow.id, { config: {} }))!;
    const result = await run().expect(200);
    const job = await claim(await storage.getEvalJob(result.body.job.id) as EvalJob);
    await request(app).get(`/api/eval-agent/jobs/${job.id}/secrets?leaseId=credential-lease`).set("Authorization", "Bearer credential-test-agent").expect(200, {});
    expect(await count()).toBe(0);
  });
  it("keeps Mainline token creation and promotion admin-only", async () => {
    await auth(request(app).post("/api/eval-agent-tokens"), 1).send({ name: "Untrusted Mainline", dispatchTier: "public", regionLocationBaseId: region }).expect(403);
    const legacy = await storage.createEvalAgentToken({ name: "Configured private token", tokenHash: randomUUID(), createdBy: 1, dispatchTier: "private", siteId: `${region}-09`, region });
    await auth(request(app).patch(`/api/eval-agent-tokens/${legacy.id}`), 1).send({ dispatchTier: "public" }).expect(403);
    expect((await storage.getEvalAgentToken(legacy.id))?.dispatchTier).toBe("private");
    await auth(request(app).post("/api/eval-agent-tokens"), 3).send({ name: "Trusted Mainline", dispatchTier: "public", regionLocationBaseId: region }).expect(200);
    await auth(request(app).patch(`/api/eval-agent-tokens/${legacy.id}`), 3).send({ dispatchTier: "public" }).expect(200);
  });
  it.each(["private", "shared"] as const)("keeps pure, list and atomic %s claim gates consistent for a JSON-null session stamp", async (tier) => {
    const token = await storage.createEvalAgentToken({ name: "Malformed-stamp agent", tokenHash: randomUUID(), createdBy: 2, dispatchTier: tier, siteId: `${region}-08` });
    const agent = await storage.createEvalAgent({ name: "Malformed-stamp agent", tokenId: token.id, state: "idle" });
    const job = await storage.createEvalJob({
      ...values(),
      ...(tier === "shared" ? { targetTokenId: token.id, targetRegion: null, targetTier: null } : { targetTier: "private" }),
      snapshot: { ...buildJobSnapshot(flow, set, null, "premium"), requiresCredentials: false, sessionInjection: null } as never,
    });
    const target = { ...identity(), id: token.id, dispatchTier: tier, createdBy: 2 };
    expect(isClaimable(job, target)).toBe(false);
    expect((await storage.getClaimableJobsForToken(target)).some((j) => j.id === job.id)).toBe(false);
    expect(await storage.claimEvalJob(job.id, agent.id, target)).toBeUndefined();
  });
  it("blocks Runtime on Shared before any marketplace hold, even with the old consent flag", async () => {
    setMarketplace({ authorizeDispatch } as unknown as EvalMarketplace);
    const result = await auth(request(app).post(`/api/eval-flows/${flow.id}/run`), 1).send({ evalSetId: set.id, targetTokenId: sharedId, runtimeSecretConsent: true }).expect(400);
    expect(result.body.error).toMatch(/Shared agents require Brokered/);
    expect(authorizeDispatch).not.toHaveBeenCalled();
  });
  it("allows un-attested Brokered credentials on Mainline and on owner schedules", async () => {
    flow = (await storage.updateEvalFlow(flow.id, { config: { stepsPrefix: "- type: platform.setup\n  platform_id: agora\n  params:\n    email: ${secrets.LOGIN_EMAIL}\n    password: ${secrets.LOGIN_PASSWORD}\n" } }))!;
    const result = await run({}, 1).expect(200);
    expect(result.body.job.snapshot.sessionInjection).toMatchObject({ emailSecret: "LOGIN_EMAIL", passwordSecret: "LOGIN_PASSWORD" });
    expect(await ownedCredentialPoolViolation(flow, set, "public", { id: 1, organizationId: null })).toBeNull();
    const schedule = await auth(request(app).post("/api/eval-schedules"), 1).send({ name: "Owner Mainline", evalFlowId: flow.id, evalSetId: set.id, region, targetTier: "public", scheduleType: "once" }).expect(200);
    await processScheduledJobs();
    const jobs = (await pool.query("SELECT snapshot FROM eval_jobs WHERE schedule_id=$1", [schedule.body.id])).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].snapshot.sessionInjection).toBeDefined();
    expect(await count()).toBe(0);
  });
  it.each([
    { organization: false, tier: "team" as const },
    { organization: true, tier: "private" as const },
  ])("disables legacy credential schedules with mismatched $tier pools until the owner corrects them (org=$organization)", async ({ organization, tier }) => {
    setOrganizations(orgs);
    memberships.set(1, { organizationId: 10, role: "owner" });
    if (organization) {
      flow = (await storage.updateEvalFlow(flow.id, { organizationId: 10 }))!;
      set = (await storage.updateEvalSet(set.id, { organizationId: 10 }))!;
      orgSecrets.set(10, [{ name: "RUN_KEY", brokerType: null, encryptedValue: encryptValue("organization-runtime-value") } as OrgSecretRow]);
    }
    const response = await auth(request(app).post("/api/eval-schedules"), 1).send({
      name: "Legacy mismatched pool", evalFlowId: flow.id, evalSetId: set.id,
      region, targetTier: "public", scheduleType: "once",
    }).expect(200);
    // Simulate a pre-upgrade row without bypassing the new API admission gate.
    await storage.updateEvalSchedule(response.body.id, { targetTier: tier });
    await processScheduledJobs();
    expect((await storage.getEvalSchedule(response.body.id))?.isEnabled).toBe(false);
    expect((await pool.query("SELECT count(*)::int AS n FROM eval_jobs WHERE schedule_id=$1", [response.body.id])).rows[0].n).toBe(0);
    await auth(request(app).patch(`/api/eval-schedules/${response.body.id}`), 1).send({ isEnabled: true }).expect(403);
    await auth(request(app).patch(`/api/eval-schedules/${response.body.id}`), 1).send({ targetTier: "public", isEnabled: true }).expect(200);
    expect((await storage.getEvalSchedule(response.body.id))?.isEnabled).toBe(true);
    await storage.updateEvalSchedule(response.body.id, { isEnabled: false });
  });
  it("requires fresh owner consent for Shared sessions, not a test-account checkbox", async () => {
    setMarketplace({ authorizeDispatch } as unknown as EvalMarketplace);
    flow = (await storage.updateEvalFlow(flow.id, { config: { stepsPrefix: "- type: platform.setup\n  platform_id: agora\n  params:\n    email: ${secrets.LOGIN_EMAIL}\n    password: ${secrets.LOGIN_PASSWORD}\n" } }))!;
    const path = `/api/eval-flows/${flow.id}/run`;
    await auth(request(app).post(path), 1).send({ evalSetId: set.id, targetTokenId: sharedId }).expect(400);
    await auth(request(app).post(path), 1).send({ evalSetId: set.id, targetTokenId: sharedId, credentialConsent: true }).expect(200);
    expect(authorizeDispatch).toHaveBeenCalledTimes(1);
  });
  it.each(["private", "shared"] as const)("allows own Runtime and Brokered credentials on own %s agent without marketplace or third-party consent", async (tier) => {
    setMarketplace(null);
    const raw = `owner-${tier}-${randomUUID()}`;
    const token = await storage.createEvalAgentToken({ name: "My agent", tokenHash: hashToken(raw), createdBy: 1, dispatchTier: tier, siteId: `${region}-05` });
    const agent = await storage.createEvalAgent({ name: "My agent", tokenId: token.id, state: "idle", currentLeaseId: "own-lease", siteId: `${region}-05`, region, lastSeenAt: new Date(), metadata: { sessionInjection: "1" } });
    const target = { id: token.id, siteId: `${region}-05`, region, dispatchTier: tier, createdBy: 1, ownerOrgId: null };
    const result = await run({ region: undefined, targetTier: undefined, targetTokenId: token.id }, 1).expect(200);
    await storage.claimEvalJob(result.body.job.id, agent.id, target);
    await request(app).get(`/api/eval-agent/jobs/${result.body.job.id}/secrets?leaseId=own-lease`).set("Authorization", `Bearer ${raw}`).expect(200, { RUN_KEY: "owner-runtime-value" });
    flow = (await storage.updateEvalFlow(flow.id, { config: { stepsPrefix: "- type: platform.setup\n  platform_id: agora\n  params:\n    email: ${secrets.LOGIN_EMAIL}\n    password: ${secrets.LOGIN_PASSWORD}\n" } }))!;
    const sessionRun = await run({ region: undefined, targetTier: undefined, targetTokenId: token.id }, 1).expect(200);
    const pending = (await storage.getEvalJob(sessionRun.body.job.id))!;
    expect((await storage.getClaimableJobsForToken(target)).some((j) => j.id === pending.id)).toBe(true);
    expect(await storage.claimEvalJob(pending.id, agent.id, target)).not.toBeNull();
    const need = pending.snapshot!.sessionInjection!;
    const { credentialKeyFor } = await import("../server/auth-session");
    await pool.query("DELETE FROM web_sessions WHERE user_id=1");
    const cache = await storage.claimWebSessionMint({ userId: 1 }, need.platformId, credentialKeyFor(need), 120, 30);
    expect(cache).toBeDefined();
    await storage.storeWebSessionReady(cache!.id, encryptValue(JSON.stringify({ cookies: [], origins: [] })), 1, cache!.mintStartedAt!);
    const served = await request(app).get(`/api/eval-agent/jobs/${pending.id}/session?leaseId=own-lease`).set("Authorization", `Bearer ${raw}`).expect(200);
    expect(served.body.status).toBe("ready");
    expect(authorizeDispatch).not.toHaveBeenCalled();
    const targets = await auth(request(app).get(`/api/eval-flows/${flow.id}/run-targets?evalSetId=${set.id}`), 1).expect(200);
    expect(targets.body.agents.mine.find((a: { tokenId: number }) => a.tokenId === token.id)).toMatchObject({ ownCredentialAgent: true });
    expect(targets.body.preferredTokenId).toBe(token.id);
  });
  it("own Shared agents can serve their owner's personal My agents pool without opening third-party Shared pooling", async () => {
    const token = await storage.createEvalAgentToken({ name: "Own Shared pool", tokenHash: randomUUID(), createdBy: 1, dispatchTier: "shared", siteId: `${region}-06` });
    const agent = await storage.createEvalAgent({ name: "Own Shared pool", tokenId: token.id, state: "idle" });
    const job = await storage.createEvalJob({ ...values(1), targetTier: "private", snapshot: { ...buildJobSnapshot(flow, set, null, "premium"), sessionInjection: { platformId: "agora", emailSecret: "LOGIN_EMAIL", passwordSecret: "LOGIN_PASSWORD" } } });
    const target = { ...identity(), id: token.id, dispatchTier: "shared" };
    expect(isClaimable(job, target)).toBe(true);
    expect((await storage.getClaimableJobsForToken(target)).some((j) => j.id === job.id)).toBe(true);
    expect(await storage.claimEvalJob(job.id, agent.id, target)).not.toBeNull();
    expect(isClaimable({ ...job, targetTier: "shared" }, target)).toBe(false);
  });
  it("personal secret deletion is owner-only, including for a system admin", async () => {
    await storage.createOrUpdateSecret(1, "DELETE_OWNER_ONLY", encryptValue("test-delete-value"));
    await auth(request(app).delete("/api/secrets/DELETE_OWNER_ONLY"), 3).expect(404);
    expect((await storage.getSecretsByUserId(1)).some((s) => s.name === "DELETE_OWNER_ONLY")).toBe(true);
    await auth(request(app).delete("/api/secrets/DELETE_OWNER_ONLY"), 1).expect(200);
  });
  it("org secret deletion requires same-org owner/admin; membership and global admin are insufficient", async () => {
    setOrganizations(orgs);
    memberships.set(1, { organizationId: 10, role: "owner" });
    memberships.set(2, { organizationId: 10, role: "member" });
    memberships.set(3, { organizationId: 20, role: "member" });
    await auth(request(app).delete("/api/org-secrets/ORG_KEY"), 2).expect(403);
    await auth(request(app).delete("/api/org-secrets/ORG_KEY"), 3).expect(403);
    expect(deleteOrgSecret).not.toHaveBeenCalled();
    await auth(request(app).delete("/api/org-secrets/ORG_KEY"), 1).expect(200);
    expect(deleteOrgSecret).toHaveBeenCalledWith(10, "ORG_KEY");
  });
  it("owner trial policy endpoints derive scope from the session and require org management", async () => {
    await auth(request(app).put("/api/credential-trials/personal"), 2).send({ enabled: true, maxRuns30Days: 2, ownerId: 1 }).expect(200);
    expect((await auth(request(app).get("/api/credential-trials/personal"), 1)).body.enabled).toBe(false);
    await auth(request(app).put("/api/credential-trials/personal"), 2).send({ enabled: true, maxRuns30Days: 0 }).expect(400);
    setOrganizations(orgs);
    memberships.set(1, { organizationId: 10, role: "owner" });
    memberships.set(2, { organizationId: 10, role: "member" });
    await auth(request(app).put("/api/credential-trials/organization"), 2).send({ enabled: true, maxRuns30Days: 10 }).expect(403);
    await auth(request(app).put("/api/credential-trials/organization"), 1).send({ enabled: true, maxRuns30Days: 10 }).expect(200);
  });
  it("organization external trials require explicit opt-in and resolve only the frozen organization's secrets", async () => {
    setOrganizations(orgs);
    memberships.set(1, { organizationId: 10, role: "owner" });
    orgSecrets.set(10, [{ name: "RUN_KEY", brokerType: null, encryptedValue: encryptValue("organization-runtime-value") } as OrgSecretRow]);
    flow = (await storage.updateEvalFlow(flow.id, { organizationId: 10 }))!;
    set = (await storage.updateEvalSet(set.id, { organizationId: 10 }))!;
    await run().expect(429);
    await enable();
    const response = await run().expect(200);
    const job = await claim(await storage.getEvalJob(response.body.job.id) as EvalJob);
    await storage.updateEvalFlow(flow.id, { organizationId: 20 });
    const released = await request(app).get(`/api/eval-agent/jobs/${job.id}/secrets?leaseId=credential-lease`).set("Authorization", "Bearer credential-test-agent").expect(200);
    expect(released.body).toEqual({ RUN_KEY: "organization-runtime-value" });
  });
  it("the run picker mirrors trial availability and excludes non-Mainline borrowed targets", async () => {
    const disabled = await auth(request(app).get(`/api/eval-flows/${flow.id}/run-targets?evalSetId=${set.id}`)).expect(200);
    expect(disabled.body.trial).toMatchObject({ required: true, available: false });
    await enable();
    const enabled = await auth(request(app).get(`/api/eval-flows/${flow.id}/run-targets?evalSetId=${set.id}`)).expect(200);
    expect(enabled.body.trial).toMatchObject({ required: true, available: true, remaining24Hours: 5, remaining30Days: 80, trialLimit24Hours: 5, trialLimit30Days: 80 });
    expect(enabled.body.tiers.filter((t: { available: boolean }) => t.available).map((t: { tier: string }) => t.tier)).toEqual(["public"]);
    expect(enabled.body.agents.mine).toEqual([]);
    expect(enabled.body.agents.shared).toEqual([]);
  });
  it("the versioned API remains owner-only and applies Runtime pool ownership rules", async () => {
    setOrganizations(orgs); memberships.set(1, { organizationId: 10, role: "owner" });
    const path = `/api/v1/eval-flows/${flow.id}/run`;
    await auth(request(app).post(path), 2).send({ evalSetId: set.id, region, targetTier: "public" }).expect(403);
    await auth(request(app).post(path), 1).send({ evalSetId: set.id, region, targetTier: "team" }).expect(403);
    await auth(request(app).post(path), 1).send({ evalSetId: set.id, region, targetTier: "public" }).expect(201);
    expect(await count()).toBe(0);
  });
  it("rejects a login-class change after admission instead of minting Runtime as Brokered", async () => {
    flow = (await storage.updateEvalFlow(flow.id, { config: { stepsPrefix: "- type: platform.setup\n  platform_id: agora\n  params:\n    email: ${secrets.LOGIN_EMAIL}\n    password: ${secrets.LOGIN_PASSWORD}\n" } }))!;
    const response = await run({}, 1).expect(200);
    const job = await claim(await storage.getEvalJob(response.body.job.id) as EvalJob);
    await storage.createOrUpdateSecret(1, "LOGIN_EMAIL", encryptValue("changed@example.com"), { brokerType: null });
    try {
      await request(app).get(`/api/eval-agent/jobs/${job.id}/session?leaseId=credential-lease`).set("Authorization", "Bearer credential-test-agent").expect(403);
    } finally {
      await storage.createOrUpdateSecret(1, "LOGIN_EMAIL", encryptValue("owner@example.com"), { brokerType: "auth-session" });
    }
  });
  it("Shared requires Brokered classification even for Core REST operations", async () => {
    setMarketplace({ authorizeDispatch } as unknown as EvalMarketplace);
    flow = (await storage.updateEvalFlow(flow.id, { config: { stepsPrefix: "- type: restful.request\n  method: POST\n  url: https://example.com/test\n  headers:\n    Authorization: Bearer ${secrets.RUN_KEY}\n" } }))!;
    await auth(request(app).post(`/api/eval-flows/${flow.id}/run`), 1).send({ evalSetId: set.id, targetTokenId: sharedId }).expect(400);
    expect(authorizeDispatch).not.toHaveBeenCalled();
    await pool.query("UPDATE eval_agent_tokens SET token_hash=$2 WHERE id=$1", [sharedId, hashToken("shared-rest-test")]);
    const agent = await storage.createEvalAgent({ tokenId: sharedId, name: "Shared REST", state: "idle", currentLeaseId: "shared-lease" });
    const pending = await storage.createEvalJob({ ...values(1), targetTier: null, targetRegion: null, targetTokenId: sharedId });
    const job = await storage.claimEvalJob(pending.id, agent.id, { ...identity(), id: sharedId, dispatchTier: "shared", createdBy: 3 });
    await request(app).post(`/api/eval-agent/jobs/${job!.id}/restful`).set("Authorization", "Bearer shared-rest-test")
      .send({ leaseId: "shared-lease", stepIndex: 0 }).expect(403);
  });
  it.each([
    { tier: "private", flowOrg: null, agentOwner: 1, agentOrg: null, consent: false, allowed: true },
    { tier: "private", flowOrg: null, agentOwner: 2, agentOrg: null, consent: false, allowed: false },
    { tier: "private", flowOrg: 10, agentOwner: 1, agentOrg: 10, consent: false, allowed: false },
    { tier: "team", flowOrg: 10, agentOwner: 2, agentOrg: 10, consent: false, allowed: true },
    { tier: "team", flowOrg: 10, agentOwner: 2, agentOrg: 20, consent: false, allowed: false },
    { tier: "team", flowOrg: null, agentOwner: 1, agentOrg: 10, consent: false, allowed: false },
    { tier: "public", flowOrg: null, agentOwner: 3, agentOrg: null, consent: false, allowed: true },
    { tier: "public", flowOrg: 10, agentOwner: 3, agentOrg: null, consent: false, allowed: true },
    { tier: "shared", flowOrg: null, agentOwner: 3, agentOrg: null, consent: true, allowed: true },
    { tier: "shared", flowOrg: null, agentOwner: 1, agentOrg: null, consent: false, allowed: true },
    { tier: "shared", flowOrg: 10, agentOwner: 1, agentOrg: 10, consent: false, allowed: false },
    { tier: "shared", flowOrg: null, agentOwner: 3, agentOrg: null, consent: false, allowed: false },
  ] as const)("frozen claim/list/pure policy agree: $tier, flow org $flowOrg, agent owner $agentOwner/org $agentOrg, consent $consent", async ({ tier, flowOrg, agentOwner, agentOrg, consent, allowed }) => {
    const token = await storage.createEvalAgentToken({ name: "Policy matrix", tokenHash: randomUUID(), createdBy: agentOwner, dispatchTier: tier, siteId: `${region}-03` });
    const agent = await storage.createEvalAgent({ name: "Policy matrix", tokenId: token.id, state: "idle", currentLeaseId: "matrix-lease" });
    const frozen = { ...flow, organizationId: flowOrg };
    const pending = await storage.createEvalJob({ ...values(1), targetTokenId: token.id, targetTier: null, targetRegion: null,
      snapshot: { ...buildJobSnapshot(frozen, set, null, "premium"), credentialConsent: consent,
        sessionInjection: { platformId: "agora", emailSecret: "LOGIN_EMAIL", passwordSecret: "LOGIN_PASSWORD" } },
    });
    // A live edit must not change the scope of the queued job.
    await storage.updateEvalFlow(flow.id, { ownerId: 4, organizationId: 30 });
    const agentIdentity = { ...identity(), id: token.id, createdBy: agentOwner, dispatchTier: tier, ownerOrgId: agentOrg };
    expect(isClaimable(pending, agentIdentity, { tokenOwnerOrgId: agentOrg, creatorOrgId: null })).toBe(allowed);
    const listed = await storage.getClaimableJobsForToken(agentIdentity);
    expect(listed.some((job) => job.id === pending.id)).toBe(allowed);
    const claimed = await storage.claimEvalJob(pending.id, agent.id, agentIdentity);
    expect(claimed?.status === "running").toBe(allowed);
    expect((await storage.getEvalJob(pending.id))?.status).toBe(allowed ? "running" : "pending");
  });
});
