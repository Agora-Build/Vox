# payments - Plugin Spec

Personal purchases and subscriptions only; organization billing is unchanged.
Enabled by `VOX_PLUGINS=credits,payments`. Consumes `vox.credits`, `vox.identity`,
`vox.verification`, and `vox.personal-entitlements` through the SDK, never Core
or another plugin's tables. No services provided.

## URLs
- `GET /api/plugins/payments/usage` - own plan, catalog, recent purchases.
- `POST /api/plugins/payments/checkout` - authenticated hosted Stripe Checkout.
- `POST /api/plugins/payments/portal` - own Stripe Customer Portal.
- `GET /api/plugins/payments/pricing` - admin pricing configuration.
- `PATCH /api/plugins/payments/pricing` - admin, initialization code and fresh
  Core verification bound to the exact values and base catalog version.
- `POST /api/plugins/payments/webhook` - raw-body signature-verified Stripe events.

## Catalog and money
USD integer cents; Basic is free, Premium initially $12/month with no recurring
credits, top-up initially 100 credits/$5. New versions never change existing
subscriptions or pending purchase snapshots. Admin settings never reset on boot.
Stripe Prices are immutable and created from the server-owned catalog. Browser
inputs cannot set prices, customer ownership, or granted credit amounts.

Owns `plugin_payments` catalog_versions, customers, purchases, subscriptions,
webhook_events and payment_reviews. Core owns effective personal entitlements;
base roles and org benefits are never overwritten. Successful invoice payment
extends entitlement to that paid period; failures do not invent unpaid access.
Cancellation retains access through the paid period. Duplicate/out-of-order
events are processed under locks; checkout credit deposits are idempotent across
crashes at the cross-plugin boundary. A return URL does not fulfill purchases.

Top-up refunds/disputes are recorded for explicit admin review, not silently
removed from a wallet with in-flight escrow. The Usage page surfaces review state.
No cash-out, recurring credits, automatic refund UI, annual plans, or sale of
Principal/Fellow privileges in this release.

## UI and configuration
Lazy personal Top Up, Plan and admin pricing contributions, only available under
the credits Usage page. Without Stripe configuration the read-only catalog and
plan still work; purchases fail closed with 503, never simulate success.

`STRIPE_SECRET_KEY`, `STRIPE_PERSONAL_WEBHOOK_SECRET` (separate endpoint secret),
`APP_URL` (public HTTPS origin in production). Configure Stripe Customer Portal
to permit cancellation and payment-method updates, not arbitrary product changes.
Webhook subscriptions: checkout.session.completed, checkout.session.async_payment_succeeded,
checkout.session.expired, invoice.paid, invoice.payment_failed,
customer.subscription.updated/deleted, charge.refunded and charge.dispute.created.
Signature verification uses the Core-preserved raw request bytes. No raw events,
credentials or full Stripe responses are logged or persisted.
