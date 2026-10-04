import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Request } from "express";
import type { VoxPlugin, PluginDb, Handler, IdentityService, VerificationService, PersonalEntitlementsService, VerificationProof } from "@vox/plugin-sdk";
import { pricingSchema, publicCatalog, type CatalogRow } from "./catalog";

interface Credits {
  deposit(input: { userId: number; credits: number; reason: string; ref: { type: string; id: string }; idempotencyKey: string }): Promise<unknown>;
}
interface Purchase {
  id: string; user_ref: number; kind: "topup" | "premium"; packs: number; catalog_version: number;
  amount_cents: number; credits: number; stripe_checkout_id: string | null; stripe_payment_intent: string | null; status: string;
}
const checkoutSchema = z.object({ requestId: z.string().uuid(), kind: z.enum(["topup", "premium"]), packs: z.number().int().min(1).max(20).default(1) }).strict();
export class PaymentError extends Error { constructor(message: string, public status = 400) { super(message); } }
function fail(message: string, status = 400): never { throw new PaymentError(message, status); }
function objectId(value: unknown): string | null {
  if (typeof value === "string") return value;
  return value && typeof value === "object" && "id" in value ? String(value.id) : null;
}
const route = (handler: Handler): Handler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch((error) => {
    const verificationStatus = (error as { status?: number }).status;
    const status = error instanceof PaymentError ? error.status : error instanceof z.ZodError ? 400 : verificationStatus === 403 || verificationStatus === 401 || verificationStatus === 429 ? verificationStatus : 500;
    res.status(status).json({ error: error instanceof PaymentError || status === 403 || status === 401 || status === 429 ? error.message : status === 400 ? "Invalid request" : "Billing operation failed; please retry" });
  });
};

const plugin: VoxPlugin = {
  async activate(ctx) {
    const credits = ctx.services.require<Credits>("vox.credits", "^1.0.0");
    const identity = ctx.services.require<IdentityService>("vox.identity", "^1.0.0");
    const verification = ctx.services.require<VerificationService>("vox.verification", "^1.0.0");
    const entitlements = ctx.services.require<PersonalEntitlementsService>("vox.personal-entitlements", "^1.0.0");
    const key = ctx.config.get("STRIPE_SECRET_KEY");
    const webhookSecret = ctx.config.get("STRIPE_PERSONAL_WEBHOOK_SECRET");
    const stripe = key ? new Stripe(key, { timeout: 10_000, maxNetworkRetries: 1 }) : null;
    const configuredOrigin = ctx.config.get("APP_URL");
    const origin = configuredOrigin ?? (ctx.config.get("NODE_ENV") === "production" ? null : "http://localhost:5000");
    if (origin) {
      const url = new URL(origin);
      if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || (ctx.config.get("NODE_ENV") === "production" && url.protocol !== "https:")) throw new Error("APP_URL must be the public HTTPS origin");
    }
    const paymentsEnabled = !!stripe && !!origin && !!webhookSecret;
    const client = () => { if (!paymentsEnabled || !stripe) fail("Personal Stripe billing is not configured", 503); return stripe; };
    const catalog = async (db = ctx.db): Promise<CatalogRow> => (await db.query<CatalogRow>("SELECT * FROM catalog_versions ORDER BY id DESC LIMIT 1")).rows[0];

    async function ensureCustomer(db: PluginDb, userId: number, user: { email: string; username: string }): Promise<string> {
      await db.query("INSERT INTO customers(user_ref) VALUES($1) ON CONFLICT(user_ref) DO NOTHING", [userId]);
      const { rows: [customer] } = await db.query<{ stripe_customer_id: string | null }>("SELECT stripe_customer_id FROM customers WHERE user_ref=$1 FOR UPDATE", [userId]);
      if (customer.stripe_customer_id) return customer.stripe_customer_id;
      const created = await client().customers.create({ email: user.email, name: user.username, metadata: { vox_personal_user: String(userId) } }, { idempotencyKey: `vox-personal-customer:${userId}` });
      await db.query("UPDATE customers SET stripe_customer_id=$2 WHERE user_ref=$1", [userId, created.id]);
      return created.id;
    }
    async function ensurePrice(db: PluginDb, row: CatalogRow, kind: "topup" | "premium"): Promise<string> {
      const field = kind === "premium" ? "premium_stripe_price" : "topup_stripe_price";
      const locked = (await db.query<CatalogRow>("SELECT * FROM catalog_versions WHERE id=$1 FOR UPDATE", [row.id])).rows[0];
      if (locked[field]) return locked[field]!;
      const price = await client().prices.create({
        currency: "usd", unit_amount: kind === "premium" ? row.premium_price_cents : row.topup_price_cents,
        recurring: kind === "premium" ? { interval: "month" } : undefined,
        product_data: { name: kind === "premium" ? "Vox Personal Premium" : `Vox ${row.topup_credits} Credits` },
        metadata: { vox_catalog: String(row.id), vox_kind: kind },
      }, { idempotencyKey: `vox-personal-price:${row.id}:${kind}` });
      await db.query(`UPDATE catalog_versions SET ${field}=$2 WHERE id=$1`, [row.id, price.id]);
      return price.id;
    }

    async function fulfillCheckout(sessionId: string) {
      const session = await client().checkout.sessions.retrieve(sessionId);
      if (session.payment_status !== "paid") return;
      const purchaseId = session.metadata?.vox_purchase;
      if (!purchaseId) return;
      // The durable webhook lease serializes effects without reserving a pool
      // connection across Stripe or cross-plugin service calls.
      {
        const tx = ctx.db;
        const { rows: [purchase] } = await tx.query<Purchase>("SELECT * FROM purchases WHERE id=$1", [purchaseId]);
        if (!purchase) throw new Error("Purchase not committed yet");
        const { rows: [customer] } = await tx.query<{ stripe_customer_id: string }>("SELECT stripe_customer_id FROM customers WHERE user_ref=$1", [purchase.user_ref]);
        if (purchase.stripe_checkout_id !== session.id || objectId(session.customer) !== customer?.stripe_customer_id ||
            session.currency !== "usd" || session.amount_total !== purchase.amount_cents ||
            session.mode !== (purchase.kind === "topup" ? "payment" : "subscription")) throw new Error("Checkout does not match purchase snapshot");
        if (purchase.status === "paid" || purchase.status === "review") return;
        const intentId = objectId(session.payment_intent);
        const reviews = intentId ? await tx.query("SELECT 1 FROM payment_reviews WHERE stripe_payment_intent=$1 LIMIT 1", [intentId]) : null;
        if (reviews?.rows.length) {
          await tx.query("UPDATE purchases SET status='review',stripe_payment_intent=$2 WHERE id=$1", [purchase.id, intentId]);
          await tx.query("UPDATE payment_reviews SET purchase_id=$2 WHERE stripe_payment_intent=$1", [intentId, purchase.id]);
          return; // a refund/dispute arrived before checkout fulfillment
        }
        if (purchase.kind === "topup") {
          await credits.deposit({ userId: purchase.user_ref, credits: purchase.credits, reason: "topup",
            ref: { type: "stripe_purchase", id: purchase.id }, idempotencyKey: `stripe-topup:${purchase.id}` });
        }
        await tx.query("UPDATE purchases SET status='paid',paid_at=now(),stripe_payment_intent=$2,stripe_subscription_id=$3 WHERE id=$1",
          [purchase.id, objectId(session.payment_intent), objectId(session.subscription)]);
      }
    }

    async function syncSubscription(subscriptionId: string, paidInvoiceId?: string) {
      // The webhook lease, not a pooled connection, protects this live read.
      const initial = await client().subscriptions.retrieve(subscriptionId);
      const customerId = objectId(initial.customer);
      {
        const tx = ctx.db;
        const { rows: [customer] } = await tx.query<{ user_ref: number }>("SELECT user_ref FROM customers WHERE stripe_customer_id=$1", [customerId]);
        if (!customer) return; // organization or another application
        const subscription = await client().subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] });
        const price = subscription.items.data[0]?.price;
        const ownedPrice = await tx.query("SELECT 1 FROM catalog_versions WHERE premium_stripe_price=$1", [price?.id]);
        if (!ownedPrice.rows.length) return;
        const { rows: [previous] } = await tx.query<{ stripe_subscription_id: string; paid_through: Date | null }>("SELECT stripe_subscription_id,paid_through FROM subscriptions WHERE user_ref=$1", [customer.user_ref]);
        if (previous && previous.stripe_subscription_id !== subscriptionId) {
          const prior = await client().subscriptions.retrieve(previous.stripe_subscription_id);
          if (prior.created > subscription.created) return; // old subscription event
        }
        let paidThrough = previous?.stripe_subscription_id === subscriptionId ? previous.paid_through : null;
        const invoice = paidInvoiceId ? await client().invoices.retrieve(paidInvoiceId) : typeof subscription.latest_invoice === "object" ? subscription.latest_invoice : null;
        if (invoice?.status === "paid" && objectId(invoice.customer) === customerId) {
          const invoiceSub = objectId(invoice.parent?.subscription_details?.subscription);
          if (invoiceSub === subscriptionId) {
            const end = Math.max(0, ...invoice.lines.data.filter((line) => line.amount >= 0).map((line) => line.period.end));
            if (end > 0 && (!paidThrough || end * 1000 > new Date(paidThrough).getTime())) paidThrough = new Date(end * 1000);
          }
        }
        await tx.query(`INSERT INTO subscriptions(user_ref,stripe_subscription_id,status,paid_through,cancel_at_period_end,price_cents)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_ref) DO UPDATE SET stripe_subscription_id=EXCLUDED.stripe_subscription_id,
          status=EXCLUDED.status,paid_through=EXCLUDED.paid_through,cancel_at_period_end=EXCLUDED.cancel_at_period_end,
          price_cents=EXCLUDED.price_cents,updated_at=now()`,
          [customer.user_ref, subscription.id, subscription.status, paidThrough, subscription.cancel_at_period_end, price?.unit_amount ?? 0]);
        await entitlements.setPremium(customer.user_ref, "payments", paidThrough);
      }
    }

    ctx.http((r) => {
      r.get("/usage", r.requireAuth, route(async (req, res) => {
        const userId = req.session.userId!;
        const user = await identity.getUserById(userId);
        const { rows: [subscription] } = await ctx.db.query("SELECT status,paid_through,cancel_at_period_end,price_cents FROM subscriptions WHERE user_ref=$1", [userId]);
        const { rows: purchases } = await ctx.db.query("SELECT id,kind,amount_cents,credits,status,created_at,paid_at FROM purchases WHERE user_ref=$1 ORDER BY created_at DESC LIMIT 50", [userId]);
        res.json({ catalog: publicCatalog(await catalog()), paymentsEnabled, subscription: subscription ?? null, purchases, email: user?.email });
      }));
      r.get("/pricing", r.requireAuth, r.requireAdmin, route(async (_req, res) => {
        const { rows: history } = await ctx.db.query("SELECT id,premium_price_cents,topup_price_cents,topup_credits,admin_user_id,created_at FROM catalog_versions ORDER BY id DESC LIMIT 20");
        const { rows: reviews } = await ctx.db.query("SELECT * FROM payment_reviews ORDER BY created_at DESC LIMIT 50");
        res.json({ catalog: publicCatalog(await catalog()), history, reviews });
      }));
      r.patch("/pricing", r.requireAuth, r.requireAdmin, route(async (req, res) => {
        const { verification: proof, ...input } = req.body ?? {};
        const values = pricingSchema.parse(input);
        if ((await catalog()).id !== values.baseVersion) fail("Pricing changed; reload and verify the new proposal", 409);
        const receipt = await verification.consume(req, "payments.pricing", values, proof as VerificationProof);
        const result = await ctx.db.withTransaction(async (tx) => {
          // Serializes publication of catalog versions; stale edits cannot overwrite.
          await tx.query("SELECT pg_advisory_xact_lock(7312459)");
          const current = await catalog(tx);
          if (current.id !== values.baseVersion) fail("Pricing changed; reload and verify the new proposal", 409);
          const { rows: [row] } = await tx.query<CatalogRow>("INSERT INTO catalog_versions(premium_price_cents,topup_price_cents,topup_credits,admin_user_id,verification_receipt) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [values.premiumPriceCents, values.topupPriceCents, values.topupCredits, req.session.userId, receipt]);
          return publicCatalog(row);
        });
        res.json(result);
      }));
      r.post("/checkout", r.requireAuth, route(async (req, res) => {
        const input = checkoutSchema.parse(req.body);
        if (input.kind === "premium" && input.packs !== 1) fail("Premium quantity must be one");
        const stripeClient = client();
        const userId = req.session.userId!;
        const user = await identity.getUserById(userId);
        if (!user?.isEnabled) fail("Account unavailable", 401);
        const customerId = await ctx.db.withTransaction((tx) => ensureCustomer(tx, userId, user));
        // Commit the purchase snapshot before a remote call can create a payable
        // session. A timeout/retry must not pick up a newer catalog version.
        const purchase = await ctx.db.withTransaction(async (tx) => {
          await tx.query("SELECT user_ref FROM customers WHERE user_ref=$1 FOR UPDATE", [userId]);
          const { rows: [existing] } = await tx.query<Purchase>("SELECT * FROM purchases WHERE id=$1 FOR UPDATE", [input.requestId]);
          if (existing) {
            if (existing.user_ref !== userId || existing.kind !== input.kind || existing.packs !== input.packs) fail("Checkout request ID already used", 409);
            return existing;
          }
          if (input.kind === "premium") {
            const subscriptions = await stripeClient.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
            if (subscriptions.data.some((sub) => ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"].includes(sub.status))) fail("Manage your existing subscription instead", 409);
            const pending = await tx.query<Purchase>("SELECT * FROM purchases WHERE user_ref=$1 AND kind='premium' AND status='pending' ORDER BY created_at", [userId]);
            for (const old of pending.rows) {
              if (!old.stripe_checkout_id) return old;
              const oldSession = await stripeClient.checkout.sessions.retrieve(old.stripe_checkout_id);
              if (oldSession.status === "open") return old;
              if (oldSession.status === "complete") fail("Payment is being processed; please refresh shortly", 409);
              await tx.query("UPDATE purchases SET status='expired' WHERE stripe_checkout_id=$1", [old.stripe_checkout_id]);
            }
          }
          const row = await catalog(tx);
          const amount = (input.kind === "topup" ? row.topup_price_cents : row.premium_price_cents) * input.packs;
          const creditAmount = input.kind === "topup" ? row.topup_credits * input.packs : 0;
          const { rows: [created] } = await tx.query<Purchase>("INSERT INTO purchases(id,user_ref,kind,packs,catalog_version,amount_cents,credits) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [input.requestId, userId, input.kind, input.packs, row.id, amount, creditAmount]);
          return created;
        });
        const session = await ctx.db.withTransaction(async (tx) => {
          const savedPurchase = (await tx.query<Purchase>("SELECT * FROM purchases WHERE id=$1 FOR UPDATE", [purchase.id])).rows[0];
          if (savedPurchase.stripe_checkout_id) {
            const saved = await stripeClient.checkout.sessions.retrieve(savedPurchase.stripe_checkout_id);
            if (saved.status !== "open" || !saved.url) fail("Checkout already completed or expired; start again", 409);
            return saved;
          }
          const row = (await tx.query<CatalogRow>("SELECT * FROM catalog_versions WHERE id=$1", [purchase.catalog_version])).rows[0];
          const priceId = await ensurePrice(tx, row, purchase.kind);
          const created = await stripeClient.checkout.sessions.create({ customer: customerId,
            mode: purchase.kind === "topup" ? "payment" : "subscription", line_items: [{ price: priceId, quantity: purchase.packs }],
            metadata: { vox_purchase: purchase.id },
            subscription_data: purchase.kind === "premium" ? { metadata: { vox_personal_user: String(userId) } } : undefined,
            success_url: `${origin}/console/usage?tab=${purchase.kind === "topup" ? "credits" : "plan"}&checkout={CHECKOUT_SESSION_ID}`,
            cancel_url: `${origin}/console/usage?tab=${purchase.kind === "topup" ? "credits" : "plan"}`,
          }, { idempotencyKey: `vox-checkout:${purchase.id}` });
          await tx.query("UPDATE purchases SET stripe_checkout_id=$2 WHERE id=$1", [purchase.id, created.id]);
          return created;
        });
        res.json({ url: session.url });
      }));
      r.post("/portal", r.requireAuth, route(async (req, res) => {
        const { rows: [customer] } = await ctx.db.query<{ stripe_customer_id: string }>("SELECT stripe_customer_id FROM customers WHERE user_ref=$1", [req.session.userId]);
        if (!customer?.stripe_customer_id) fail("No personal billing account yet", 404);
        const portal = await client().billingPortal.sessions.create({ customer: customer.stripe_customer_id, return_url: `${origin}/console/usage?tab=plan` });
        res.json({ url: portal.url });
      }));
      r.post("/webhook", route(async (req, res) => {
        const signature = req.headers["stripe-signature"];
        const raw = (req as Request & { rawBody?: Buffer }).rawBody;
        if (typeof signature !== "string" || !Buffer.isBuffer(raw)) fail("Missing webhook signature or raw body");
        let event: Stripe.Event;
        try { event = client().webhooks.constructEvent(raw, signature, webhookSecret!); } catch { fail("Invalid webhook signature"); }
        await ctx.db.query("INSERT INTO webhook_events(id,event_type) VALUES($1,$2) ON CONFLICT(id) DO NOTHING", [event.id, event.type]);
        const { rows: [already] } = await ctx.db.query<{ status: string }>("SELECT status FROM webhook_events WHERE id=$1", [event.id]);
        if (already.status === "processed") { res.json({ received: true }); return; }
        const lease = randomUUID();
        const { rows: claimed } = await ctx.db.query("UPDATE webhook_lease SET token=$1,expires_at=now()+interval '5 minutes' WHERE id=1 AND (token IS NULL OR expires_at<=now()) RETURNING id", [lease]);
        if (!claimed.length) fail("Another personal billing event is processing; please retry", 503);
        try {
          const tx = ctx.db;
          const { rows: [saved] } = await tx.query<{ status: string }>("SELECT status FROM webhook_events WHERE id=$1", [event.id]);
          if (saved.status === "processed") { res.json({ received: true }); return; }
          const object = event.data.object;
          if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
            const checkout = object as Stripe.Checkout.Session;
            await fulfillCheckout(checkout.id);
            const live = await client().checkout.sessions.retrieve(checkout.id);
            const sub = objectId(live.subscription);
            if (sub) await syncSubscription(sub);
          } else if (event.type === "checkout.session.expired") {
            const checkout = object as Stripe.Checkout.Session;
            await tx.query("UPDATE purchases SET status='expired' WHERE stripe_checkout_id=$1 AND status='pending'", [checkout.id]);
          } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
            const invoice = object as Stripe.Invoice;
            const sub = objectId(invoice.parent?.subscription_details?.subscription);
            if (sub) await syncSubscription(sub, event.type === "invoice.paid" ? invoice.id : undefined);
          } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
            await syncSubscription((object as Stripe.Subscription).id);
          } else if (event.type === "charge.refunded" || event.type === "charge.dispute.created") {
            const charge = event.type === "charge.refunded" ? object as Stripe.Charge : await client().charges.retrieve(objectId((object as Stripe.Dispute).charge)!);
            const intent = objectId(charge.payment_intent);
            const { rows: [purchase] } = await tx.query<Purchase>("UPDATE purchases SET status='review' WHERE stripe_payment_intent=$1 RETURNING *", [intent]);
            const { rows: [customer] } = await tx.query<{ user_ref: number }>("SELECT user_ref FROM customers WHERE stripe_customer_id=$1", [objectId(charge.customer)]);
            if (purchase || customer) await tx.query("INSERT INTO payment_reviews(event_id,user_ref,purchase_id,reason,stripe_payment_intent) VALUES($1,$2,$3,$4,$5) ON CONFLICT(event_id) DO NOTHING",
              [event.id, purchase?.user_ref ?? customer.user_ref, purchase?.id ?? null, event.type, intent]);
          }
          await tx.query("UPDATE webhook_events SET status='processed',processed_at=now() WHERE id=$1", [event.id]);
        } finally {
          await ctx.db.query("UPDATE webhook_lease SET token=NULL,expires_at=NULL WHERE id=1 AND token=$1", [lease]);
        }
        res.json({ received: true });
      }));
    });
    ctx.health(async () => { await ctx.db.query("SELECT 1"); return { status: "ok", detail: paymentsEnabled ? "Personal billing configured" : "Read-only; configure Stripe and APP_URL" }; });
  },
};
export default plugin;
