import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import express from "express";
import session from "express-session";
import request from "supertest";
import type { LoadedPlugins } from "../server/plugins/loader";

const fake = vi.hoisted(() => ({
  sessions: new Map<string, any>(), prices: new Map<string, any>(), subscriptions: new Map<string, any>(), invoices: new Map<string, any>(),
  mail: vi.fn(async () => ({})), webhook: null as any,
  failCheckoutAfterCreate: false,
}));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: fake.mail }) } }));
vi.mock("stripe", async (importOriginal) => {
  const { default: RealStripe } = await importOriginal<typeof import("stripe")>();
  fake.webhook = new RealStripe("sk_test_local_only").webhooks;
  return { default: class {
    webhooks = fake.webhook;
    customers = { create: vi.fn(async (input: any) => ({ id: `cus_${input.metadata.vox_personal_user}` })) };
    prices = { create: vi.fn(async (input: any) => { const price = { ...input, id: `price_${fake.prices.size + 1}` }; fake.prices.set(price.id, price); return price; }) };
    checkout = { sessions: {
      create: vi.fn(async (input: any) => {
        const previous = fake.sessions.get(`cs_${input.metadata.vox_purchase}`);
        if (previous) return previous;
        const price = fake.prices.get(input.line_items[0].price);
        const checkout = { ...input, id: `cs_${input.metadata.vox_purchase}`, currency: "usd", amount_total: price.unit_amount * input.line_items[0].quantity,
          payment_status: "unpaid", status: "open", url: "https://checkout.stripe.com/test" };
        fake.sessions.set(checkout.id, checkout);
        if (fake.failCheckoutAfterCreate) { fake.failCheckoutAfterCreate = false; throw new Error("Simulated connection lost after remote creation"); }
        return checkout;
      }),
      retrieve: vi.fn(async (id: string) => { if (!fake.sessions.has(id)) throw new Error("Missing session"); return fake.sessions.get(id); }),
    } };
    subscriptions = {
      retrieve: vi.fn(async (id: string) => { if (!fake.subscriptions.has(id)) throw new Error("Missing subscription"); return fake.subscriptions.get(id); }),
      list: vi.fn(async (input: any) => ({ data: Array.from(fake.subscriptions.values()).filter((sub) => sub.customer === input.customer) })),
    };
    invoices = { retrieve: vi.fn(async (id: string) => fake.invoices.get(id)) };
    billingPortal = { sessions: { create: vi.fn(async () => ({ url: "https://billing.stripe.com/test" })) } };
  } };
});

// Opt-in integration tests: never connect these fixtures to a shared/dev DB.
const integration = process.env.TEST_PERSONAL_DATABASE_URL ? describe : describe.skip;
integration("personal billing and Core verification", () => {
  let core: typeof import("../server/storage");
  let security: typeof import("../server/verification");
  let auth: typeof import("../server/auth");
  let services: typeof import("../server/personal-entitlements");
  let loader: typeof import("../server/plugins/loader");
  let loaded: LoadedPlugins;
  let app: express.Express;
  let admin: Awaited<ReturnType<typeof request.agent>>;
  let member: Awaited<ReturnType<typeof request.agent>>;
  let adminId: number;
  let memberId: number;
  let secret: string;
  const webhookSecret = "whsec_personal_local_test";
  const env = { ...process.env };

  async function makeUser(isAdmin = false, plan: "basic" | "principal" | "fellow" | "premium" = "basic") {
    return core.storage.createUser({ username: `billing-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@billing.test`,
      passwordHash: null, isAdmin, plan, isEnabled: true, emailVerifiedAt: new Date() });
  }
  async function signIn(userId: number) {
    const agent = request.agent(app);
    await agent.post("/test/signin").send({ userId }).expect(200);
    return agent;
  }
  async function approval(agent: typeof admin, action: string, payload: unknown, method = "totp", code?: string) {
    const challenge = await agent.post("/api/user/verification/challenges").send({ action, payload, method }).expect(201);
    const token = code ?? security.authenticator(secret).generate({ timestamp: Date.now() - 30_000 });
    return { initCode: auth.getInitCode(), challengeId: challenge.body.challengeId, code: token };
  }
  async function webhook(type: string, object: any, id = `evt_${crypto.randomUUID()}`) {
    const payload = JSON.stringify({ id, object: "event", type, data: { object } });
    const signature = fake.webhook.generateTestHeaderString({ payload, secret: webhookSecret });
    return request(app).post("/api/plugins/payments/webhook").set("Content-Type", "application/json").set("stripe-signature", signature).send(payload);
  }
  beforeAll(async () => {
    const target = new URL(process.env.TEST_PERSONAL_DATABASE_URL!);
    if (target.pathname !== "/vox_billing_test" || !["localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Refusing non-isolated personal billing test DB");
    process.env.DATABASE_URL = target.toString();
    process.env.CREDENTIAL_ENCRYPTION_KEY = "11".repeat(32);
    process.env.STRIPE_SECRET_KEY = "sk_test_local_only";
    process.env.STRIPE_PERSONAL_WEBHOOK_SECRET = webhookSecret;
    process.env.SMTP_HOST = "mock-smtp.invalid";
    process.env.NOTIFICATIONS_FROM = "vox@billing.test";
    process.env.VOX_PLUGINS = "credits,payments,notifications";
    process.env.APP_URL = "https://billing.test";
    core = await import("../server/storage"); security = await import("../server/verification"); auth = await import("../server/auth");
    services = await import("../server/personal-entitlements"); loader = await import("../server/plugins/loader");
  });
  beforeEach(async () => {
    if (loaded) await loaded.shutdown();
    fake.mail.mockClear();
    app = express();
    app.use(express.json({ verify(req, _res, buf) { (req as any).rawBody = buf; } }));
    app.use(session({ secret: "personal-test-session", resave: false, saveUninitialized: false }));
    app.post("/test/signin", (req, res) => { req.session.userId = req.body.userId; res.json({ ok: true }); });
    security.registerVerificationRoutes(app);
    loaded = await loader.loadPlugins(app, core.pool, undefined, undefined, {
      "vox.identity": { version: "1.0.0", impl: (await import("../server/identity")).identityService },
      "vox.users": { version: "1.0.0", impl: services.userDirectoryService },
      "vox.verification": { version: "1.0.0", impl: security.verificationService },
      "vox.personal-entitlements": { version: "1.0.0", impl: services.personalEntitlementsService },
      "vox.encryption": { version: "1.0.0", impl: { configured: core.isEncryptionConfigured, encrypt: core.encryptValue, decrypt: core.decryptValue } },
    });
    security.setVerificationNotifications(loaded.services.optional("vox.notifications", "^1.0.0"));
    adminId = (await makeUser(true, "principal")).id; memberId = (await makeUser()).id;
    admin = await signIn(adminId); member = await signIn(memberId);
    secret = "JBSWY3DPEHPK3PXP";
    await core.pool.query("INSERT INTO user_verification_factors(user_id,encrypted_secret,enabled) VALUES($1,$2,true)", [adminId, core.encryptValue(secret)]);
  });
  afterAll(async () => {
    if (loaded) await loaded.shutdown();
    if (core) await core.pool.end();
    process.env = env;
  });

  it("grants exactly one welcome deposit without replacing existing credits", async () => {
    const credits = loaded.services.require<any>("vox.credits", "^1.0.0");
    await credits.deposit({ userId: memberId, credits: 40, reason: "existing", idempotencyKey: crypto.randomUUID() });
    const balances = await Promise.all(Array.from({ length: 5 }, () => member.get("/api/plugins/credits/balance")));
    expect(balances.every((response) => response.body.credits === 140)).toBe(true);
    const welcome = await core.pool.query("SELECT count(*)::int AS n FROM plugin_credits.ledger_entries l JOIN plugin_credits.accounts a ON a.id=l.account_id WHERE a.user_ref=$1 AND l.reason='welcome'", [memberId]);
    expect(welcome.rows[0].n).toBe(1);
  });
  it("admin inspection never creates a welcome grant for an unknown user", async () => {
    const unknown = 2147483000;
    await admin.get(`/api/plugins/credits/accounts?userId=${unknown}`).expect(200);
    const account = await core.pool.query("SELECT 1 FROM plugin_credits.accounts WHERE user_ref=$1", [unknown]);
    expect(account.rows).toHaveLength(0);
  });
  it("reports captured spending separately from reservations and releases", async () => {
    const credits = loaded.services.require<any>("vox.credits", "^1.0.0");
    const held = await credits.hold({ payerUserId: memberId, credits: 20, idempotencyKey: crypto.randomUUID() });
    const released = await credits.hold({ payerUserId: memberId, credits: 10, idempotencyKey: crypto.randomUUID() });
    await credits.release(released.holdId);
    const captured = await credits.hold({ payerUserId: memberId, credits: 15, idempotencyKey: crypto.randomUUID() });
    await credits.capture(captured.holdId, { earnerUserId: adminId, platformFeeCredits: 0 });
    const response = await member.get("/api/plugins/credits/usage").expect(200);
    expect(response.body).toMatchObject({ available: 65, reserved: 20, spent: 15, spentThisMonth: 15, expires: false });
    await credits.release(held.holdId);
  });
  it("requires init code and fresh exact-batch verification, and retries do not double grant", async () => {
    const payload = { batchId: crypto.randomUUID(), userIds: [memberId], credits: 50, reason: "Test grant" };
    const verification = await approval(admin, "credits.grant", payload);
    await admin.post("/api/plugins/credits/grants").send({ ...payload, verification: { ...verification, initCode: "wrong" } }).expect(403);
    await admin.post("/api/plugins/credits/grants").send({ ...payload, credits: 51, verification }).expect(403);
    await admin.post("/api/plugins/credits/grants").send({ ...payload, verification }).expect(201);
    await admin.post("/api/plugins/credits/grants").send({ ...payload, verification }).expect(201);
    await admin.post("/api/plugins/credits/grants").send({ ...payload, credits: 51, verification }).expect(400);
    expect((await member.get("/api/plugins/credits/balance")).body.credits).toBe(150);
  });
  it("allows only one concurrent approval and prevents TOTP-step replay for a new batch", async () => {
    const payload = { batchId: crypto.randomUUID(), userIds: [memberId], credits: 10, reason: "Concurrent grant" };
    const verification = await approval(admin, "credits.grant", payload);
    const requests = await Promise.all([admin.post("/api/plugins/credits/grants").send({ ...payload, verification }), admin.post("/api/plugins/credits/grants").send({ ...payload, verification })]);
    expect(requests.some((response) => response.status === 201)).toBe(true);
    expect((await member.get("/api/plugins/credits/balance")).body.credits).toBe(110);
    const next = { ...payload, batchId: crypto.randomUUID() };
    const replay = await approval(admin, "credits.grant", next, "totp", verification.code);
    await admin.post("/api/plugins/credits/grants").send({ ...next, verification: replay }).expect(403);
  });
  it("bulk grants deduplicate recipients and bind the complete list", async () => {
    const other = await makeUser();
    const payload = { batchId: crypto.randomUUID(), userIds: [memberId, other.id].sort((a, b) => a - b), credits: 25, reason: "Community award" };
    const verification = await approval(admin, "credits.grant", payload);
    await admin.post("/api/plugins/credits/grants").send({ ...payload, userIds: [memberId], verification }).expect(403);
    const response = await admin.post("/api/plugins/credits/grants").send({ ...payload, userIds: [...payload.userIds, memberId], verification }).expect(201);
    expect(response.body).toMatchObject({ recipients: 2, totalCredits: 50 });
    expect((await member.get("/api/plugins/credits/balance")).body.credits).toBe(125);
    expect(await loaded.services.require<any>("vox.credits", "^1.0.0").getBalance(other.id)).toBe(125);
  });
  it("rejects unprivileged and disabled admins, expired approvals and excessive wrong attempts", async () => {
    await member.get("/api/plugins/payments/pricing").expect(403);
    const payload = { batchId: crypto.randomUUID(), userIds: [memberId], credits: 10, reason: "Secure grant" };
    const verification = await approval(admin, "credits.grant", payload);
    for (let i = 0; i < 5; i++) await admin.post("/api/plugins/credits/grants").send({ ...payload, verification: { ...verification, code: "wrong" } }).expect(403);
    await admin.post("/api/plugins/credits/grants").send({ ...payload, verification }).expect(403);
    const next = { ...payload, batchId: crypto.randomUUID() };
    const expired = await approval(admin, "credits.grant", next);
    await core.pool.query("UPDATE verification_challenges SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.challengeId]);
    await admin.post("/api/plugins/credits/grants").send({ ...next, verification: expired }).expect(403);
    await core.storage.updateUser(adminId, { isEnabled: false });
    await admin.post("/api/plugins/credits/grants").send({ ...next, verification: expired }).expect(401);
  });
  it("binds approvals to the session and actor", async () => {
    const payload = { batchId: crypto.randomUUID(), userIds: [memberId], credits: 10, reason: "Session-bound" };
    const verification = await approval(admin, "credits.grant", payload);
    const otherSession = await signIn(adminId);
    await otherSession.post("/api/plugins/credits/grants").send({ ...payload, verification }).expect(403);
    await admin.post("/api/plugins/credits/grants").send({ ...payload, verification }).expect(201);
    const otherAdmin = await signIn((await makeUser(true)).id);
    await otherAdmin.post("/api/plugins/credits/grants").send({ ...payload, verification }).expect(400);
  });
  it("sends email through the plugin, stores only a keyed code hash, and prevents replay", async () => {
    const payload = { batchId: crypto.randomUUID(), userIds: [memberId], credits: 10, reason: "Email verified" };
    const verification = await approval(admin, "credits.grant", payload, "email");
    const mail = fake.mail.mock.calls.at(-1)![0] as any;
    verification.code = mail.text.match(/code is (\d{6})/)[1];
    const challenge = (await core.pool.query("SELECT code_hash FROM verification_challenges WHERE id=$1", [verification.challengeId])).rows[0];
    expect(challenge.code_hash).not.toContain(verification.code);
    await admin.post("/api/plugins/credits/grants").send({ ...payload, verification }).expect(201);
    expect((await core.pool.query("SELECT code_hash FROM verification_challenges WHERE id=$1", [verification.challengeId])).rows[0].code_hash).toBeNull();
    expect((await core.pool.query("SELECT payload_ciphertext FROM plugin_notifications.deliveries WHERE idempotency_key=$1", [verification.challengeId])).rows[0].payload_ciphertext).toBeNull();
  });
  it("enrolls a real authenticator and recovers without revealing stored secrets", async () => {
    const enrollment = await member.post("/api/user/security/totp/enroll").send({}).expect(200);
    expect(enrollment.body.qrCode).toMatch(/^data:image\/png;base64,/);
    const row = (await core.pool.query("SELECT encrypted_secret FROM user_verification_factors WHERE user_id=$1", [memberId])).rows[0];
    expect(row.encrypted_secret).not.toContain(enrollment.body.secret);
    const code = security.authenticator(enrollment.body.secret).generate();
    const confirmed = await member.post("/api/user/security/totp/confirm").send({ code }).expect(200);
    expect(confirmed.body.recoveryCodes).toHaveLength(8);
    await member.post("/api/user/security/totp/enroll").send({}).expect(409);
    await member.post("/api/user/security/totp/recover").send({ recoveryCode: confirmed.body.recoveryCodes[0] }).expect(200);
    await member.post("/api/user/security/totp/recover").send({ recoveryCode: confirmed.body.recoveryCodes[0] }).expect(403);
  });
  it("changes pricing only with exact verification and rejects a stale catalog version", async () => {
    const current = (await admin.get("/api/plugins/payments/pricing")).body.catalog;
    const payload = { baseVersion: current.version, premiumPriceCents: 1400, topupPriceCents: 600, topupCredits: 120 };
    const verification = await approval(admin, "payments.pricing", payload);
    await admin.patch("/api/plugins/payments/pricing").send({ ...payload, topupCredits: 121, verification }).expect(403);
    const changed = await admin.patch("/api/plugins/payments/pricing").send({ ...payload, verification }).expect(200);
    expect(changed.body).toMatchObject({ premiumPriceCents: 1400, topupPriceCents: 600, topupCredits: 120 });
    await admin.patch("/api/plugins/payments/pricing").send({ ...payload, verification }).expect(409);
  });
  it("does not grant credits on checkout, grants the original pack on a signed webhook, and deduplicates delivery", async () => {
    const purchaseId = crypto.randomUUID();
    const before = (await member.get("/api/plugins/credits/balance")).body.credits;
    const current = (await member.get("/api/plugins/payments/usage")).body.catalog;
    await member.post("/api/plugins/payments/checkout").send({ requestId: purchaseId, kind: "topup", packs: 2 }).expect(200);
    expect((await member.get("/api/plugins/credits/balance")).body.credits).toBe(before);
    const checkout = fake.sessions.get(`cs_${purchaseId}`);
    // Simulate catalog publication after checkout; paid snapshot must stay unchanged.
    await core.pool.query("INSERT INTO plugin_payments.catalog_versions(premium_price_cents,topup_price_cents,topup_credits) VALUES(1200,500,99)");
    checkout.payment_status = "paid"; checkout.status = "complete"; checkout.payment_intent = `pi_${purchaseId}`;
    const eventId = `evt_${crypto.randomUUID()}`;
    await webhook("checkout.session.completed", checkout, eventId).then((response) => expect(response.status).toBe(200));
    await webhook("checkout.session.completed", checkout, eventId).then((response) => expect(response.status).toBe(200));
    expect((await member.get("/api/plugins/credits/balance")).body.credits).toBe(before + 2 * current.topupCredits);
    expect((await request(app).post("/api/plugins/payments/webhook").set("stripe-signature", "invalid").send({})).status).toBe(400);
  });
  it("does not fulfill unpaid or mismatched checkout sessions and isolates customer ownership", async () => {
    const purchaseId = crypto.randomUUID();
    await member.post("/api/plugins/payments/checkout").send({ requestId: purchaseId, kind: "topup", packs: 1 }).expect(200);
    await admin.post("/api/plugins/payments/checkout").send({ requestId: purchaseId, kind: "topup", packs: 1 }).expect(409);
    const checkout = fake.sessions.get(`cs_${purchaseId}`);
    await webhook("checkout.session.completed", checkout).then((response) => expect(response.status).toBe(200));
    expect((await member.get("/api/plugins/credits/balance")).body.credits).toBe(100);
    checkout.payment_status = "paid"; checkout.amount_total += 1;
    await webhook("checkout.session.completed", checkout).then((response) => expect(response.status).toBe(500));
    expect((await member.get("/api/plugins/credits/balance")).body.credits).toBe(100);
    await member.post("/api/plugins/payments/checkout").send({ requestId: crypto.randomUUID(), kind: "topup", packs: 1, amount: 1 }).expect(400);
  });
  it("retains the original purchase snapshot after a remote timeout and catalog change", async () => {
    const purchaseId = crypto.randomUUID();
    const catalog = (await member.get("/api/plugins/payments/usage")).body.catalog;
    fake.failCheckoutAfterCreate = true;
    await member.post("/api/plugins/payments/checkout").send({ requestId: purchaseId, kind: "topup", packs: 1 }).expect(500);
    const saved = (await core.pool.query("SELECT credits,amount_cents FROM plugin_payments.purchases WHERE id=$1", [purchaseId])).rows[0];
    expect(saved).toMatchObject({ credits: catalog.topupCredits, amount_cents: catalog.topupPriceCents });
    await core.pool.query("INSERT INTO plugin_payments.catalog_versions(premium_price_cents,topup_price_cents,topup_credits) VALUES(1200,501,101)");
    await member.post("/api/plugins/payments/checkout").send({ requestId: purchaseId, kind: "topup", packs: 1 }).expect(200);
    const checkout = fake.sessions.get(`cs_${purchaseId}`);
    expect(checkout.amount_total).toBe(catalog.topupPriceCents);
    checkout.payment_status = "paid"; checkout.payment_intent = `pi_${purchaseId}`;
    await webhook("checkout.session.async_payment_succeeded", checkout).then((response) => expect(response.status).toBe(200));
    expect((await member.get("/api/plugins/credits/balance")).body.credits).toBe(100 + catalog.topupCredits);
  });
  it("retains an early refund event and does not grant subsequently refunded credits", async () => {
    const purchaseId = crypto.randomUUID();
    await member.post("/api/plugins/payments/checkout").send({ requestId: purchaseId, kind: "topup", packs: 1 }).expect(200);
    const checkout = fake.sessions.get(`cs_${purchaseId}`);
    checkout.payment_status = "paid"; checkout.payment_intent = `pi_${purchaseId}`;
    await webhook("charge.refunded", { id: "ch_early", customer: checkout.customer, payment_intent: checkout.payment_intent }).then((response) => expect(response.status).toBe(200));
    await webhook("checkout.session.completed", checkout).then((response) => expect(response.status).toBe(200));
    expect((await member.get("/api/plugins/credits/balance")).body.credits).toBe(100);
    expect((await core.pool.query("SELECT status FROM plugin_payments.purchases WHERE id=$1", [purchaseId])).rows[0].status).toBe("review");
  });
  it("resumes a partially failed batch without requiring another approval or duplicating a deposit", async () => {
    const { createPersonalCredits } = await import("../plugins/credits/server/personal");
    const { createCreditsService } = await import("../plugins/credits/server/service");
    const { createPluginDb } = await import("../server/plugins/db");
    const db = createPluginDb(core.pool, "plugin_credits");
    const base = createCreditsService(db);
    const other = await makeUser();
    let failed = false;
    const flaky = { ...base, deposit: async (input: Parameters<typeof base.deposit>[0]) => {
      if (input.userId === other.id && input.reason === "Partial batch" && !failed) { failed = true; throw new Error("Simulated failure"); }
      return base.deposit(input);
    } };
    const consume = vi.fn(async () => crypto.randomUUID());
    const personal = createPersonalCredits(db, flaky, services.userDirectoryService, { consume });
    const payload = { batchId: crypto.randomUUID(), userIds: [memberId, other.id], credits: 10, reason: "Partial batch" };
    const req = { session: { userId: adminId } } as any;
    await expect(personal.grant(req, payload, {} as any)).rejects.toThrow("Simulated failure");
    await personal.grant(req, payload, {} as any);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(await personal.service.getBalance(memberId)).toBe(110);
    expect(await personal.service.getBalance(other.id)).toBe(110);
  });
  it("queues failed email deliveries encrypted and scrubs expired messages without sending", async () => {
    const notifications = loaded.services.require<any>("vox.notifications", "^1.0.0");
    fake.mail.mockRejectedValueOnce(new Error("SMTP temporary failure"));
    const key = crypto.randomUUID();
    await notifications.sendEmail({ to: "recipient@billing.test", subject: "Retry", text: "sensitive-message", idempotencyKey: key, expiresAt: new Date(Date.now() + 60_000) });
    const queued = (await core.pool.query("SELECT payload_ciphertext,status,attempts FROM plugin_notifications.deliveries WHERE idempotency_key=$1", [key])).rows[0];
    expect(queued.status).toBe("pending"); expect(queued.attempts).toBe(1); expect(queued.payload_ciphertext).not.toContain("sensitive-message");
    await core.pool.query("UPDATE plugin_notifications.deliveries SET expires_at=now()-interval '1 second' WHERE idempotency_key=$1", [key]);
    const calls = fake.mail.mock.calls.length;
    await notifications.sendEmail({ to: "other@billing.test", subject: "Next", text: "not-sensitive", idempotencyKey: crypto.randomUUID() });
    expect(fake.mail.mock.calls.length).toBe(calls + 1);
    const expired = (await core.pool.query("SELECT payload_ciphertext,status FROM plugin_notifications.deliveries WHERE idempotency_key=$1", [key])).rows[0];
    expect(expired).toEqual({ payload_ciphertext: null, status: "expired" });
  });
  it("grants paid Premium access without minting recurring credits or overwriting base roles", async () => {
    const purchaseId = crypto.randomUUID();
    await member.post("/api/plugins/payments/checkout").send({ requestId: purchaseId, kind: "premium", packs: 1 }).expect(200);
    const checkout = fake.sessions.get(`cs_${purchaseId}`);
    const price = fake.prices.get(checkout.line_items[0].price);
    const end = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    const subscription = { id: `sub_${purchaseId}`, customer: checkout.customer, created: Math.floor(Date.now() / 1000), status: "active", cancel_at_period_end: false,
      items: { data: [{ price }] }, latest_invoice: { id: `in_${purchaseId}`, status: "paid", customer: checkout.customer, parent: { subscription_details: { subscription: `sub_${purchaseId}` } }, lines: { data: [{ amount: price.unit_amount, period: { end } }] } } };
    fake.subscriptions.set(subscription.id, subscription); fake.invoices.set(subscription.latest_invoice.id, subscription.latest_invoice);
    checkout.payment_status = "paid"; checkout.status = "complete"; checkout.subscription = subscription.id;
    await webhook("checkout.session.completed", checkout).then((response) => expect(response.status).toBe(200));
    expect((await core.storage.getUser(memberId))!.plan).toBe("premium");
    const memberRecord = await core.storage.getUser(memberId);
    const listed = await core.storage.listUsersPage({ limit: 10, offset: 0, q: memberRecord!.email });
    expect(listed.rows[0]).toMatchObject({ plan: "basic", personalPremium: true });
    expect((await member.get("/api/plugins/credits/balance")).body.credits).toBe(100);
    expect((await core.pool.query("SELECT plan FROM users WHERE id=$1", [memberId])).rows[0].plan).toBe("basic");
    subscription.status = "canceled"; subscription.cancel_at_period_end = true;
    await webhook("customer.subscription.deleted", subscription).then((response) => expect(response.status).toBe(200));
    expect((await core.storage.getUser(memberId))!.plan).toBe("premium");
    await core.pool.query("UPDATE personal_entitlements SET expires_at=now()-interval '1 second' WHERE user_id=$1", [memberId]);
    expect((await core.storage.getUser(memberId))!.plan).toBe("basic");
    await services.personalEntitlementsService.setPremium(adminId, "payments", new Date(Date.now() + 60_000));
    expect((await core.storage.getUser(adminId))!.plan).toBe("principal");
    await services.personalEntitlementsService.setPremium(adminId, "payments", null);
    expect((await core.storage.getUser(adminId))!.plan).toBe("principal");
  });
});
