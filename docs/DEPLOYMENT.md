# Deployment Guide

This guide covers deploying Vox to production using Coolify (what vox.agora.build runs on), or any Docker-based hosting platform (Railway, Render, CapRover, etc.).

## Prerequisites

- A server or hosting platform that supports Docker
- A PostgreSQL database (managed or self-hosted)
- A domain name with DNS configured

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/vox` |
| `SESSION_SECRET` | Key for signing session cookies. **Must be set in production** or the app refuses to start. | Generate with `openssl rand -hex 32` |
| `INIT_CODE` | Bootstrap secret for `/api/auth/init`, also required alongside fresh verification for personal pricing changes and credit grants | Any strong secret string |
| `NODE_ENV` | Must be `production`. The container does not set it; it turns on secure cookies and rate limiting. | `production` |

### Plugins

| Variable | Description | Example |
|----------|-------------|---------|
| `VOX_PLUGINS` | Comma-separated plugins to load. **Treat it like a required setting:** an unknown id stops the server before it listens, and leaving a plugin out turns its feature off. | `credits,shared-agents,organizations,oauth` |

| Plugin | What it adds |
|--------|--------------|
| `organizations` | Organizations, membership, org secrets. **Once enabled on an instance with org data, never remove it** — membership would silently go inert. |
| `credits` | Personal Usage, credit ledger, one-time 100-credit welcome grant and protected admin grants |
| `payments` | Personal Stripe top-ups and Premium subscriptions (needs `credits`) |
| `notifications` | Email delivery and retry queue; Core still owns verification |
| `shared-agents` | Running evals on other people's eval agents (needs `credits`) |
| `oauth` | Sign in with GitHub and Google (see below) |
| `sample` | A minimal example plugin; not for production |

Each plugin has its own database schema (`plugin_<id>`) and its own migrations, applied at startup. A plugin migration that fails aborts startup, so a bad data move never goes live half-done. After deploying, `GET /api/plugins` lists what loaded, and `GET /api/plugins/<id>/health` reports each one.

### Sign in with GitHub / Google (`oauth` plugin)

Needs `oauth` in `VOX_PLUGINS`. Each provider turns on only when both its ID and secret are set; the login page shows only the providers that are on. If credentials are set but the plugin is not loaded, the server logs a warning at startup.

| Variable | Description |
|----------|-------------|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | From a GitHub OAuth App |
| `GITHUB_CALLBACK_URL` | `https://your-domain.com/auth/github/callback` — a web page, which passes the code to the plugin. Register exactly this as the OAuth App's callback URL. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | From a Google Cloud **OAuth client ID** of type *Web application* |
| `GOOGLE_CALLBACK_URL` | `https://your-domain.com/api/plugins/oauth/google/callback`. Register exactly this as an *Authorized redirect URI*. |

**Upgrading from a release before the plugin:** Google's callback moved from `/api/auth/google/callback` to `/api/plugins/oauth/google/callback` — update the registered redirect URI and `GOOGLE_CALLBACK_URL`. GitHub's callback URL is unchanged. Existing account links are copied into the plugin automatically on first start.

### Personal Usage, billing and verification

`credits` enables the personal Usage menu and its Credits & Usage / Plan tabs.
Every existing and new user receives exactly one additive 100-credit welcome
deposit. Existing balances are not reset; a resumable worker backfills users.
Credits do not expire. Without `payments`, wallet/history and grants still work,
but paid checkout is unavailable. Organization billing is unchanged.

For personal purchases, add `payments` alongside existing plugin IDs (do not
remove organizations from an instance with org data). Configure:

| Variable | Purpose |
|----------|---------|
| `APP_URL` | Public HTTPS origin, e.g. `https://vox.example.com`, without a path |
| `STRIPE_SECRET_KEY` | Stripe account API key |
| `STRIPE_PERSONAL_WEBHOOK_SECRET` | Signing secret for the new personal endpoint |
| `CREDENTIAL_ENCRYPTION_KEY` | Required for encrypted TOTP secrets and verification |

Register `https://<your-domain>/api/plugins/payments/webhook` in Stripe. It is
separate from the existing organization endpoint `/api/webhooks/stripe` and
does not use that endpoint's `STRIPE_WEBHOOK_SECRET`. Subscribe to:

- `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`
- `invoice.paid`, `invoice.payment_failed`
- `customer.subscription.updated`, `customer.subscription.deleted`
- `charge.refunded`, `charge.dispute.created`

Configure Stripe Customer Portal for personal cancellation and payment-method
updates; do not enable arbitrary subscription product switching. Payments are
not simulated when configuration is absent. Initial USD pricing is Basic free,
Premium $12/month with feature access only (no recurring credits), and 100 credits
for $5. An admin can publish a new Premium price or top-up price/quantity from
Usage. Existing subscription prices and purchase snapshots are retained.

Core Settings supports Google Authenticator-compatible TOTP enrollment and
recovery codes. This is separate from Google OAuth login. Pricing changes and
individual/bulk credit grants require an active admin session, `INIT_CODE`, and
fresh TOTP or email verification bound to that exact change. Save recovery codes
offline when shown; recovery resets the factor and invalidates remaining codes.
Keep `INIT_CODE` after initialization and keep its value out of logs and source.
Recovery hashes and in-flight challenges use `CREDENTIAL_ENCRYPTION_KEY` too;
rotating that key invalidates recovery codes and pending approvals. Plan a secure
authenticator reset/re-enrollment alongside any encryption-key rotation.

For email codes, enable `notifications` and set `SMTP_HOST`, `SMTP_PORT` (587),
`SMTP_SECURE` (false), `SMTP_USER`, `SMTP_PASSWORD`, `NOTIFICATIONS_FROM`, and
optionally `SMTP_REQUIRE_TLS` (true). Only server-configured destinations from
the authenticated user's account receive security codes. Message bodies are
encrypted at rest and cleared on delivery or expiry; delivery retries stop after
five attempts or expiry. TOTP works without this plugin. Discord is available
for automation alerts, never security verification. WhatsApp and SMS adapters
are not implemented yet. For automation, see the section below.

#### Notification channels and automation

Enable `notifications` to show a Notifications link in personal Settings.
Apply Core migration v55 and the plugin's forward-only migrations on deployment.
Channels, rules/content, activity, and admin Access & Groups are separate from
the credits/payment plugins. Email uses each recipient's verified account email;
Discord uses an encrypted official webhook URL. Configure channels and preview
rules before enabling them. Queued delivery does not guarantee immediate receipt.

Admins explicitly assign Scout / Editor access to selected users and audiences;
paid tiers never grant it automatically. Notification groups are plugin-owned
audiences, not organizations. Assigned editors can read numeric monitoring data
and route messages for the group's current members, so grant access only to
trusted users. JavaScript and LLM permissions are independent opt-ins.

Comparisons and isolated JavaScript require no external analysis provider.
JavaScript has no network, files, secrets or Node access; `loadData()` supplies
only the bounded personal snapshot. For optional LLM rules, configure:

| Variable | Purpose |
|----------|---------|
| `NOTIFICATIONS_LLM_PROVIDER` | `anthropic` (only supported provider initially) |
| `NOTIFICATIONS_LLM_API_KEY` | Provider credential; server environment only |
| `NOTIFICATIONS_LLM_MODEL` | Explicit supported provider model id |
| `NOTIFICATIONS_LLM_DAILY_LIMIT` | Instance-wide requests/day UTC, default 100; 0 disables |

Numeric personal metrics and recent samples go to the external provider, not
names, emails, transcripts or recordings. Do not include secrets or personal
data in analysis instructions. Previews consume the same budget.
Calls have a ten-second timeout and 256 output-token limit; also configure a
provider-side spending cap. Disabled/misconfigured analysis never simulates
success. Rule/channel edits or permission/member removal cancel stale queued
alerts; an already-started remote send cannot be recalled. Full contract and
failure semantics are documented in `plugins/notifications/SPEC.md`.

Refunds/disputes are surfaced in personal billing and the admin pricing panel for
manual review. This release does not automatically claw back credits with active
escrow, issue cash refunds, or migrate existing subscriptions to new pricing.

#### Isolated verification

`tests/personal-billing.test.ts` runs only when `TEST_PERSONAL_DATABASE_URL` points
to a dedicated local database named `vox_billing_test`. Apply Core migrations to
that database first. Tests mock Stripe's remote API and SMTP while using real
signature verification, TOTP and PostgreSQL transactions. Browser checks in
`tests/e2e/personal-usage.spec.ts` require `PERSONAL_BILLING_E2E=1` and an isolated
server selected with `PLAYWRIGHT_BASE_URL`; default scenarios mock account APIs
and never make real purchases. `PERSONAL_BILLING_REAL_E2E=1` additionally tests
Core enrollment and a protected grant against the local port-5151 preview fixture
(`billing-preview@example.test`, initialized with dummy test-only credentials in
the spec); it resets the fixture's authenticator afterward. Never point this at
production. Do not run the shared dev-data purge gate against another agent's
database. Pre-create the dedicated plugin-test database before parallel legacy
plugin tests to avoid their existing CREATE DATABASE race.

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server listen port | `5000` |
| `COOKIE_SECURE` | Force the cookie `Secure` flag: `"true"`, `"false"`, or unset (on in production) | auto |
| `CREDENTIAL_ENCRYPTION_KEY` | 64 hex chars (AES-256-GCM) for stored secrets. Generate with `openssl rand -hex 32` | — |
| `APP_URL` | Public base URL, used for billing return links | `http://localhost:5000` |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` | Organization seat billing | — |
| `AGORA_APP_ID` / `AGORA_APP_CERTIFICATE` / `AGORA_CONVOAI_CONFIG` | Agora RTC and the Clash live moderator | — |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_REGION` | Artifact storage (S3 or Cloudflare R2). Without them, uploads are off and everything else works. | — |
| `WEB_SESSION_TTL_HOURS` | How long a minted login session stays fresh | `1` |
| `WEB_SESSION_MINT_TIMEOUT_SECONDS` | Upper bound on minting one login session | `180` |
| `GEOIP_DB_DIR` | Where GeoIP databases for eval-agent region detection live | `./geoip` |
| `MAXMIND_LICENSE_KEY` | Fallback only; normally set in Console → Regions. Without any key, the free DB-IP Lite database is used. | — |
| `VOX_CONTACT_EMAIL` / `VOX_GITHUB_URL` / `VOX_X_URL` | Footer contact links (the X icon is hidden when unset) | `vox@agora.build` / Vox repo / — |
| `RATE_LIMIT_DISABLED` | `"true"` turns API rate limiting off. Never set in production. | — |
| `VOX_STORAGE_ALLOW_PRIVATE` | `"1"` lets Tools → Analyze use a storage endpoint on a private address (e.g. MinIO on localhost). Local development only. Never set in production: Core connects to the endpoint a user types, and this guard keeps that off Core's own network. | — |

### Generating Secrets

```bash
# SESSION_SECRET and CREDENTIAL_ENCRYPTION_KEY
openssl rand -hex 32

# INIT_CODE (use any strong value)
openssl rand -hex 16
```

## Coolify Deployment

### 1. Create the Application

1. In Coolify, click **New Resource** > **Application**
2. Select your Git repository (GitHub, GitLab, etc.)
3. Set the branch to `main`
4. Coolify will auto-detect the `Dockerfile`

### 2. Configure Environment Variables

In the application's **Environment Variables** section, add at least:

```
DATABASE_URL=postgresql://user:password@host:5432/vox
SESSION_SECRET=<output of openssl rand -hex 32>
INIT_CODE=<your chosen init code>
NODE_ENV=production
VOX_PLUGINS=credits,shared-agents,organizations,oauth
```

If your PostgreSQL is a Coolify-managed database, use the internal hostname (e.g., `postgresql://vox:pass@vox-db:5432/vox`).

**Changing `VOX_PLUGINS` on a live instance:** a running container is unaffected until the next deploy, but a *restart* of the current build picks the new value up. So when a new plugin ships in a release, add it right before that release deploys — an older build that restarts with a plugin id it doesn't know will refuse to start.

### 3. Configure Network

- Set the exposed port to `5000`
- Configure your domain under the **Domains** tab
- Coolify handles SSL/TLS via Let's Encrypt automatically

### 4. Set Up Auto-Deploy (Optional)

The repo includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that calls Coolify's deploy webhooks on every push to `main`: one for the Vox service and one for the auth-session broker.

To enable it, in GitHub go to **Settings** > **Secrets and variables** > **Actions** and add:

| Secret | Value |
|--------|-------|
| `COOLIFY_WEBHOOK_URL` | Deploy webhook URL of the Vox application (Coolify > application > **Webhooks**) |
| `COOLIFY_BROKER_WEBHOOK_URL` | Deploy webhook URL of the auth-session broker application |
| `COOLIFY_TOKEN` | A Coolify API token, sent as the webhook's bearer token |

After this, every push to `main` triggers an automatic deployment.

### 5. Initialize the System

After the first deploy, initialize the admin account:

```bash
curl -X POST https://your-domain.com/api/auth/init \
  -H "Content-Type: application/json" \
  -d '{
    "code": "<your INIT_CODE>",
    "adminEmail": "admin@agora.build",
    "adminPassword": "a-strong-password",
    "adminUsername": "admin"
  }'
```

This creates the admin user and a Scout user (which needs separate activation). You only need to do this once.

### 6. Database Migrations

Migrations are plain SQL files in `migrations/`, applied by Vox's own version-based runner (`server/migrate.ts`, built to `dist/migrate.cjs`). The container runs it **before** the app starts (`node dist/migrate.cjs && node dist/index.cjs`), so a deploy applies pending migrations automatically; if one fails, the app does not start and the previous deploy keeps serving.

The database's current version is the single row in `_schema_version`. A database that predates the runner is detected on first start and baselined automatically — no manual steps.

**Never use `drizzle-kit push --force` (or `npm run db:push`) against production** — it diffs the live schema and can silently drop columns.

#### Developer workflow for schema changes

Every change to `shared/schema.ts` ships with a migration, in the same commit:

1. Edit `shared/schema.ts`.
2. Write the SQL by hand in a new numbered file in `migrations/`, following the existing numbering. (`npm run db:generate` no longer works for this project.)
3. Register the file in the `MIGRATIONS` array in `server/migrate.ts`. **An unregistered file is never applied.**
4. Commit all three together and push; the next deploy applies it.

Keep migration SQL plain — `CREATE TABLE`, `ALTER TABLE`, etc. No `IF NOT EXISTS` or `DO ... EXCEPTION`: each migration runs exactly once. One exception: when dropping a constraint, don't assume its name (local dev and production can name the same constraint differently) — drop both possible names with `IF EXISTS`.

Plugin migrations live in `plugins/<id>/migrations/`, are tracked in `_plugin_schema_versions`, and are checksummed: **editing a plugin migration after it has run anywhere stops that instance from starting.** Add a new one instead.

#### Local development

```bash
# Apply migrations to the local DB
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npm run db:migrate

# Full reset (wipe + re-apply schema + seed)
./scripts/dev-local-run.sh reset
```

#### Emergency: apply migrations without redeploying

```bash
# Coolify → application → terminal:
node dist/migrate.cjs
```

## Other Components

Vox itself is one container, but a full deployment also runs:

- **Eval agents** — run the evals, on hosts in each region. Install and upgrade with `scripts/vox-upgrade.sh` (reads `AGENT_TOKEN` and `VOX_SERVER` from an env file; see the README). Agents also run **Tools → Analyze** (uploaded recordings): an agent takes those only once it reports the `analyze` capability, which the agent image does from the release that added Analyze. Upgrade the public agents with that release, or uploads stay queued and fail after 24 hours.
- **Auth-session broker** and **REST broker** — sidecars (Dockerfile targets `broker` and `rest-broker` in `vox_eval_agentd/Dockerfile`) that log in to target sites and make API calls on behalf of evals, so credentials never reach an eval agent. Each registers with Vox using `VOX_CORE_URL` and a `BROKER_REG_TOKEN` minted in **Console → Brokers**, and must be reachable only on the internal network. `BROKER_ADVERTISE_URL` is the address **Vox** uses to call the broker, so it must resolve from the Vox container: on Coolify that is the broker's network alias, not its application UUID. Vox checks it when the broker registers and every minute after; **Console → Brokers** shows the result in the **From Core** column, with the reason when it can't connect.

## Other Platforms

The Dockerfile works with any Docker-based platform. The key differences are how you configure environment variables and networking.

### Railway

1. Connect your GitHub repo
2. Railway auto-detects the Dockerfile
3. Add environment variables in the **Variables** tab
4. Add a PostgreSQL plugin for the database — Railway sets `DATABASE_URL` automatically
5. Set `SESSION_SECRET`, `INIT_CODE`, `NODE_ENV=production` and `VOX_PLUGINS`

### Render

1. Create a new **Web Service** from your repo
2. Set the environment to **Docker**
3. Add environment variables in the **Environment** section
4. Create a PostgreSQL database under **New** > **PostgreSQL** and link it
5. Set `SESSION_SECRET`, `INIT_CODE`, `NODE_ENV=production` and `VOX_PLUGINS`

### CapRover

1. Create a new app in CapRover
2. Under **App Configs** > **Environmental Variables**, add the required variables and `VOX_PLUGINS`
3. Deploy via the CapRover CLI or connect your Git repo
4. Set up a PostgreSQL database via CapRover's one-click apps

### Docker Compose (Self-Hosted)

Use the included `docker-compose.yml` as a starting point. For production, override the defaults:

```yaml
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: vox
      POSTGRES_PASSWORD: <strong-password>
      POSTGRES_DB: vox
    volumes:
      - vox_postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U vox -d vox"]
      interval: 5s
      timeout: 5s
      retries: 5

  vox-service:
    build: .
    environment:
      DATABASE_URL: postgresql://vox:<strong-password>@postgres:5432/vox
      SESSION_SECRET: <output of openssl rand -hex 32>
      INIT_CODE: <your init code>
      NODE_ENV: production
      VOX_PLUGINS: credits,shared-agents,organizations,oauth
      PORT: 5000
    ports:
      - "5000:5000"
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  vox_postgres_data:
```

Put a reverse proxy (nginx, Caddy, Traefik) in front for SSL termination.

## Post-Deploy Checklist

- [ ] App starts without errors (`SESSION_SECRET` is set)
- [ ] Database is reachable (`DATABASE_URL` is correct)
- [ ] `GET /api/plugins` lists every plugin in `VOX_PLUGINS`
- [ ] System initialized via `/api/auth/init`
- [ ] Admin can log in at `/login`
- [ ] HTTPS is working (check the `Secure` cookie flag)
- [ ] Sign-in providers (if enabled): `GET /api/plugins/oauth/providers` shows them on, and each registered callback URL matches your domain
- [ ] Stripe webhook endpoint is registered (if enabled): `https://your-domain.com/api/webhooks/stripe`
- [ ] Tools → Analyze: at least one online public eval agent reports the `analyze` capability (Console → Eval Agents). Analyze keeps recordings in each user's own bucket (Storage page); Core needs no S3 settings for it. Core holds each upload in memory while it checks and stores it: at most 3 at once (≤ 100 MB each, so about 300 MB), one per user. These limits live in the Core process, like the rate limiter, which is right for Vox's single Core container; running several Core processes would need a shared limiter

## Troubleshooting

### `Error: SESSION_SECRET environment variable is required in production`

The `SESSION_SECRET` environment variable is not set. Add it to your platform's environment variables. Generate a value with `openssl rand -hex 32`.

### The server exits at startup with `unknown plugin in VOX_PLUGINS`

`VOX_PLUGINS` names a plugin this build doesn't have — usually a new plugin id set before the release containing it was deployed. Remove it or deploy the newer release.

### The server exits at startup with a plugin migration error

A plugin migration failed or was edited after it ran (`checksum mismatch`). Nothing was half-applied: the migration runs in a transaction. The message names the plugin and file; fix the cause (or restore the original file) and redeploy.

### Cookies not working / can't log in

If behind a reverse proxy, make sure:
- `NODE_ENV=production` is set (enables `trust proxy` and secure cookies)
- The proxy forwards `X-Forwarded-Proto` and `X-Forwarded-For` headers
- If not using HTTPS, set `COOKIE_SECURE=false` (not recommended for production)

### Database connection refused

- Verify `DATABASE_URL` uses the correct hostname. In Docker networks, use the service name (e.g., `postgres`) not `localhost`.
- Ensure the database is running and the port is accessible from the app container.

### GitHub or Google sign-in button missing

- Is `oauth` in `VOX_PLUGINS`? If credentials are set without it, the startup log says so.
- Are both the ID and the secret set for that provider? `GET /api/plugins/oauth/providers` shows which are on.

### Google `redirect_uri_mismatch`

Set `GOOGLE_CALLBACK_URL` to the full production URL, and register exactly the same value as an authorized redirect URI in Google Cloud Console:
```
GOOGLE_CALLBACK_URL=https://your-domain.com/api/plugins/oauth/google/callback
```
