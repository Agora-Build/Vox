import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import express from "express";
import session from "express-session";
import request from "supertest";
import type { LoadedPlugins } from "../server/plugins/loader";
import type { VoxPlugin, VoxPluginContext, WorkerSpec } from "@vox/plugin-sdk";
import type { RuleDefinition } from "../plugins/notifications/configuration";

const mocks = vi.hoisted(() => ({ mail: vi.fn(async () => ({})) }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: mocks.mail }) } }));
const integration = process.env.TEST_NOTIFICATIONS_DATABASE_URL ? describe : describe.skip;
integration("notification channels, scopes and automation", () => {
  const savedEnv = { ...process.env };
  let core: typeof import("../server/storage");
  let loader: typeof import("../server/plugins/loader");
  let directory: typeof import("../server/personal-entitlements");
  let notificationData: typeof import("../server/notification-data");
  let loaded: LoadedPlugins;
  let app: express.Express;
  let admin: ReturnType<typeof request.agent>;
  let scout: ReturnType<typeof request.agent>;
  let member: ReturnType<typeof request.agent>;
  let adminId: number;
  let scoutId: number;
  let memberId: number;
  const workers = new Map<string, WorkerSpec>();
  let pluginContext: VoxPluginContext;
  const path = "/api/plugins/notifications";

  async function user(isAdmin = false, plan: "basic" | "principal" = "basic") {
    return core.storage.createUser({ username: `notify-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@notification.test`, passwordHash: null, plan, isAdmin, isEnabled: true, emailVerifiedAt: new Date() });
  }
  async function signin(userId: number) {
    const agent = request.agent(app);
    await agent.post("/test/signin").send({ userId }).expect(200);
    return agent;
  }
  async function group(userIds = [scoutId, memberId]) {
    return (await admin.post(`${path}/groups`).send({ name: "Selected audience", userIds }).expect(201)).body.id as string;
  }
  async function grant(groupIds: string[] = [], canScript = false, canLlm = false) {
    await admin.post(`${path}/access`).send({ userId: scoutId, canEdit: true, canScript, canLlm, groupIds }).expect(200);
  }
  async function channel(agent = scout, groupId: string | null = null) {
    return (await agent.post(`${path}/channels`).send({ name: "Account email", kind: "email", groupId }).expect(201)).body.id as string;
  }
  function definition(channelId: string, audience: RuleDefinition["audience"] = { type: "user", userId: scoutId }): RuleDefinition {
    return { name: "Low balance", audience, condition: { type: "compare", metric: "credits.available", operator: "<", value: 125 }, channelIds: [channelId], subject: "Vox: {{rule}}", message: "{{username}}: {{credits.available}} credits. {{result}}", intervalSeconds: 60, cooldownSeconds: 300, enabled: true };
  }
  async function createRule(input: RuleDefinition, agent = scout) {
    return (await agent.post(`${path}/rules`).send(input).expect(201)).body.id as string;
  }
  const tick = (id: string) => workers.get(`notifications:${id}`)!.run();
  const credits = () => loaded.services.require<{ deposit(input: { userId: number; credits: number; reason: string; idempotencyKey: string }): Promise<unknown>; getBalance(userId: number): Promise<number> }>("vox.credits", "^1.0.0");

  beforeAll(async () => {
    const url = new URL(process.env.TEST_NOTIFICATIONS_DATABASE_URL!);
    if (url.pathname !== "/vox_notifications_test" || !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Refusing non-isolated notification test database");
    process.env.DATABASE_URL = url.toString();
    process.env.CREDENTIAL_ENCRYPTION_KEY = "11".repeat(32);
    process.env.SMTP_HOST = "mock-smtp.invalid";
    process.env.NOTIFICATIONS_FROM = "vox@notification.test";
    process.env.VOX_PLUGINS = "credits,notifications";
    process.env.NOTIFICATIONS_LLM_PROVIDER = "anthropic";
    process.env.NOTIFICATIONS_LLM_MODEL = "local-test-model";
    process.env.NOTIFICATIONS_LLM_API_KEY = "local-test-only";
    process.env.NOTIFICATIONS_LLM_DAILY_LIMIT = "2";
    core = await import("../server/storage");
    directory = await import("../server/personal-entitlements");
    notificationData = await import("../server/notification-data");
    loader = await import("../server/plugins/loader");
  });
  beforeEach(async () => {
    if (loaded) await loaded.shutdown();
    vi.unstubAllGlobals(); mocks.mail.mockReset().mockResolvedValue({}); workers.clear();
    process.env.VOX_PLUGINS = "credits,notifications";
    app = express(); app.use(express.json());
    app.use(session({ secret: "isolated-notification-session", resave: false, saveUninitialized: false }));
    app.post("/test/signin", (req, res) => { req.session.userId = req.body.userId; res.json({ ok: true }); });
    const builtins = (await import("../plugins")).BUILTIN_PLUGINS;
    const wrapped: Record<string, VoxPlugin> = {};
    for (const id of ["credits", "notifications"]) wrapped[id] = { async activate(ctx) {
      if (id === "notifications") pluginContext = ctx;
      await builtins[id].activate({ ...ctx, worker: (spec) => { workers.set(`${id}:${spec.id}`, spec); } });
    } };
    loaded = await loader.loadPlugins(app, core.pool, wrapped, "./plugins", {
      "vox.users": { version: "1.0.0", impl: directory.userDirectoryService },
      "vox.verification": { version: "1.0.0", impl: { consume: async () => crypto.randomUUID() } },
      "vox.encryption": { version: "1.0.0", impl: { configured: core.isEncryptionConfigured, encrypt: core.encryptValue, decrypt: core.decryptValue } },
      "vox.notification-data": { version: "1.0.0", impl: notificationData.notificationDataService },
    });
    await core.pool.query("TRUNCATE plugin_notifications.deliveries,plugin_notifications.editor_permissions,plugin_notifications.audience_groups,plugin_notifications.channels,plugin_notifications.rules,plugin_notifications.rule_states,plugin_notifications.events,plugin_notifications.audit_log,plugin_notifications.llm_daily_budget CASCADE");
    adminId = (await user(true, "principal")).id; scoutId = (await user(false, "principal")).id; memberId = (await user()).id;
    admin = await signin(adminId); scout = await signin(scoutId); member = await signin(memberId);
  });
  afterAll(async () => {
    if (loaded) await loaded.shutdown();
    if (core) await core.pool.end();
    vi.unstubAllGlobals(); process.env = savedEnv;
  });

  it("does not infer Scout access from a paid tier, but permits personal destination preferences", async () => {
    expect((await scout.get(`${path}/settings`)).body.permission.canEdit).toBe(false);
    const id = await channel();
    await scout.post(`${path}/rules`).send(definition(id)).expect(403);
    await scout.post(`${path}/access`).send({}).expect(403);
    await scout.post(`${path}/groups`).send({}).expect(403);
    await request(app).get(`${path}/channels`).expect(401);
  });
  it("encrypts Discord destinations, never returns credentials, and rejects SSRF targets", async () => {
    const webhookUrl = `https://discord.com/api/webhooks/12345678901234567890/${"x".repeat(80)}`;
    const result = await scout.post(`${path}/channels`).send({ name: "Discord", kind: "discord", webhookUrl }).expect(201);
    const stored = (await core.pool.query("SELECT destination_ciphertext FROM plugin_notifications.channels WHERE id=$1", [result.body.id])).rows[0];
    expect(stored.destination_ciphertext).not.toContain(webhookUrl);
    expect(JSON.stringify((await scout.get(`${path}/channels`)).body)).not.toContain("destination_ciphertext");
    await scout.post(`${path}/channels`).send({ name: "Private network", kind: "discord", webhookUrl: "https://127.0.0.1/admin" }).expect(400);
    const mine = (await scout.get(`${path}/channels`)).body[0];
    await member.patch(`${path}/channels/${mine.id}`).send({ revision: mine.revision, name: "Steal", enabled: false }).expect(403);
  });
  it("limits editors to assigned groups and separately gates scripts and LLM rules", async () => {
    const allowed = await group(); const other = await group([memberId]);
    await grant([allowed]);
    const id = await channel(scout, allowed);
    await scout.post(`${path}/channels`).send({ name: "Other group", kind: "email", groupId: other }).expect(403);
    const rule = definition(id, { type: "group", groupId: allowed });
    await createRule(rule);
    await scout.post(`${path}/rules`).send({ ...rule, audience: { type: "group", groupId: other } }).expect(403);
    await scout.post(`${path}/rules`).send({ ...rule, condition: { type: "javascript", code: "return true;" } }).expect(403);
    await scout.post(`${path}/rules`).send({ ...rule, intervalSeconds: 900, condition: { type: "llm", prompt: "Analyze the numeric data." } }).expect(403);
  });
  it("does not allow a rule to route another audience's data to an unrelated channel", async () => {
    await grant();
    const unrelated = await channel(member);
    await scout.post(`${path}/rules`).send(definition(unrelated)).expect(403);
    const mine = await channel();
    await scout.post(`${path}/rules`).send(definition(mine, { type: "user", userId: memberId })).expect(403);
  });
  it("previews without sending or persisting a trigger", async () => {
    await grant(); const input = definition(await channel());
    const preview = await scout.post(`${path}/preview`).send(input).expect(200);
    expect(preview.body).toMatchObject({ matched: true, subjectId: scoutId });
    expect(mocks.mail).not.toHaveBeenCalled();
    expect((await scout.get(`${path}/activity`)).body).toHaveLength(0);
  });
  it("evaluates group rules per user and deduplicates unchanged data and cooldown repeats", async () => {
    const groupId = await group(); await grant([groupId]);
    await credits().deposit({ userId: memberId, credits: 50, reason: "Existing credits", idempotencyKey: crypto.randomUUID() });
    const id = await createRule(definition(await channel(scout, groupId), { type: "group", groupId }));
    await tick("rules"); await tick("rules"); await tick("delivery");
    expect(mocks.mail).toHaveBeenCalledTimes(1);
    expect(mocks.mail.mock.calls[0][0]).toMatchObject({ to: (await core.storage.getUser(scoutId))!.email });
    await core.pool.query("UPDATE plugin_notifications.rule_states SET due_at=now()-interval '1 second' WHERE rule_id=$1", [id]);
    await tick("rules"); await tick("rules");
    expect((await core.pool.query("SELECT * FROM plugin_notifications.events WHERE rule_id=$1", [id])).rows).toHaveLength(1);
    await credits().deposit({ userId: scoutId, credits: 1, reason: "Change within cooldown", idempotencyKey: crypto.randomUUID() });
    await core.pool.query("UPDATE plugin_notifications.rule_states SET due_at=now()-interval '1 second' WHERE rule_id=$1 AND subject_ref=$2", [id, scoutId]);
    await tick("rules");
    expect((await core.pool.query("SELECT * FROM plugin_notifications.events WHERE rule_id=$1", [id])).rows).toHaveLength(1);
    await credits().deposit({ userId: scoutId, credits: 1, reason: "Change after cooldown", idempotencyKey: crypto.randomUUID() });
    await core.pool.query("UPDATE plugin_notifications.rule_states SET due_at=now()-interval '1 second',last_fired_at=now()-interval '1 hour' WHERE rule_id=$1 AND subject_ref=$2", [id, scoutId]);
    await tick("rules");
    expect((await core.pool.query("SELECT * FROM plugin_notifications.events WHERE rule_id=$1", [id])).rows).toHaveLength(2);
  });
  it("cancels queued alerts after permission revocation or rule/channel changes", async () => {
    await grant(); const input = definition(await channel()); await createRule(input); await tick("rules");
    await admin.post(`${path}/access`).send({ userId: scoutId, canEdit: false, canScript: false, canLlm: false, groupIds: [] }).expect(200);
    await tick("delivery");
    expect(mocks.mail).not.toHaveBeenCalled();
    expect((await core.pool.query("SELECT status,payload_ciphertext FROM plugin_notifications.deliveries")).rows).toEqual([{ status: "expired", payload_ciphertext: null }]);
  });
  it("removes audience members and cancels their queued messages", async () => {
    const groupId = await group(); await grant([groupId]);
    const id = await createRule(definition(await channel(scout, groupId), { type: "group", groupId }));
    await tick("rules");
    await admin.patch(`${path}/groups/${groupId}`).send({ name: "Only remaining member", userIds: [memberId] }).expect(200);
    expect((await core.pool.query("SELECT subject_ref FROM plugin_notifications.rule_states WHERE rule_id=$1", [id])).rows).toEqual([{ subject_ref: memberId }]);
    await tick("delivery"); expect(mocks.mail).not.toHaveBeenCalled();
  });
  it("prevents stale edits from overwriting a rule and suppresses stale queued revisions", async () => {
    await grant(); const input = definition(await channel()); const id = await createRule(input);
    await tick("rules");
    const rule = (await scout.get(`${path}/rules`)).body[0];
    await scout.patch(`${path}/rules/${id}`).send({ revision: rule.revision, definition: { ...input, enabled: false } }).expect(200);
    await scout.patch(`${path}/rules/${id}`).send({ revision: rule.revision, definition: input }).expect(409);
    await tick("delivery"); expect(mocks.mail).not.toHaveBeenCalled();
  });
  it("uses isolated JavaScript calculations with real personal data", async () => {
    await grant([], true); const input = definition(await channel());
    input.condition = { type: "javascript", code: 'return {matched: loadData().metrics["credits.available"] === 100, summary: "Script matched"};' };
    await createRule(input); await tick("rules"); await tick("delivery");
    expect(mocks.mail).toHaveBeenCalledTimes(1);
    expect((await scout.get(`${path}/activity`)).body[0].summary).toBe("Script matched");
  });
  it("bounds LLM spending, validates structured results, and sends only numeric data", async () => {
    await grant([], false, true);
    const remote = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ matched: true, summary: "Provider result" }) }] }), { status: 200 }));
    vi.stubGlobal("fetch", remote);
    const input = { ...definition(await channel()), intervalSeconds: 900, condition: { type: "llm" as const, prompt: "Analyze the numeric data." } };
    await scout.post(`${path}/preview`).send(input).expect(200);
    await scout.post(`${path}/preview`).send(input).expect(200);
    await scout.post(`${path}/preview`).send(input).expect(429);
    expect(remote).toHaveBeenCalledTimes(2);
    const body = JSON.parse(remote.mock.calls[0][1].body as string);
    expect(body.max_tokens).toBe(256);
    expect(body.messages[0].content).not.toContain((await core.storage.getUser(scoutId))!.email);
    expect(body.messages[0].content).not.toContain((await core.storage.getUser(scoutId))!.username);
  });
  it("posts Discord without mentions or redirects and scrubs the payload", async () => {
    await grant();
    const remote = vi.fn(async () => new Response(null, { status: 204 })); vi.stubGlobal("fetch", remote);
    const result = await scout.post(`${path}/channels`).send({ name: "Discord alerts", kind: "discord", webhookUrl: `https://discord.com/api/webhooks/12345678901234567890/${"x".repeat(80)}` }).expect(201);
    await createRule(definition(result.body.id)); await tick("rules"); await tick("delivery");
    expect(remote).toHaveBeenCalledTimes(1);
    expect(remote.mock.calls[0][1]).toMatchObject({ redirect: "error" });
    expect(JSON.parse(remote.mock.calls[0][1].body as string).allowed_mentions).toEqual({ parse: [] });
    expect((await core.pool.query("SELECT payload_ciphertext,status FROM plugin_notifications.deliveries")).rows).toEqual([{ payload_ciphertext: null, status: "delivered" }]);
  });
  it("retries transient failures without holding a connection through SMTP", async () => {
    await grant(); await createRule(definition(await channel())); await tick("rules");
    mocks.mail.mockRejectedValueOnce(new Error("Sensitive SMTP details"));
    await tick("delivery");
    expect((await core.pool.query("SELECT status,attempts FROM plugin_notifications.deliveries")).rows[0]).toEqual({ status: "pending", attempts: 1 });
    await core.pool.query("UPDATE plugin_notifications.deliveries SET next_attempt_at=now()-interval '1 second'");
    mocks.mail.mockImplementationOnce(async () => { await core.pool.query("SELECT 1"); return {}; });
    await tick("delivery");
    expect((await core.pool.query("SELECT status,payload_ciphertext FROM plugin_notifications.deliveries")).rows[0]).toEqual({ status: "delivered", payload_ciphertext: null });
  });
  it("uses per-row leases to avoid duplicate effects across two workers", async () => {
    await grant(); await createRule(definition(await channel()));
    const { createAutomation } = await import("../plugins/notifications/server/automation");
    const { createAccess } = await import("../plugins/notifications/server/access");
    const { createDelivery } = await import("../plugins/notifications/server/delivery");
    const encryption = { configured: core.isEncryptionConfigured, encrypt: core.encryptValue, decrypt: core.decryptValue };
    const second = createAutomation(pluginContext, encryption, createAccess(pluginContext));
    await Promise.all([tick("rules"), second.run()]);
    expect((await core.pool.query("SELECT * FROM plugin_notifications.events")).rows).toHaveLength(1);
    const delivery = createDelivery(pluginContext, encryption, second.eligible);
    await Promise.all([tick("delivery"), delivery.deliver()]);
    expect(mocks.mail).toHaveBeenCalledTimes(1);
  });
  it("excludes organization jobs and other users from the Core personal data seam", async () => {
    await core.pool.query("INSERT INTO eval_jobs(created_by,status,kind,creator_org_id) VALUES($1,'failed','eval',NULL),($1,'failed','eval',999),($2,'failed','eval',NULL),($1,'failed','analyze',NULL)", [scoutId, memberId]);
    const snapshot = await notificationData.notificationDataService.getSnapshot(scoutId);
    expect(snapshot.metrics["jobs.failed24h"]).toBe(1);
  });
  it("pauses routes and workers when the plugin is disabled while retaining owned data", async () => {
    const id = await channel(); await loaded.shutdown();
    process.env.VOX_PLUGINS = "";
    const disabledApp = express(); const disabled = await loader.loadPlugins(disabledApp, core.pool);
    await request(disabledApp).get(`${path}/channels`).expect(404);
    expect(disabled.services.optional("vox.notifications", "^1.0.0")).toBeNull();
    expect((await core.pool.query("SELECT id FROM plugin_notifications.channels WHERE id=$1", [id])).rows).toHaveLength(1);
    await disabled.shutdown();
  });
});
