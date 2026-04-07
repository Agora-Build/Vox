# Deployment Guide

This guide covers deploying Vox to production using Coolify, or any Docker-based hosting platform (Railway, Render, CapRover, etc.).

## Prerequisites

- A server or hosting platform that supports Docker
- A PostgreSQL database (managed or self-hosted)
- A domain name with DNS configured

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/vox` |
| `SESSION_SECRET` | Cryptographic key for signing session cookies. **Must be set in production** or the app will refuse to start. | Generate with `openssl rand -hex 32` |
| `INIT_CODE` | One-time code used to create the initial admin user via `/api/auth/init` | Any strong secret string |
| `NODE_ENV` | Must be `production` for production deployments | `production` |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server listen port | `5000` |
| `COOKIE_SECURE` | Force cookie secure flag: `"true"`, `"false"`, or unset (auto-detects from `NODE_ENV`) | auto |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID (enables Google sign-in) | — |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | — |
| `GOOGLE_CALLBACK_URL` | OAuth callback URL | `/api/auth/google/callback` |
| `STRIPE_SECRET_KEY` | Stripe secret key for payments | — |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key | — |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | — |

### Generating Secrets

```bash
# SESSION_SECRET
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

In the application's **Environment Variables** section, add:

```
DATABASE_URL=postgresql://user:password@host:5432/vox
SESSION_SECRET=<output of openssl rand -hex 32>
INIT_CODE=<your chosen init code>
NODE_ENV=production
```

If your PostgreSQL is a Coolify-managed database, use the internal hostname (e.g., `postgresql://vox:pass@vox-db:5432/vox`).

### 3. Configure Network

- Set the exposed port to `5000`
- Configure your domain under the **Domains** tab
- Coolify handles SSL/TLS via Let's Encrypt automatically

### 4. Set Up Auto-Deploy (Optional)

The repo includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that triggers a Coolify webhook on every push to `main`.

To enable it:

1. In Coolify, go to your application > **Webhooks** and copy the deploy webhook URL
2. In GitHub, go to **Settings** > **Secrets and variables** > **Actions**
3. Add a secret named `COOLIFY_WEBHOOK_URL` with the webhook URL

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

Vox uses **Drizzle ORM** with file-based migrations. Migration SQL files live in `migrations/` and are committed to git.

#### Coolify post-deploy command

In Coolify, under your application's **Post-deployment** settings, add:

```
DATABASE_URL=<your-url> npx drizzle-kit migrate
```

This runs once after each deploy and applies any pending migrations. It is idempotent — already-applied migrations are skipped.

> **Do not use `npx drizzle-kit push --force` in production.** It diffs the live schema against the Drizzle model and may drop columns or indexes without warning.

#### Developer workflow for schema changes

Every time you modify `shared/schema.ts`:

```bash
# 1. Generate a new migration file (needs a live DB for diffing)
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npm run db:generate

# 2. Review the generated SQL in migrations/
git diff migrations/

# 3. Commit the migration alongside the schema change
git add shared/schema.ts migrations/
git commit -m "feat: add <table/column description>"

# 4. Deploy — Coolify post-deploy command runs drizzle-kit migrate automatically
git push origin main
```

#### Local development

```bash
# Apply migrations to local DB
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npm run db:migrate

# Or use dev-local-run.sh which handles schema sync automatically:
./script/dev-local-run.sh reset   # wipes data + pushes schema + seeds
```

#### Emergency: manual migration on production

If Coolify post-deploy command is not configured or a migration needs to be applied immediately:

```bash
# In Coolify → application → terminal (or via SSH):
DATABASE_URL=<prod-url> npx drizzle-kit migrate
```

## Other Platforms

The Dockerfile works with any Docker-based platform. The key differences are how you configure environment variables and networking.

### Railway

1. Connect your GitHub repo
2. Railway auto-detects the Dockerfile
3. Add environment variables in the **Variables** tab
4. Add a PostgreSQL plugin for the database — Railway sets `DATABASE_URL` automatically
5. Set `SESSION_SECRET`, `INIT_CODE`, and `NODE_ENV=production`

### Render

1. Create a new **Web Service** from your repo
2. Set the environment to **Docker**
3. Add environment variables in the **Environment** section
4. Create a PostgreSQL database under **New** > **PostgreSQL** and link it
5. Set `SESSION_SECRET`, `INIT_CODE`, and `NODE_ENV=production`

### CapRover

1. Create a new app in CapRover
2. Under **App Configs** > **Environmental Variables**, add the required variables
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
- [ ] System initialized via `/api/auth/init`
- [ ] Admin can log in at `/login`
- [ ] HTTPS is working (check `Secure` cookie flag)
- [ ] Google OAuth callback URL matches your domain (if enabled)
- [ ] Stripe webhook endpoint is registered (if enabled): `https://your-domain.com/api/payments/webhook`

## Troubleshooting

### `Error: SESSION_SECRET environment variable is required in production`

The `SESSION_SECRET` environment variable is not set. Add it to your platform's environment variables. Generate a value with `openssl rand -hex 32`.

### Cookies not working / can't log in

If behind a reverse proxy, make sure:
- `NODE_ENV=production` is set (enables `trust proxy` and secure cookies)
- The proxy forwards `X-Forwarded-Proto` and `X-Forwarded-For` headers
- If not using HTTPS, set `COOKIE_SECURE=false` (not recommended for production)

### Database connection refused

- Verify `DATABASE_URL` uses the correct hostname. In Docker networks, use the service name (e.g., `postgres`) not `localhost`.
- Ensure the database is running and the port is accessible from the app container.

### Google OAuth redirect mismatch

Set `GOOGLE_CALLBACK_URL` to the full production URL:
```
GOOGLE_CALLBACK_URL=https://your-domain.com/api/auth/google/callback
```
This must match the authorized redirect URI in your Google Cloud Console.
