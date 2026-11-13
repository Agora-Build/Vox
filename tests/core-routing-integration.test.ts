import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { storage, pool, hashToken, encryptValue } from "../server/storage";
import { credentialKeyFor } from "../server/auth-session";
import { PgCoreDirectory } from "../server/core-routing-store";
import { PgBrowserViewers } from "../server/browser-viewers";
import { CoreRouting, type CoreOwner } from "../server/core-routing";
import type { BrowserCommand, BrowserOperation } from "../shared/browser-assistance";
import { jobMayUseCredentials } from "../server/credential-trials";
import { setupOrganizationsDb, type OrgsHarness } from "./helpers/organizations-db";
import { TEST_PLUGIN_DATABASE_URL } from "./helpers/plugin-test-db";

const d = process.env.DATABASE_URL ? describe : describe.skip;
type Core = { origin: string; id: string; child: ChildProcess };
const processes: Core[] = [], sockets: WebSocket[] = [];
const routingSecret = "isolated-multi-core-routing-secret-32-characters";
async function startCore(orgSchema: string): Promise<Core> {
  const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "tests/helpers/browser-core-process.ts"], {
    cwd: process.cwd(), env: { ...process.env, VOX_CORE_ROUTING_SECRET: routingSecret,
      TEST_BROWSER_ORG_SCHEMA: orgSchema, TEST_PLUGIN_DATABASE_URL }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Core startup timed out: ${output.slice(-1500)}`)); }, 20000);
    child.stderr!.on("data", (value) => { output = (output + value).slice(-4000); });
    child.stdout!.on("data", (value) => {
      output += value;
      const ready = /ROUTING_READY (\{[^\n]+\})/.exec(output);
      if (ready) { clearTimeout(timer); const core = { ...JSON.parse(ready[1]), child } as Core; processes.push(core); resolve(core); }
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Core exited (${code}): ${output.slice(-1500)}`)); });
  });
}
const post = (core: Core, path: string, body: unknown, cookie?: string) => fetch(`${core.origin}${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});
async function stop(core: Core) {
  if (core.child.exitCode !== null || core.child.signalCode) return;
  const done = new Promise<void>((resolve) => core.child.once("exit", () => resolve()));
  core.child.kill("SIGTERM"); const timer = setTimeout(() => core.child.kill("SIGKILL"), 5000);
  await done; clearTimeout(timer);
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error("Connection ownership did not settle");
}

d("real independent Core processes", () => {
  let a: Core, b: Core, userId: number, agentId: number, tokenId: number, jobId: number, cookie: string;
  let brokerId: number, brokerTokenId: number, brokerServer: Server;
  let otherUserId: number, orgs: OrgsHarness;
  const token = randomUUID(), lease = randomUUID(), stamp = randomUUID();
  const directory = new PgCoreDirectory(pool);
  const messages: { execution: { jobId: number }; operation: BrowserOperation }[] = [];
  const brokerCalls: { path?: string; body: unknown }[] = [];
  const status = { session_id: "session", browser_generation: "browser", capabilities: [],
    pages: [{ page_id: "page", document_epoch: 1, origin: null }], viewing: true, controlling: false, next_sequence: 1,
    assistance: { wait_id: "wait", kind: "authentication", state: "waiting", page_id: "page", remaining_seconds: 30 } };
  const frame = { version: 1, type: "event", event: "viewer.frame", session_id: "session", browser_generation: "browser", lease_id: "capture-lease",
    page_id: "page", document_epoch: 1, data: "aW1hZ2U=", metadata: { deviceWidth: 800, deviceHeight: 600 } };
  const command = (name: BrowserCommand["command"], params?: Record<string, unknown>) => ({ version: 1, id: randomUUID(), command: name,
    session_id: "session", browser_generation: "browser", params: { lease_id: "capture-lease", page_id: "page", document_epoch: 1, ...params } });
  function engineResult(operation: BrowserOperation) {
    if (operation.action === "frame") return frame;
    const name = operation.request?.command;
    if (name === "viewer.take_control") status.controlling = true;
    if (name === "viewer.release_control" || operation.action === "close") {
      status.controlling = false;
      if (name === "viewer.release_control") status.assistance.wait_id = randomUUID();
    }
    const result = name === "viewer.open" ? { lease_id: "capture-lease", page_id: "page", document_epoch: 1, mode: "read_only" }
      : name === "viewer.take_control" ? { control_id: randomUUID(), next_sequence: 1 }
      : name === "viewer.input" ? { next_sequence: 2 } : status;
    return { version: 1, type: "response", id: operation.request?.id ?? randomUUID(), ok: true, result };
  }
  const snapshot = (organizationId: number | null = null) => ({ provider: null, evalFlow: { ownerId: userId, organizationId, name: "multi-core", config: {}, visibility: "private", isMainline: false }, evalSet: null, creatorPlan: "basic" });
  async function connect(core: Core) {
    const ws = new WebSocket(core.origin.replace("http:", "ws:") + "/ws/eval-browser", { headers: { authorization: `Bearer ${token}`, "x-vox-agent-lease": lease } });
    sockets.push(ws);
    ws.on("message", (data) => {
      const value = JSON.parse(data.toString()); messages.push(value);
      ws.send(JSON.stringify({ id: value.id, ok: true, result: engineResult(value.operation) }));
    });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    await until(async () => (await directory.find("agent", agentId))?.coreId === core.id);
    return ws;
  }
  beforeAll(async () => {
    userId = (await pool.query("INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id", [`multi-${stamp}`, `multi-${stamp}@example.com`])).rows[0].id;
    otherUserId = (await pool.query("INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id", [`multi-other-${stamp}`, `multi-other-${stamp}@example.com`])).rows[0].id;
    orgs = await setupOrganizationsDb();
    const createdToken = await storage.createEvalAgentToken({ name: `multi-${stamp}`, tokenHash: hashToken(token), createdBy: userId, dispatchTier: "private" }); tokenId = createdToken.id;
    agentId = (await storage.createEvalAgent({ name: `multi-${stamp}`, tokenId, currentLeaseId: lease, state: "occupied", metadata: { browserAssistance: "1" } })).id;
    jobId = (await pool.query("INSERT INTO eval_jobs (created_by, eval_agent_id, status, started_at, snapshot) VALUES ($1,$2,'running',date_trunc('milliseconds',clock_timestamp()),$3) RETURNING id", [userId, agentId, snapshot()])).rows[0].id;
    [a, b] = await Promise.all([startCore(orgs.schema), startCore(orgs.schema)]);
    cookie = (await post(a, "/test/login", { userId })).headers.get("set-cookie")!.split(";")[0];
    await connect(a);
  });
  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    await Promise.all(processes.map(stop));
    if (brokerServer) { brokerServer.closeAllConnections(); await new Promise<void>((resolve) => brokerServer.close(() => resolve())); }
    if (jobId) await pool.query("DELETE FROM eval_jobs WHERE id = $1", [jobId]);
    if (agentId) await pool.query("DELETE FROM core_connection_owners WHERE kind = 'agent' AND resource_id = $1", [agentId]);
    if (brokerId) { await pool.query("DELETE FROM core_connection_owners WHERE kind = 'broker' AND resource_id = $1", [brokerId]); await pool.query("DELETE FROM brokers WHERE id = $1", [brokerId]); }
    if (brokerTokenId) await pool.query("DELETE FROM broker_registration_tokens WHERE id = $1", [brokerTokenId]);
    if (agentId) await pool.query("DELETE FROM eval_agents WHERE id = $1", [agentId]);
    if (tokenId) await pool.query("DELETE FROM eval_agent_tokens WHERE id = $1", [tokenId]);
    if (userId) {
      await pool.query("DELETE FROM secrets WHERE user_id = $1", [userId]);
      await pool.query("DELETE FROM web_sessions WHERE user_id = $1", [userId]);
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    }
    if (otherUserId) await pool.query("DELETE FROM users WHERE id = $1", [otherUserId]);
    if (orgs) { await orgs.pool.query(`DROP SCHEMA IF EXISTS "${orgs.schema}" CASCADE`); await orgs.pool.end(); }
  });

  it("shares one capture across A and B, arbitrates exclusive control, and detaches viewers independently", async () => {
    const base = `/api/eval-jobs/${jobId}/browser`;
    const available = await fetch(`${b.origin}${base}`, { headers: { cookie } });
    expect(available.status).toBe(200); expect(await available.json()).toMatchObject({ available: true, target: "agent" });
    const created = await post(b, `${base}/viewers`, {}, cookie); expect(created.status).toBe(200);
    const { viewerId } = await created.json();
    const second = await post(a, `${base}/viewers`, {}, cookie); expect(second.status).toBe(200);
    const otherId = (await second.json()).viewerId;
    const [firstOpen, secondOpen] = await Promise.all([
      post(a, `${base}/viewers/${viewerId}/commands`, command("viewer.open"), cookie),
      post(b, `${base}/viewers/${otherId}/commands`, command("viewer.open"), cookie),
    ]);
    expect(firstOpen.status).toBe(200); expect(secondOpen.status).toBe(200);
    expect(messages.filter((message) => message.operation.request?.command === "viewer.open")).toHaveLength(1);
    const [firstControl, secondControl] = await Promise.all([
      post(a, `${base}/viewers/${viewerId}/commands`, command("viewer.take_control", { wait_id: "wait" }), cookie).then((res) => res.json()),
      post(b, `${base}/viewers/${otherId}/commands`, command("viewer.take_control", { wait_id: "wait" }), cookie).then((res) => res.json()),
    ]);
    expect([firstControl, secondControl].filter((result) => result.ok)).toHaveLength(1);
    const controllerId = firstControl.ok ? viewerId : otherId, spectatorId = firstControl.ok ? otherId : viewerId;
    const controlId = (firstControl.ok ? firstControl : secondControl).result.control_id;
    const denied = await post(b, `${base}/viewers/${spectatorId}/commands`, command("viewer.input", { control_id: controlId, sequence: 1, input: {} }), cookie);
    expect(await denied.json()).toMatchObject({ ok: false, error: "CONTROL_REQUIRED" });
    expect((await fetch(`${b.origin}${base}/viewers/${viewerId}/frame`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${a.origin}${base}/viewers/${otherId}/frame`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${a.origin}${base}/viewers/${controllerId}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    await until(async () => messages.some((message) => message.operation.request?.command === "viewer.release_control"));
    expect(messages.filter((message) => message.operation.action === "close")).toHaveLength(0);
    expect((await fetch(`${b.origin}${base}/viewers/${spectatorId}/frame`, { headers: { cookie } })).status).toBe(200);
    const handoff = await post(a, `${base}/viewers/${spectatorId}/commands`, command("viewer.take_control", { wait_id: status.assistance.wait_id }), cookie);
    expect(await handoff.json()).toMatchObject({ ok: true, viewer: { controller: "you", count: 1 } });
    expect((await fetch(`${b.origin}${base}/viewers/${spectatorId}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    await until(async () => messages.some((message) => message.operation.action === "close"));
    expect(messages.filter((message) => message.operation.action === "close")).toHaveLength(1);
    expect((await fetch(`${b.origin}${base}/viewers/${viewerId}/frame`, { headers: { cookie } })).status).toBe(410);
  });

  it("denies both parties in an admitted borrowed personal run, including direct owner-Core requests", async () => {
    const base = `/api/eval-jobs/${jobId}/browser`, scopeKey = `user:${userId}`;
    const store = new PgBrowserViewers(pool);
    const originalTier = (await storage.getEvalJob(jobId))!.targetTier;
    const otherCookie = (await post(b, "/test/login", { userId: otherUserId })).headers.get("set-cookie")!.split(";")[0];
    const borrowed = { ...snapshot(), credentialTrial: { callerId: otherUserId, scopeKey } };
    borrowed.evalFlow.visibility = "public";
    try {
      await pool.query("INSERT INTO credential_trial_policies (scope_key, enabled, max_runs_30_days) VALUES ($1,true,10)", [scopeKey]);
      await pool.query("INSERT INTO credential_trial_usage (scope_key, caller_id, request_key, job_id) VALUES ($1,$2,$3,$4)", [scopeKey, otherUserId, randomUUID(), jobId]);
      await pool.query("UPDATE eval_jobs SET created_by = $2, snapshot = $3, target_tier = 'public' WHERE id = $1", [jobId, otherUserId, borrowed]);
      const borrowedJob = (await storage.getEvalJob(jobId))!;
      expect(await jobMayUseCredentials(borrowedJob)).toBe(true);
      const frames = messages.filter((message) => message.operation.action === "frame").length;
      const opens = messages.filter((message) => message.operation.request?.command === "viewer.open").length;
      for (const core of [a, b]) for (const sessionCookie of [cookie, otherCookie]) {
        expect((await fetch(`${core.origin}${base}`, { headers: { cookie: sessionCookie } })).status).toBe(403);
        expect((await post(core, `${base}/viewers`, {}, sessionCookie)).status).toBe(403);
      }
      const owner = (await directory.find("agent", agentId))!;
      const startedAt = borrowedJob.startedAt!.toISOString();
      const target = { key: `agent:${agentId}:${lease}:${jobId}:${startedAt}:${owner.generation}`,
        kind: "agent" as const, agentId, leaseId: lease, jobId, startedAt, generation: owner.generation };
      // Simulate grants admitted by a stale receiving Core; the owner must reject them independently.
      const caller = new CoreRouting(directory, b.origin, routingSecret);
      for (const viewerUserId of [userId, otherUserId]) for (const action of ["command", "frame"] as const) {
        const grant = { id: randomUUID(), userId: viewerUserId, jobId, target };
        expect(await store.create(grant)).toBe(true);
        await expect(caller.request(owner, { channel: "browser-viewer", targetKey: target.key, viewerId: grant.id, action,
          ...(action === "command" ? { request: command("viewer.open") } : {}) })).rejects.toThrow(/unavailable/);
        expect(await store.get(grant.id)).toBeNull();
      }
      expect(messages.filter((message) => message.operation.action === "frame")).toHaveLength(frames);
      expect(messages.filter((message) => message.operation.request?.command === "viewer.open")).toHaveLength(opens);
    } finally {
      await pool.query("UPDATE eval_jobs SET created_by = $2, snapshot = $3, target_tier = $4 WHERE id = $1", [jobId, userId, snapshot(), originalTier]);
      await pool.query("DELETE FROM credential_trial_usage WHERE job_id = $1", [jobId]);
      await pool.query("DELETE FROM credential_trial_policies WHERE scope_key = $1", [scopeKey]);
      await store.removeJob(jobId);
    }
  });

  it("revokes existing views across replicas when an agent becomes third-party Shared despite session consent", async () => {
    const base = `/api/eval-jobs/${jobId}/browser`, store = new PgBrowserViewers(pool);
    const viewerIds: string[] = [];
    try {
      for (const core of [a, b]) {
        const created = await post(core, `${base}/viewers`, {}, cookie); expect(created.status).toBe(200);
        const { viewerId } = await created.json(); viewerIds.push(viewerId);
        expect(await (await post(core, `${base}/viewers/${viewerId}/commands`, command("viewer.open"), cookie)).json()).toMatchObject({ ok: true });
      }
      expect((await fetch(`${b.origin}${base}/viewers/${viewerIds[0]}/frame`, { headers: { cookie } })).status).toBe(200);
      const frames = messages.filter((message) => message.operation.action === "frame").length;
      const inputs = messages.filter((message) => message.operation.request?.command === "viewer.input").length;
      await pool.query("UPDATE eval_jobs SET snapshot = $2 WHERE id = $1", [jobId, { ...snapshot(), credentialConsent: true }]);
      await pool.query("UPDATE eval_agent_tokens SET created_by = $2, dispatch_tier = 'shared' WHERE id = $1", [tokenId, otherUserId]);
      expect((await fetch(`${b.origin}${base}/viewers/${viewerIds[0]}/frame`, { headers: { cookie } })).status).toBe(410);
      expect((await post(a, `${base}/viewers/${viewerIds[1]}/commands`, command("viewer.input", { sequence: 1, input: {} }), cookie)).status).toBe(410);
      expect(await store.get(viewerIds[0])).toBeNull();
      expect(await store.get(viewerIds[1])).toBeNull();
      for (const core of [a, b]) {
        expect(await (await fetch(`${core.origin}${base}`, { headers: { cookie } })).json()).toMatchObject({ available: false });
        expect((await post(core, `${base}/viewers`, {}, cookie)).status).toBe(503);
      }
      expect(messages.filter((message) => message.operation.action === "frame")).toHaveLength(frames);
      expect(messages.filter((message) => message.operation.request?.command === "viewer.input")).toHaveLength(inputs);
    } finally {
      for (const viewerId of viewerIds) await fetch(`${b.origin}${base}/viewers/${viewerId}`, { method: "DELETE", headers: { cookie } });
      await store.removeJob(jobId);
      await pool.query("UPDATE eval_jobs SET snapshot = $2 WHERE id = $1", [jobId, snapshot()]);
      await pool.query("UPDATE eval_agent_tokens SET created_by = $2, dispatch_tier = 'private' WHERE id = $1", [tokenId, userId]);
    }
  });

  it("allows exact-org managers, denies the member launcher, and releases a demoted controller across replicas", async () => {
    const base = `/api/eval-jobs/${jobId}/browser`;
    const org = await orgs.provider.createOrganization({ name: `browser-${stamp}` }, { userId: otherUserId });
    await orgs.provider.addMember(org.id, userId, "member");
    const orgSnapshot = snapshot(org.id);
    const managerCookie = (await post(a, "/test/login", { userId: otherUserId })).headers.get("set-cookie")!.split(";")[0];
    const viewerIds: { id: string; cookie: string }[] = [];
    try {
      await pool.query("UPDATE eval_agent_tokens SET dispatch_tier = 'team' WHERE id = $1", [tokenId]);
      await pool.query("UPDATE eval_jobs SET snapshot = $2 WHERE id = $1", [jobId, orgSnapshot]);
      expect((await fetch(`${b.origin}${base}`, { headers: { cookie } })).status).toBe(403);
      expect((await post(a, `${base}/viewers`, {}, cookie)).status).toBe(403);
      for (const role of ["owner", "admin"] as const) {
        await orgs.provider.setMemberRole(org.id, otherUserId, role);
        expect((await fetch(`${b.origin}${base}`, { headers: { cookie: managerCookie } })).status).toBe(200);
      }
      const first = await post(b, `${base}/viewers`, {}, managerCookie); expect(first.status).toBe(200);
      const controller = (await first.json()).viewerId; viewerIds.push({ id: controller, cookie: managerCookie });
      expect(await (await post(a, `${base}/viewers/${controller}/commands`, command("viewer.open"), managerCookie)).json()).toMatchObject({ ok: true });
      const control = await (await post(b, `${base}/viewers/${controller}/commands`, command("viewer.take_control", { wait_id: status.assistance.wait_id }), managerCookie)).json();
      expect(control).toMatchObject({ ok: true });
      await orgs.provider.setMemberRole(org.id, userId, "admin");
      const second = await post(a, `${base}/viewers`, {}, cookie); expect(second.status).toBe(200);
      const spectator = (await second.json()).viewerId; viewerIds.push({ id: spectator, cookie });
      expect(await (await post(b, `${base}/viewers/${spectator}/commands`, command("viewer.open"), cookie)).json()).toMatchObject({ ok: true, viewer: { controller: "other" } });
      const inputs = messages.filter((message) => message.operation.request?.command === "viewer.input").length;
      const frames = messages.filter((message) => message.operation.action === "frame").length;
      const releases = messages.filter((message) => message.operation.request?.command === "viewer.release_control").length;
      const closes = messages.filter((message) => message.operation.action === "close").length;
      await orgs.provider.setMemberRole(org.id, otherUserId, "member");
      const owner = (await directory.find("agent", agentId))!;
      const grant = await new PgBrowserViewers(pool).get(controller);
      if (grant) {
        const caller = new CoreRouting(directory, b.origin, routingSecret);
        await expect(caller.request(owner, { channel: "browser-viewer", targetKey: grant.target.key, viewerId: controller,
          action: "command", request: command("viewer.input", { control_id: control.result.control_id, sequence: 1, input: {} }) })).rejects.toThrow(/unavailable/);
      }
      expect((await post(a, `${base}/viewers`, {}, managerCookie)).status).toBe(403);
      const response = await post(b, `${base}/viewers/${spectator}/commands`, command("session.status"), cookie);
      expect(await response.json()).toMatchObject({ ok: true, viewer: { count: 1, controller: null } });
      expect(messages.filter((message) => message.operation.request?.command === "viewer.input")).toHaveLength(inputs);
      expect(messages.filter((message) => message.operation.action === "frame")).toHaveLength(frames);
      expect(messages.filter((message) => message.operation.request?.command === "viewer.release_control")).toHaveLength(releases + 1);
      expect(messages.filter((message) => message.operation.action === "close")).toHaveLength(closes);
    } finally {
      for (const viewer of viewerIds) await fetch(`${b.origin}${base}/viewers/${viewer.id}`, { method: "DELETE", headers: { cookie: viewer.cookie } });
      await pool.query("UPDATE eval_jobs SET snapshot = $2 WHERE id = $1", [jobId, snapshot()]);
      await pool.query("UPDATE eval_agent_tokens SET dispatch_tier = 'private' WHERE id = $1", [tokenId]);
    }
  });

  it("a same-lease reconnect to B invalidates old viewer grants and stale A cleanup cannot delete B", async () => {
    const base = `/api/eval-jobs/${jobId}/browser`, oldOwner = await directory.find("agent", agentId);
    const { viewerId } = await (await post(b, `${base}/viewers`, {}, cookie)).json();
    await connect(b);
    const newOwner = await directory.find("agent", agentId); expect(newOwner!.generation).not.toBe(oldOwner!.generation);
    await directory.release(oldOwner!); expect((await directory.find("agent", agentId))?.coreId).toBe(b.id);
    expect((await fetch(`${a.origin}${base}/viewers/${viewerId}/frame`, { headers: { cookie } })).status).toBe(410);
    const reopened = await post(a, `${base}/viewers`, {}, cookie); expect(reopened.status).toBe(200);
    const fresh = (await reopened.json()).viewerId;
    expect((await fetch(`${b.origin}${base}/viewers/${fresh}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
  });

  it("atomically bounds concurrent viewers across replicas and expired grants cannot be renewed", async () => {
    const storeA = new PgBrowserViewers(pool), storeB = new PgBrowserViewers(pool);
    const target = { key: `test-exclusive-${stamp}`, kind: "agent" as const, agentId, leaseId: lease, jobId, startedAt: new Date().toISOString(), generation: randomUUID() };
    const first = { id: randomUUID(), userId, jobId, target }, second = { ...first, id: randomUUID() };
    const admitted = await Promise.all([storeA.create(first), storeB.create(second)]); expect(admitted).toEqual([true, true]);
    const more = Array.from({ length: 9 }, () => ({ ...first, id: randomUUID() }));
    expect((await Promise.all(more.map((grant) => storeA.create(grant)))).filter(Boolean)).toHaveLength(8);
    const current = first;
    expect(await storeB.get(current.id)).toEqual(current);
    await pool.query("UPDATE browser_viewer_grants SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [current.id]);
    expect(await storeA.touch(current)).toBe(false); expect(await storeB.get(current.id)).toBeNull();
    await storeB.expire();
    await pool.query("DELETE FROM browser_viewer_grants WHERE target_key = $1", [target.key]);
  });

  it("an expired controller is released by the owner without closing another Core's spectator", async () => {
    const base = `/api/eval-jobs/${jobId}/browser`;
    const first = (await (await post(a, `${base}/viewers`, {}, cookie)).json()).viewerId;
    const second = (await (await post(b, `${base}/viewers`, {}, cookie)).json()).viewerId;
    for (const viewer of [first, second]) expect((await post(a, `${base}/viewers/${viewer}/commands`, command("viewer.open"), cookie)).status).toBe(200);
    expect(await (await post(b, `${base}/viewers/${first}/commands`, command("viewer.take_control", { wait_id: status.assistance.wait_id }), cookie)).json()).toMatchObject({ ok: true });
    const closes = messages.filter((message) => message.operation.action === "close").length;
    const releases = messages.filter((message) => message.operation.request?.command === "viewer.release_control").length;
    await pool.query("UPDATE browser_viewer_grants SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [first]);
    const response = await post(a, `${base}/viewers/${second}/commands`, command("session.status"), cookie);
    expect(await response.json()).toMatchObject({ ok: true, viewer: { count: 1, controller: null } });
    expect(messages.filter((message) => message.operation.request?.command === "viewer.release_control")).toHaveLength(releases + 1);
    expect(messages.filter((message) => message.operation.action === "close")).toHaveLength(closes);
    expect((await fetch(`${b.origin}${base}/viewers/${second}/frame`, { headers: { cookie } })).status).toBe(200);
    await fetch(`${b.origin}${base}/viewers/${second}`, { method: "DELETE", headers: { cookie } });
    await until(async () => messages.filter((message) => message.operation.action === "close").length === closes + 1);
  });

  it("revocation on one Core denies another Core's existing viewer without sending another operation", async () => {
    const base = `/api/eval-jobs/${jobId}/browser`;
    const opened = await post(a, `${base}/viewers`, {}, cookie); expect(opened.status).toBe(200);
    const { viewerId } = await opened.json();
    await pool.query("UPDATE eval_agent_tokens SET is_revoked = true WHERE id = $1", [tokenId]);
    const before = messages.filter((message) => message.operation.action === "frame").length;
    expect((await fetch(`${b.origin}${base}/viewers/${viewerId}/frame`, { headers: { cookie } })).status).toBe(410);
    expect(messages.filter((message) => message.operation.action === "frame")).toHaveLength(before);
    await pool.query("UPDATE eval_agent_tokens SET is_revoked = false WHERE id = $1", [tokenId]);
  });

  it("broker registration owned by A remains available to B, including mint and the actual login browser", async () => {
    brokerServer = createServer(async (req, res) => {
      let body = ""; for await (const chunk of req) body += chunk;
      expect(req.headers.authorization).toBe("Bearer broker-private-key"); brokerCalls.push({ path: req.url, body: JSON.parse(body) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/mint" ? { storageState: { cookies: [] } } : { result: engineResult(JSON.parse(body)) }));
    });
    await new Promise<void>((resolve) => brokerServer.listen(0, "127.0.0.1", resolve));
    const brokerUrl = `http://127.0.0.1:${(brokerServer.address() as { port: number }).port}`;
    brokerTokenId = (await storage.createBrokerRegistrationToken({ name: `multi-${stamp}`, tokenHash: hashToken(randomUUID()), createdBy: userId })).id;
    const brokerLease = randomUUID(); brokerId = (await storage.createBroker({ name: `multi-${stamp}`, tokenId: brokerTokenId, brokerType: "auth-session", url: brokerUrl, currentLeaseId: brokerLease, state: "busy", lastSeenAt: new Date() })).id;
    expect((await post(a, "/test/broker", { id: brokerId, leaseId: brokerLease, secret: "broker-private-key" })).status).toBe(200);
    expect(await (await fetch(`${b.origin}/test/broker/${brokerId}`)).json()).toEqual({ available: true });
    expect((await post(b, `/test/broker/${brokerId}/mint`, { email: "fixture@example.com", password: "fixture-password" })).status).toBe(200);
    const need = { platformId: `multi-${stamp}`, emailSecret: "EMAIL", passwordSecret: "PASSWORD" };
    await storage.createOrUpdateSecret(userId, "EMAIL", encryptValue("fixture@example.com"), { brokerType: "auth-session" });
    await storage.createOrUpdateSecret(userId, "PASSWORD", encryptValue("fixture-password"), { brokerType: "auth-session" });
    const mint = await storage.claimWebSessionMint({ userId }, need.platformId, credentialKeyFor(need), 230, 300);
    await storage.setWebSessionBrowserTarget(mint!.id, mint!.mintStartedAt!, brokerId, randomUUID(), new Date(Date.now() + 60000));
    await pool.query("UPDATE eval_jobs SET snapshot = $2 WHERE id = $1", [jobId, { ...snapshot(), sessionInjection: need }]);
    const response = await fetch(`${b.origin}/api/eval-jobs/${jobId}/browser`, { headers: { cookie } });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ available: true, target: "broker" });
    expect(brokerCalls.map((call) => call.path)).toEqual(["/mint", "/browser"]);
    const base = `/api/eval-jobs/${jobId}/browser`;
    const first = (await (await post(a, `${base}/viewers`, {}, cookie)).json()).viewerId;
    const second = (await (await post(b, `${base}/viewers`, {}, cookie)).json()).viewerId;
    const opened = await Promise.all([first, second].map((viewer) => post(b, `${base}/viewers/${viewer}/commands`, command("viewer.open"), cookie).then((res) => res.json())));
    expect(opened.every((result) => result.ok && result.viewer.count === 2)).toBe(true);
    const browserOperations = () => brokerCalls.map((call) => call.body as BrowserOperation);
    expect(browserOperations().filter((operation) => operation.request?.command === "viewer.open")).toHaveLength(1);
    expect((await fetch(`${a.origin}${base}/viewers/${first}/frame`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${b.origin}${base}/viewers/${second}/frame`, { headers: { cookie } })).status).toBe(200);
    await fetch(`${a.origin}${base}/viewers/${first}`, { method: "DELETE", headers: { cookie } });
    expect(browserOperations().filter((operation) => operation.action === "close")).toHaveLength(0);
    await fetch(`${b.origin}${base}/viewers/${second}`, { method: "DELETE", headers: { cookie } });
    await until(async () => browserOperations().some((operation) => operation.action === "close"));
    const persisted = await pool.query("SELECT row_to_json(o)::text AS value FROM core_connection_owners o WHERE kind = 'broker' AND resource_id = $1", [brokerId]);
    expect(persisted.rows[0].value).not.toMatch(/broker-private-key|fixture-password|fixture@example/);
    await pool.query("UPDATE eval_jobs SET snapshot = $2 WHERE id = $1", [jobId, snapshot()]);
  });

  it("expired ownership and stale business leases cannot be renewed or used", async () => {
    const old = (await directory.find("agent", agentId))!;
    await pool.query("UPDATE core_connection_owners SET expires_at = clock_timestamp() - interval '1 second' WHERE kind = 'agent' AND resource_id = $1", [agentId]);
    expect(await directory.renew(old)).toBe(false); expect(await directory.find("agent", agentId)).toBeNull();
    await connect(b);
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("UPDATE eval_agents SET current_lease_id = $2 WHERE id = $1", [agentId, randomUUID()]);
      const staleClaim = directory.claim({ ...old, generation: randomUUID() } as CoreOwner);
      await writer.query("COMMIT");
      expect(await staleClaim).toBe(false);
    } finally { await writer.query("ROLLBACK"); writer.release(); }
    expect(await directory.find("agent", agentId)).toBeNull();
    const nonce = randomUUID();
    expect((await Promise.all([directory.acceptNonce(nonce), new PgCoreDirectory(pool).acceptNonce(nonce)])).filter(Boolean)).toHaveLength(1);
  });
});
