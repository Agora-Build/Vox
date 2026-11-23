import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
await vi.hoisted(async () => {
  if (process.env.DATABASE_URL) {
    const { prepareIsolatedCoreDb } = await import("./helpers/isolated-core-db");
    process.env.DATABASE_URL = await prepareIsolatedCoreDb(process.env.DATABASE_URL, `vox_test_account_integration_${process.pid}`);
    process.env.CREDENTIAL_ENCRYPTION_KEY = "ab".repeat(32);
  }
});
import express from "express";
import { createServer } from "node:http";
import request from "supertest";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import type { JobSnapshot } from "../shared/schema";
import { pool, storage, hashToken, encryptValue, decryptValue } from "../server/storage";
import { registerAccountSessionRoutes } from "../server/routes-account-sessions";
import { registerRoutes } from "../server/routes";
import { accountSessionStore, authorityForAccountGrant, brokerAccountAuthority, brokerAccountBinding, runtimeAccountCredentialDelivery, runAccountSessionRetention, decodeAccountSessionGrant, encodeAccountSessionGrant, type AccountSessionContext } from "../server/account-session-service";
import { ACCOUNT_STATE_FORMAT } from "../shared/account-session-protocol";
import { accountSetupForJob } from "../shared/account-session-setup";
import { resetOrganizations, setOrganizations } from "../server/organizations";
import { createPluginDb } from "../server/plugins/db";
import { createOrganizationsProvider } from "../plugins/organizations/server/provider";
import { credentialKeyFor, ensureSession } from "../server/auth-session";
import { AccountSessionError } from "../server/account-session-binding";

const d = process.env.DATABASE_URL ? describe : describe.skip;
const app = express(); app.use(express.json({ limit: "13mb" })); registerAccountSessionRoutes(app);
const config = { stepsPrefix: "- type: platform.setup\n  platform_id: elevenlabs\n  params:\n    mode: account\n    email: ${secrets.EMAIL}\n    password: ${secrets.PASSWORD}\n    storage_file: .auth/elevenlabs.json\n", scenario: "steps: []" };
const need = { platformId: "elevenlabs", emailSecret: "EMAIL", passwordSecret: "PASSWORD" };
const state = (value = "private-session-canary") => JSON.stringify({ cookies: [{ name: "session", value, domain: "elevenlabs.io", path: "/",
  expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }], origins: [] });
function checkpoint(sessionId: string, value = state(), sequence = 1, snapshotId = randomBytes(16).toString("hex")) {
  return { state: value, record: { schema: "auth.checkpoint.v3", session_id: sessionId, snapshot_id: snapshotId, sequence,
    snapshot: `snapshots/${sessionId}/${snapshotId}.json`, storage_format: ACCOUNT_STATE_FORMAT, byte_length: Buffer.byteLength(value) } };
}

d("account sessions: real Core authorization, routes and PostgreSQL", () => {
  let tokenId: number, agentId: number, jobId: number, startedAt: string, sessionId: string, credentialRevision: string;
  let orgs: { provider: ReturnType<typeof createOrganizationsProvider> };
  const auth = (r: request.Test) => r.set("Authorization", "Bearer account-fixture-token");
  const endpoint = () => `/api/eval-agent/jobs/${jobId}/account-session`;
  const prepare = () => auth(request(app).post(endpoint())).send({ sessionId, startedAt, leaseId: "fixture-lease", credentialRevision });
  const deliver = (grant: string, body = checkpoint(sessionId)) => auth(request(app).post(`${endpoint()}/checkpoints`)).send({ grant, ...body });
  const snapshot = (orgId: number | null = null): JobSnapshot => ({ provider: null, creatorPlan: "premium", evalSet: null,
    evalFlow: { name: "Account fixture", config, ownerId: 1, organizationId: orgId, visibility: "private", isMainline: false } });
  async function credentialDelivery() {
    return runtimeAccountCredentialDelivery({ jobId, tokenHash: hashToken("account-fixture-token"), leaseId: "fixture-lease", startedAt });
  }
  async function createJob(orgId: number | null = null, withCredentialDelivery = true) {
    const result = await pool.query(`INSERT INTO eval_jobs(config,snapshot,status,created_by,eval_agent_id,started_at)
      VALUES($1,$2,'running',1,$3,date_trunc('milliseconds',clock_timestamp())) RETURNING id, started_at AT TIME ZONE 'UTC' AS started_at`,
    [config, snapshot(orgId), agentId]);
    jobId = result.rows[0].id; startedAt = result.rows[0].started_at.toISOString(); sessionId = `vox-${jobId}-${randomUUID()}`;
    credentialRevision = withCredentialDelivery ? (await credentialDelivery())!.credentialRevision : "0".repeat(64);
  }
  beforeAll(async () => {
    await pool.query("INSERT INTO users(id,username,email,is_enabled) VALUES(1,'account-owner','owner@account.invalid',true),(2,'account-other','other@account.invalid',true)");
    // Same disposable database as Core: advisory fences must cross both pools.
    await pool.query('CREATE SCHEMA account_session_orgs');
    const db = createPluginDb(pool, 'account_session_orgs');
    await db.withTransaction(async tx => {
      for (const file of readdirSync('plugins/organizations/migrations').filter(f => f.endsWith('.sql')).sort()) {
        for (const sql of readFileSync(`plugins/organizations/migrations/${file}`, 'utf8').split('--> statement-breakpoint').filter(s => s.trim())) await tx.query(sql);
      }
    });
    orgs = { provider: createOrganizationsProvider(db) };
    const timers = vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref() {} } as NodeJS.Timeout);
    try { await registerRoutes(createServer(app), app); } finally { timers.mockRestore(); }
  });
  beforeEach(async () => {
    resetOrganizations();
    for (const userId of [1, 2]) {
      const member = await orgs.provider.getMembership(userId);
      if (member) await orgs.provider.removeMember(member.organizationId, userId);
    }
    await pool.query("UPDATE users SET is_enabled=true");
    await pool.query("TRUNCATE account_sessions CASCADE; DELETE FROM web_sessions; DELETE FROM eval_jobs; DELETE FROM eval_agents; DELETE FROM eval_agent_tokens; DELETE FROM broker_registration_tokens CASCADE; DELETE FROM secrets");
    tokenId = (await storage.createEvalAgentToken({ name: "fixture", createdBy: 1, dispatchTier: "private", tokenHash: hashToken("account-fixture-token") })).id;
    agentId = (await storage.createEvalAgent({ name: "fixture", tokenId, currentLeaseId: "fixture-lease", state: "occupied" })).id;
    await pool.query("UPDATE eval_agents SET last_seen_at=clock_timestamp() WHERE id=$1", [agentId]);
    await storage.createOrUpdateSecret(1, "EMAIL", encryptValue("fixture@account.invalid"));
    await storage.createOrUpdateSecret(1, "PASSWORD", encryptValue("fixture-password"));
    await createJob();
  });
  afterAll(async () => { resetOrganizations(); await pool.end(); });

  it("commits encrypted immutable state + matching receipt, retries idempotently and restores in another job", async () => {
    const prepared = await prepare().expect(200);
    expect(prepared.body).toMatchObject({ status: "ready", state: null, grant: expect.any(String) });
    const body = checkpoint(sessionId);
    const first = await deliver(prepared.body.grant, body).expect(200);
    expect(first.body).toMatchObject({ status: "persisted", sessionId, snapshotId: body.record.snapshot_id });
    expect((await deliver(prepared.body.grant, body).expect(200)).body).toEqual(first.body);
    const raw = (await pool.query("SELECT encrypted_storage_state FROM account_sessions")).rows[0].encrypted_storage_state;
    expect(raw).not.toContain("private-session-canary"); expect(decryptValue(raw)).toContain("private-session-canary");
    expect((await pool.query("SELECT count(*)::int AS n FROM account_session_checkpoints")).rows[0].n).toBe(1);
    await auth(request(app).post(`${endpoint()}/release`)).send({ grant: prepared.body.grant }).expect(200);
    await pool.query("UPDATE eval_jobs SET status='failed' WHERE id=$1", [jobId]);
    await createJob();
    expect((await prepare().expect(200)).body.state).toBe(body.state);
  });

  it("delivers a non-secret revision alongside the original Runtime secret response, without changing its body shape", async () => {
    const response = await auth(request(app).get(`/api/eval-agent/jobs/${jobId}/secrets?leaseId=fixture-lease`)).expect(200);
    expect(response.body).toEqual({ EMAIL: "fixture@account.invalid", PASSWORD: "fixture-password" });
    expect(response.headers['x-vox-account-revision']).toBe(credentialRevision);
    expect(response.headers['cache-control']).toBe('no-store');
    await prepare().expect(200);
    await storage.createOrUpdateSecret(1, 'PASSWORD', encryptValue('rotated-password'));
    await prepare().expect(403);
    const rotated = await auth(request(app).get(`/api/eval-agent/jobs/${jobId}/secrets?leaseId=fixture-lease`)).expect(200);
    expect(rotated.body.PASSWORD).toBe('rotated-password');
    expect(rotated.headers['x-vox-account-revision']).not.toBe(credentialRevision);
    credentialRevision = rotated.headers['x-vox-account-revision'];
    await prepare().expect(200);
  });

  it.each(["lease", "claim", "revoked", "completed", "disabled", "credentials"])("rejects a previously issued grant after %s changes", async change => {
    const prepared = await prepare().expect(200);
    if (change === "lease") await pool.query("UPDATE eval_agents SET current_lease_id='new-lease'");
    if (change === "claim") await pool.query("UPDATE eval_jobs SET started_at=started_at+interval '1 second'");
    if (change === "revoked") await pool.query("UPDATE eval_agent_tokens SET is_revoked=true");
    if (change === "completed") await pool.query("UPDATE eval_jobs SET status='completed'");
    if (change === "disabled") await pool.query("UPDATE users SET is_enabled=false WHERE id=2");
    if (change === "disabled") { await pool.query("UPDATE eval_agent_tokens SET created_by=2,dispatch_tier='public'"); }
    if (change === "credentials") await storage.createOrUpdateSecret(1, "PASSWORD", encryptValue("rotated-password"));
    await deliver(prepared.body.grant).expect(403);
    expect((await pool.query("SELECT * FROM account_session_checkpoints")).rows).toHaveLength(0);
    await pool.query("UPDATE users SET is_enabled=true");
  });

  it("does not deliver Runtime sessions to a stranger's Shared agent, but permits the owner's own Shared agent", async () => {
    await pool.query("UPDATE eval_agent_tokens SET dispatch_tier='shared', created_by=2");
    await prepare().expect(403);
    await pool.query("UPDATE eval_agent_tokens SET created_by=1");
    await prepare().expect(200);
  });

  it("requires real owner/trial authorization, not just an active lease", async () => {
    await pool.query("UPDATE eval_jobs SET created_by=2; UPDATE eval_agent_tokens SET dispatch_tier='public'");
    await prepare().expect(403);
  });

  it("refuses arbitrary Runtime values, omitted storage, storage-only mode and the old checkpoint protocol", async () => {
    expect(accountSetupForJob(config)).toEqual(need);
    for (const text of [config.stepsPrefix.replace('    storage_file: .auth/elevenlabs.json\n', ''), config.stepsPrefix.replace('mode: account', 'mode: storage'),
      config.stepsPrefix.replace('${secrets.EMAIL}', 'literal@example.invalid')]) {
      expect(accountSetupForJob({ ...config, stepsPrefix: text })).toBeNull();
    }
    const prepared = await prepare().expect(200), cp = checkpoint(sessionId);
    await deliver(prepared.body.grant, { ...cp, record: { ...cp.record, schema: "aeval.auth.v2" } }).expect(400);
    await deliver(prepared.body.grant, checkpoint(sessionId, JSON.stringify({ OTHER_RUNTIME_TOKEN: "not-a-session" }))).expect(422);
  });

  it("keeps credential rotation isolated from the old saved account", async () => {
    const prepared = await prepare().expect(200); await deliver(prepared.body.grant).expect(200);
    await storage.createOrUpdateSecret(1, "PASSWORD", encryptValue("rotated-password"));
    sessionId = `vox-${jobId}-${randomUUID()}`;
    credentialRevision = (await credentialDelivery())!.credentialRevision;
    expect((await prepare().expect(200)).body.state).toBeNull();
  });

  it("binds the delivered Runtime pair to its revision and rejects rotation before preparation or claim", async () => {
    const delivered = await credentialDelivery();
    expect(delivered?.credentials).toEqual({ EMAIL: "fixture@account.invalid", PASSWORD: "fixture-password" });
    expect(delivered?.credentialRevision).toMatch(/^[a-f0-9]{64}$/);
    const prepared = await prepare().expect(200); await deliver(prepared.body.grant).expect(200);
    expect(decodeAccountSessionGrant(prepared.body.grant).context).not.toHaveProperty('credentials');
    await auth(request(app).post(`${endpoint()}/release`)).send({ grant: prepared.body.grant }).expect(200);
    await storage.createOrUpdateSecret(1, "PASSWORD", encryptValue("rotated-password"));
    await prepare().expect(403);
    credentialRevision = (await credentialDelivery())!.credentialRevision;
    const original = accountSessionStore.claim.bind(accountSessionStore);
    const claim = vi.spyOn(accountSessionStore, "claim").mockImplementationOnce(async (authorize, ttl) => {
      // A same-plaintext rewrite is still a new randomized ciphertext revision.
      await storage.createOrUpdateSecret(1, "PASSWORD", encryptValue("rotated-password"));
      return original(authorize, ttl);
    });
    try { await prepare().expect(403); } finally { claim.mockRestore(); }
  });

  it("does not issue a replacement grant or overwrite an undecryptable prior state", async () => {
    const prepared = await prepare().expect(200); await deliver(prepared.body.grant).expect(200);
    await pool.query("UPDATE account_sessions SET encrypted_storage_state='v1:corrupt-envelope'");
    sessionId = `vox-${jobId}-${randomUUID()}`;
    await prepare().expect(503);
    expect((await pool.query("SELECT encrypted_storage_state FROM account_sessions")).rows[0].encrypted_storage_state).toBe('v1:corrupt-envelope');
  });

  async function brokeredReady() {
    await pool.query("UPDATE secrets SET broker_type='auth-session'");
    const binding = await brokerAccountBinding({ userId: 1 }, need);
    const claimed = (await storage.claimWebSessionMint({ userId: 1 }, need.platformId, credentialKeyFor(need), 660, 60, binding.sessionKey))!;
    await storage.storeWebSessionReady(claimed.id, "", 24, claimed.mintStartedAt!);
    await pool.query("UPDATE eval_jobs SET snapshot=$1 WHERE id=$2", [{ ...snapshot(), sessionInjection: need }, jobId]);
  }

  it("single-flights overlapping retention ticks and permits the next tick after completion", async () => {
    let finish!: (value: { sessions: number; checkpoints: number }) => void;
    const pending = new Promise<{ sessions: number; checkpoints: number }>(resolve => { finish = resolve; });
    const sweep = vi.spyOn(accountSessionStore, "pruneExpired").mockReturnValueOnce(pending)
      .mockResolvedValue({ sessions: 0, checkpoints: 0 });
    try {
      const first = runAccountSessionRetention();
      expect(runAccountSessionRetention()).toBe(first); expect(sweep).toHaveBeenCalledOnce();
      finish({ sessions: 0, checkpoints: 0 }); await first;
      await runAccountSessionRetention(); expect(sweep).toHaveBeenCalledTimes(2);
    } finally { finish({ sessions: 0, checkpoints: 0 }); await pending; sweep.mockRestore(); }
  });

  it("retries a failed retention tick without logging private database errors", async () => {
    const sweep = vi.spyOn(accountSessionStore, "pruneExpired").mockRejectedValueOnce(new Error("private-database-canary"))
      .mockResolvedValue({ sessions: 0, checkpoints: 0 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runAccountSessionRetention(); await runAccountSessionRetention();
      expect(sweep).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledExactlyOnceWith("[Account sessions] Retention sweep failed; will retry");
    } finally { sweep.mockRestore(); warn.mockRestore(); }
  });

  it.each([false, true])("records a managed binding denial promptly with an existing ready row: %s", async ready => {
    if (ready) await brokeredReady();
    else await pool.query("UPDATE secrets SET broker_type='auth-session'");
    await pool.query("UPDATE users SET is_enabled=false WHERE id=1");
    await ensureSession({ userId: 1 }, need);
    const failed = await storage.getWebSession({ userId: 1 }, need.platformId, credentialKeyFor(need));
    expect(failed).toMatchObject({ status: "failed", lastError: "Account session: unauthorized" });
  });

  it("records a deleted credential binding failure instead of leaving the row minting", async () => {
    await brokeredReady(); await pool.query("DELETE FROM secrets WHERE name='PASSWORD'");
    await ensureSession({ userId: 1 }, need);
    const failed = await storage.getWebSession({ userId: 1 }, need.platformId, credentialKeyFor(need));
    expect(failed?.status).toBe("failed");
    expect(failed?.lastError).toMatch(/Account session:/);
    expect(failed?.lastError).not.toContain("broker");
  });

  it("records an unsupported organization fencing contract as a failed mint", async () => {
    await ensureSession({ organizationId: 901 }, need);
    expect(await storage.getWebSession({ organizationId: 901 }, need.platformId, credentialKeyFor(need)))
      .toMatchObject({ status: "failed", lastError: "Account session: unauthorized" });
  });

  it.each([["unauthorized", 403], ["invalid-binding", 403], ["state-unavailable", 503]] as const)(
    "serves a safe %s failure with HTTP %s instead of a generic server fault", async (code, status) => {
      await brokeredReady();
      const error = new AccountSessionError(code);
      error.message = "private-provider-state-canary";
      const read = vi.spyOn(accountSessionStore, "read").mockRejectedValueOnce(error);
      try {
        const response = await auth(request(app).get(`/api/eval-agent/jobs/${jobId}/session?leaseId=fixture-lease`)).expect(status);
        expect(read).toHaveBeenCalledOnce();
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).toMatchObject({ required: true, status: "failed" });
        expect(JSON.stringify(response.body)).not.toContain("canary");
      } finally { read.mockRestore(); }
    });

  it("fences org membership removal and credential rotation through the plugin seam", async () => {
    setOrganizations(orgs.provider);
    const org = await orgs.provider.createOrganization({ name: `Account ${randomUUID()}` }, { userId: 1 });
    for (const [name, value] of [["EMAIL", "org@example.invalid"], ["PASSWORD", "org-password"]]) await orgs.provider.upsertOrgSecret(org.id,
      { name, encryptedValue: encryptValue(value), brokerType: null, isTestAccount: false, createdBy: 1 });
    await pool.query("UPDATE eval_agent_tokens SET dispatch_tier='team'");
    await createJob(org.id);
    const prepared = await prepare().expect(200); await deliver(prepared.body.grant).expect(200);
    await orgs.provider.removeMember(org.id, 1);
    await deliver(prepared.body.grant, checkpoint(sessionId, state("new"), 2)).expect(403);
  });

  it("holds real org credential mutation fences through the Core state-and-receipt commit", async () => {
    setOrganizations(orgs.provider);
    const org = await orgs.provider.createOrganization({ name: `Concurrent ${randomUUID()}` }, { userId: 1 });
    for (const name of ['EMAIL', 'PASSWORD']) await orgs.provider.upsertOrgSecret(org.id,
      { name, encryptedValue: encryptValue('initial'), brokerType: null, isTestAccount: false, createdBy: 1 });
    await pool.query("UPDATE eval_agent_tokens SET dispatch_tier='team'"); await createJob(org.id);
    const prepared = await prepare().expect(200), { context, ticket } = decodeAccountSessionGrant(prepared.body.grant);
    const authorize = authorityForAccountGrant(context), cp = checkpoint(sessionId);
    let unlock!: () => void, entered!: () => void, first = true;
    const gate = new Promise<void>(resolve => { unlock = resolve; }), locked = new Promise<void>(resolve => { entered = resolve; });
    const saving = accountSessionStore.save(async client => {
      const authority = await authorize(client);
      if (first) { first = false; entered(); await gate; }
      return authority;
    }, ticket!, { checkpointId: cp.record.snapshot_id, sequence: 1, format: ACCOUNT_STATE_FORMAT, state: cp.state });
    await locked;
    const rotating = orgs.provider.upsertOrgSecret(org.id, { name: 'PASSWORD', encryptedValue: encryptValue('rotated'),
      brokerType: null, isTestAccount: false, createdBy: 1 });
    try {
      const deadline = Date.now() + 2000;
      for (;;) {
        const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock(%'");
        if (waiting.rowCount) break;
        if (Date.now() > deadline) throw new Error('Org mutation did not wait on Core authority fence');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    } finally { unlock(); }
    expect((await saving).status).toBe('persisted'); await rotating;
    await deliver(prepared.body.grant, checkpoint(sessionId, state('late'), 2)).expect(403);
    await orgs.provider.removeMember(org.id, 1);
  });

  it("fails closed for org persistence when the provider does not advertise mutation fencing", async () => {
    setOrganizations({ ...orgs.provider, accountSessionFencing: undefined });
    const org = await orgs.provider.createOrganization({ name: `Unfenced ${randomUUID()}` }, { userId: 1 });
    for (const name of ['EMAIL', 'PASSWORD']) await orgs.provider.upsertOrgSecret(org.id,
      { name, encryptedValue: encryptValue('fixture'), brokerType: null, isTestAccount: false, createdBy: 1 });
    await pool.query("UPDATE eval_agent_tokens SET dispatch_tier='team'"); await createJob(org.id, false);
    await prepare().expect(403);
    await orgs.provider.removeMember(org.id, 1);
  });

  it("refreshes fresh legacy Brokered rows and rotated bindings without waiting for cache expiry", async () => {
    const scope = { userId: 1 }, credentialKey = "legacy-pair";
    const legacy = await storage.claimWebSessionMint(scope, "elevenlabs", credentialKey, 600, 60);
    expect(legacy).toBeDefined();
    await pool.query("UPDATE web_sessions SET status='ready', expires_at=now()+interval '1 day' WHERE id=$1", [legacy!.id]);
    const bindingKey = "a".repeat(64);
    const migrated = await storage.claimWebSessionMint(scope, "elevenlabs", credentialKey, 600, 60, bindingKey);
    expect(migrated?.accountSessionKey).toBe(bindingKey);
    await pool.query("UPDATE web_sessions SET status='ready', expires_at=now()+interval '1 day' WHERE id=$1", [legacy!.id]);
    expect(await storage.claimWebSessionMint(scope, "elevenlabs", credentialKey, 600, 60, bindingKey)).toBeUndefined();
    const rotated = await storage.claimWebSessionMint(scope, "elevenlabs", credentialKey, 600, 60, "b".repeat(64));
    expect(rotated?.accountSessionKey).toBe("b".repeat(64));
  });

  async function brokerFixture() {
    await storage.createOrUpdateSecret(1, "EMAIL", encryptValue("broker@example.invalid"), { brokerType: "auth-session" });
    await storage.createOrUpdateSecret(1, "PASSWORD", encryptValue("broker-password"), { brokerType: "auth-session" });
    const binding = await brokerAccountBinding({ userId: 1 }, need);
    const token = await pool.query("INSERT INTO broker_registration_tokens(name,token_hash,created_by) VALUES('fixture','broker-hash',1) RETURNING id");
    const broker = await pool.query("INSERT INTO brokers(name,token_id,broker_type,url,current_lease_id,state,last_seen_at) VALUES('fixture',$1,'auth-session','http://broker:8200','broker-lease','idle',now()) RETURNING id", [token.rows[0].id]);
    const operationId = randomUUID();
    const mint = await pool.query(`INSERT INTO web_sessions(user_id,platform_id,credential_key,status,mint_started_at,mint_broker_id,mint_operation_id,mint_deadline_at,account_session_key)
      VALUES(1,'elevenlabs','fixture-pair','minting',date_trunc('milliseconds',clock_timestamp()),$1,$2,now()+interval '5 minutes',$3)
      RETURNING id,mint_started_at AT TIME ZONE 'UTC' AS mint_started_at`, [broker.rows[0].id, operationId, binding.sessionKey]);
    const context: Extract<AccountSessionContext, { kind: "brokered" }> = { kind: "brokered", version: 1, sessionId: `vox-mint-${randomUUID()}`,
      bindingKey: binding.sessionKey, deadline: new Date(Date.now() + 300_000).toISOString(), mintId: mint.rows[0].id,
      mintStartedAt: mint.rows[0].mint_started_at.toISOString(), brokerId: broker.rows[0].id, brokerLease: "broker-lease", operationId, scope: { userId: 1 }, need };
    const ticket = await accountSessionStore.claim(brokerAccountAuthority(context), 300);
    const grant = encodeAccountSessionGrant(context, ticket);
    return { context, grant };
  }
  it("only the current trusted broker mint can restore and replace canonical Brokered state", async () => {
    const { context, grant } = await brokerFixture();
    await request(app).post('/api/brokers/account-session/checkpoints').send({ grant, ...checkpoint(context.sessionId) }).expect(200);
    expect((await request(app).post('/api/brokers/account-session/restore').send({ grant }).expect(200)).body.state).toBe(state());
    await deliver(grant, checkpoint(context.sessionId)).expect(403);
    const runtime = decodeAccountSessionGrant(grant);
    expect(runtime.context.kind).toBe('brokered');
    await pool.query("UPDATE brokers SET current_lease_id='new-lease'");
    await request(app).post('/api/brokers/account-session/checkpoints').send({ grant, ...checkpoint(context.sessionId, state('stale'), 2) }).expect(403);
    await request(app).post('/api/brokers/account-session/restore').send({ grant }).expect(403);
  });
});
