# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Vox is an AI latency evaluation platform for conversational AI products. It runs automated evaluation tests across multiple regions (NA, APAC, EU) to monitor response latency, interrupt latency, network resilience, naturalness, and noise reduction for AI voice agents.

## Development Commands

### Build & Development
```bash
npm install                 # Install dependencies
npm run dev                # Start development server (default port 5000)
npm run build              # Build for production
npm start                  # Start production server
```

### Local Development Server (Recommended)
Use the `dev-local-run.sh` script to start a complete local environment with PostgreSQL, Vox service, and eval agent:

```bash
# Start all services (PostgreSQL in Docker, Vox service and eval agent as local processes)
./scripts/dev-local-run.sh start

# Start with multi-region eval agents (na, apac, eu)
./scripts/dev-local-run.sh --multi-region start

# Stop all services
./scripts/dev-local-run.sh stop

# Reset database and restart (WARNING: deletes all data)
./scripts/dev-local-run.sh reset

# Show status of all services
./scripts/dev-local-run.sh status

# View logs
./scripts/dev-local-run.sh logs server    # Server logs
./scripts/dev-local-run.sh logs agent     # Eval agent logs

# Docker mode (all services in containers)
./scripts/dev-local-run.sh docker start
./scripts/dev-local-run.sh docker stop
```

**Default Credentials (after init):**
- Admin: `admin@vox.local` / `admin123456`
- Scout: `scout@vox.ai` / `scout123`

### Quality Checks
```bash
npm run check              # TypeScript type checking
npm run lint               # ESLint
```

### Database
```bash
# Local dev only — direct schema sync, never use in production
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npm run db:push

# Generate migration from schema changes (run this after every shared/schema.ts change)
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npm run db:generate

# Apply pending migrations
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npm run db:migrate

# Utilities
npm run db:studio          # Open Drizzle Studio (database GUI)
```

**RULE — Every `shared/schema.ts` change must include a migration:**
1. Change `shared/schema.ts`
2. `DATABASE_URL=... npm run db:generate` → creates file in `migrations/`
3. Review the generated SQL — confirm it only changes what you intended
4. Commit migration file in the same commit as the schema change
5. Push → migrations apply automatically on next app startup

**Never use `db:push` or `drizzle-kit push --force` in production** — it diffs the live schema and can silently drop columns.

**Migrations run automatically on startup** via a custom version-based runner in `server/migrate.ts` (NOT drizzle-orm's `migrate()`). The `npm start` script runs `node dist/migrate.cjs` before starting the app. **Every new migration file must be registered** in the `MIGRATIONS` array in `server/migrate.ts` — an unregistered SQL file will never be applied.

**Keep migration SQL clean** — plain `CREATE TABLE`, `ALTER TABLE`, etc. No `IF NOT EXISTS` or `DO ... EXCEPTION` tricks. Each migration runs exactly once on a DB that doesn't have it yet.

**Existing databases are handled automatically** — startup code in `server/index.ts` detects databases with existing schema but no drizzle migration history, marks migration 0000 as applied, and only runs new migrations. No manual steps needed.

**seed-data.ts is local dev only** — called by `dev-local-run.sh` to activate Scout and create the mainline workflow. Production bootstrap (providers, pricing, users) is handled by `/api/auth/init`.

### Environment Variables
Required:
- `DATABASE_URL` - PostgreSQL connection string (e.g., `postgresql://user:pass@localhost:5432/vox`)
- `SESSION_SECRET` - Session encryption key
- `INIT_CODE` - System initialization code (used during first-time setup)

Optional:
- `CREDENTIAL_ENCRYPTION_KEY` - 32-byte hex key (64 hex chars) for AES-256-GCM secret encryption. Required for the secrets feature. Generate with: `openssl rand -hex 32`
- `PORT` - Server port (default: 5000)
- `GOOGLE_CLIENT_ID` - Google OAuth client ID (enables Google sign-in)
- `GOOGLE_CLIENT_SECRET` - Google OAuth client secret
- `GOOGLE_CALLBACK_URL` - OAuth callback URL (default: `/api/auth/google/callback`)
- `GITHUB_CLIENT_ID` - GitHub OAuth client ID (enables GitHub sign-in)
- `GITHUB_CLIENT_SECRET` - GitHub OAuth client secret
- `GITHUB_CALLBACK_URL` - OAuth callback URL (default: `/auth/github/callback`)

## Architecture

### Monorepo Structure

- **client/** - React frontend (Vite + TypeScript)
- **server/** - Express backend (Node.js + TypeScript)
- **shared/** - Shared types and database schema (Drizzle ORM)
- **tests/** - Test files (Vitest)
- **scripts/** - Build scripts

### Key Architectural Patterns

#### Database-First Design
The entire data model is defined in `shared/schema.ts` using Drizzle ORM. All tables, enums, and types are exported from this single source of truth. Changes to data models should start here.

**Database Tables:**
- `organizations`, `users` - User and org management
- `providers` - AI product providers (SKUs: `convoai`, `rtc`)
- `projects`, `workflows`, `evalSets` - Test configuration hierarchy
- `evalAgentTokens`, `evalAgents` - Distributed eval agent system
- `evalJobs`, `evalResults` - Job queue and results storage
- `apiKeys`, `pricingConfig`, `paymentMethods`, `paymentHistories`, `organizationSeats` - Billing
- `activationTokens`, `inviteTokens`, `systemConfig`, `fundReturnRequests` - System utilities

**Enums:**
- `userPlanEnum`: `basic`, `premium`, `principal`, `fellow`
- `regionEnum`: `na`, `apac`, `eu`
- `providerSkuEnum`: `convoai`, `rtc`
- `evalAgentStateEnum`: `idle`, `offline`, `occupied`
- `evalJobStatusEnum`: `pending`, `running`, `completed`, `failed`
- `visibilityEnum`: `public`, `private`

#### Eval Agent System (Renamed from Workers)
The system uses distributed eval agents to run evaluation tests:
1. Admin or non-basic users create eval agent tokens with region assignments (admin can set public/private visibility; non-admin tokens are always private)
2. Eval agents register using tokens (`evalAgentTokens` table, which includes a `visibility` column)
3. Agents fetch jobs matching their region (`evalJobs` table with `pending` → `running` → `completed`/`failed` status)
4. Agents execute tests using external `voice-agent-tester` tool and report results to `evalResults` table
5. Results are linked to `workflows` and `evalSets` via foreign keys

**3-Tier Eval Classification:**
Results are classified into tiers based on the visibility/mainline flags of the workflow, eval set, and agent token:
- **Mainline**: workflow is public+mainline AND eval set is public+mainline AND agent token is public → shown on `/api/metrics/realtime`
- **Community**: workflow and eval set are both public, but NOT fully mainline → shown on `/api/metrics/community`
- **My Evals**: workflow or eval set is private, visible only to the owner → shown on `/api/metrics/my-evals` (requires auth)

**Important:** The codebase recently underwent a refactor where "workers" were renamed to "eval agents" and "testSets" to "evalSets". Some UI text may still reference old terminology.

#### User & Organization System
- **User Plans:** `basic` (free), `premium` (paid), `principal` (Scout, internal), `fellow` (external prestige)
- **Admin Flag:** `isAdmin` for system management (admins can create public/private eval agent tokens, verify orgs, approve fund returns; non-basic users can create private tokens)
- **Organizations:** Users can create/join organizations for team collaboration
  - First user becomes org admin
  - Orgs can purchase Premium seats with volume discounts (stored in `pricingConfig`)
  - Org limits: 100 projects max, 20 workflows per project
- **Scout User:** Created during system initialization along with admin (needs activation)

#### Security Model
All sensitive tokens are hashed with SHA256 before database storage:
- Activation tokens
- Invite tokens
- Eval agent tokens
- API keys

Passwords use bcrypt hashing (salt built-in). See `server/storage.ts:hashToken()` and `server/auth.ts:hashPassword()`.

#### Project & Workflow Organization
- **Projects** (`projects` table) - Organizational containers for workflows
  - Basic users: 5 projects, 10 workflows each
  - Premium users: 20 projects, 20 workflows each
  - Organizations: 100 projects, 20 workflows each
- **Workflows** (`workflows` table) - Define test execution steps
- **Eval Sets** (`evalSets` table) - Define test scenarios to run
- **Visibility:** Both workflows and eval sets can be `public` or `private` (Premium+ only)
- **Mainline Flag:** Principal/Fellow users can mark workflows as "mainline" for leaderboard display

### Frontend Architecture

#### Routing
Uses **Wouter** (lightweight React router). Routes defined in `client/src/App.tsx`:
- Public pages: `/`, `/realtime` (dashboard), `/leaderboard`, `/dive` (provider info), `/run-your-own` (self-test entry point)
- Auth pages: `/login`, `/activate/:token`
- Console pages: `/console/*` (protected routes with `ConsoleLayout`)
- Admin pages: `/admin/login`, `/admin/console/*` (admin-only routes)

#### State Management
- **TanStack React Query** for server state (API calls, caching)
- **React Context** for theme (ThemeProvider)
- Session-based authentication (Express sessions)

#### UI Components
Uses **shadcn/ui** component library with Radix UI primitives. Components located in `client/src/components/ui/`. Data visualization with **Recharts**, animations with **Framer Motion**.

### Backend Architecture

#### Server Entry Point
`server/index.ts` - Sets up Express, session middleware, registers routes, starts HTTP server

#### Route Registration
All API routes defined in `server/routes.ts` using functional registration pattern:
```typescript
export async function registerRoutes(httpServer: Server, app: Express): Promise<Server>
```

#### Authentication & Authorization
`server/auth.ts` provides:
- `getCurrentUser(req)` - Get current user from session
- `requireAuth` - Middleware to protect routes (401 if not logged in)
- `requireAdmin` - Middleware for admin-only routes
- `requirePrincipal` - Middleware for Principal/Fellow users
- `authenticateApiKey` - Middleware for API key auth (Bearer token with `vox_live_` prefix)
- `requireAuthOrApiKey` - Accept either session or API key auth
- Password hashing with bcrypt
- Token generation utilities
- Google OAuth via Passport.js

**Rate Limiting:** API routes are rate-limited (100 req/15min general, 20 req/15min for auth endpoints)

#### Data Access Layer
`server/storage.ts` exports a singleton `DatabaseStorage` instance as `storage`:
```typescript
export const storage = new DatabaseStorage();
```

All database operations go through this abstraction. Uses Drizzle ORM for type-safe queries.

#### Static Asset Handling
`server/static.ts` - Serves static files in production (built assets from `dist/public`)

#### Vite Integration
`server/vite.ts` - Development-only Vite middleware for HMR

### API Routes Structure

All routes defined in `server/routes.ts`:

**Auth (`/api/auth/*`):**
- `GET /api/auth/status` - Check auth status and system initialization
- `POST /api/auth/init` - Initialize system (first-time setup, creates admin + Scout user)
- `POST /api/auth/login`, `/logout`, `/activate`, `/register`
- `GET /api/auth/google` - Initiate Google OAuth flow
- `GET /api/auth/google/callback` - Google OAuth callback
- `GET /api/auth/google/status` - Check if Google OAuth is enabled

**API Keys (`/api/user/api-keys`):** (requires auth)
- `GET /api/user/api-keys` - List user's API keys
- `POST /api/user/api-keys` - Create new API key (returns key once, never again)
- `POST /api/user/api-keys/:id/revoke` - Revoke an API key
- `DELETE /api/user/api-keys/:id` - Delete an API key

**Eval Agent Tokens (`/api/eval-agent-tokens`):** (requires auth, non-basic users)
- `GET /api/eval-agent-tokens` - List tokens (admin sees all, non-admin sees own)
- `POST /api/eval-agent-tokens` - Create token (admin: public/private; non-admin: private only; basic: 403)
- `POST /api/eval-agent-tokens/:id/revoke` - Revoke token (owner or admin)

**Admin (`/api/admin/*`):** (requires `requireAdmin` middleware)
- `GET/PATCH /api/admin/users` - User management
- `POST /api/admin/invite` - Create invite tokens
- `GET/POST /api/admin/eval-agent-tokens` - Manage eval agent tokens (legacy admin-only endpoints)
- `POST /api/admin/eval-agent-tokens/:id/revoke`

**Resources:**
- `GET/POST /api/providers` - Provider management (POST requires admin)
- `GET/POST /api/projects`, `/api/projects/:id` - Project CRUD
- `GET/POST/PATCH /api/workflows`, `/api/workflows/:id` - Workflow CRUD
- `PATCH /api/workflows/:id/mainline` - Toggle mainline (requires Principal/Fellow)
- `POST /api/workflows/:workflowId/run` - Create eval job
- `GET/POST /api/eval-sets`, `PATCH /api/eval-sets/:id/mainline`

**Eval Agent (`/api/eval-agent/*`):** (Bearer token auth)
- `POST /api/eval-agent/register` - Register new agent
- `POST /api/eval-agent/heartbeat` - Agent heartbeat
- `GET /api/eval-agent/jobs` - Get pending jobs for region
- `POST /api/eval-agent/jobs/:jobId/claim` - Claim a job
- `POST /api/eval-agent/jobs/:jobId/complete` - Complete job with results

**Public:**
- `GET /api/eval-agents` - List all agents with token visibility (public)
- `GET /api/metrics/realtime` - Mainline metrics (public)
- `GET /api/metrics/community` - Community metrics (public)
- `GET /api/metrics/my-evals` - User's private eval metrics (requires auth)
- `GET /api/metrics/leaderboard` - Aggregated leaderboard
- `GET /api/config` - System config

## Implementation Guidelines

### KISS Principle
Keep implementations simple. The codebase values straightforward, readable code over clever abstractions. Don't over-engineer solutions.

### Security-First
- Never store tokens/keys in plaintext (always hash with `hashToken()` before storage)
- All passwords must use bcrypt via `hashPassword()`
- Validate inputs with Zod schemas (see `shared/schema.ts` for insert schemas)
- API keys should be prefixed (e.g., `vox_live_xxxx`) and only shown once at creation

### Modular & API-Ready
The platform is designed to be web-first but API-ready. Future integrations include CLI tools and mobile apps. When adding features, consider how they would work via REST API.

## Testing

### Test Frameworks
- **Vitest** - Unit and integration tests
- **Playwright** - End-to-end browser tests

### Environment & Test Data Files

**Design Pattern:**
- **Local dev**: `*.dev` files loaded by app/service/AI
- **CI/CD**: Environment variables from CI secrets (no files)

| Context | Env Vars | Test Data |
|---------|----------|-----------|
| Local Dev | `.env.dev` (file) | `tests/tests.dev.data` (file) |
| CI/CD | CI secrets/environment | CI secrets/environment |

All files are gitignored. CI/CD sets environment variables directly from secrets.

**For local development**, create these files:

`.env.dev`:
```bash
# Google OAuth
GOOGLE_CLIENT_ID=<client-id>
GOOGLE_CLIENT_SECRET=<client-secret>

# Stripe test keys
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
```

`tests/tests.dev.data`:
```bash
# Vox test user credentials
# Admin: admin@vox.local / admin123456
# Scout: scout@vox.ai / scout123

# Google OAuth testing account
# Email: <test-email>
# Password: <test-password>
```

The `dev-local-run.sh` script loads `.env` then `.env.dev` automatically.

**Important for tests**: Copy `.env.dev` to `.env` before running tests:
```bash
cp .env.dev .env
```

**Stripe test mode**: When using Stripe test keys (`sk_test_*`), seat purchases work without a payment method (test mode). This allows testing the full purchase flow without actual payments.

### Running Tests

```bash
# Start local server first (required for integration and E2E tests)
./scripts/dev-local-run.sh start

# Run ALL tests (unit + audio + E2E) - recommended
./scripts/full-tests-run.sh       # Runs all tests

# Unit and Integration Tests (Vitest)
npm test                         # Run all tests
npm run test:watch               # Run in watch mode

# Clash Runner Audio Pipeline Test (Docker)
./scripts/full-tests-run.sh audio                    # Via test runner
docker build -t vox-clash-runner-test ./vox_clash_runner  # Or manually
docker run --rm vox-clash-runner-test bash /app/audio/test-audio-pipeline.sh

# End-to-End Tests (Playwright)
npx playwright test              # Run all E2E tests
npx playwright test --ui         # Run with Playwright Test UI
npx playwright test --headed     # Run in headed browser mode
```

**Full Test Runner** (`./scripts/full-tests-run.sh`):
- Loads environment from `.env` and `.env.dev` automatically
- Verifies server is running
- Runs unit tests (Vitest), audio pipeline (Docker), then E2E tests (Playwright)
- Displays test accounts and credentials summary

### Test Files

| File | Type | Tests | Description |
|------|------|-------|-------------|
| `tests/api.test.ts` | Integration | 107+ | API endpoints (auth, workflows, jobs, organizations) |
| `tests/auth.test.ts` | Unit | 26 | Password hashing, token generation |
| `tests/cron.test.ts` | Unit | 32 | Cron expression parsing and validation |
| `tests/eval-agent-daemon.test.ts` | Unit | 86 | Eval agent result parsing, metrics calculation, API communication |
| `tests/agora.test.ts` | Unit | 45 | Agora token gen, ConvoAI payload, UID reservation |
| `tests/agora-e2e.test.ts` | E2E | 13 | Real ConvoAI API: start/speak/stop (requires .env.dev credentials) |
| `tests/clash-runner.test.ts` | Unit | 44 | Runner logic, secret resolution, Elo calculation |
| `tests/clash-runner-lifecycle.test.ts` | Integration | 60 | Full runner lifecycle: tokens, registration, matches, moderator |
| `tests/clash-v2.test.ts` | Unit | 45 | WebSocket hub, cron, Agora prompts |
| `vox_clash_runner/audio/test-audio-pipeline.sh` | Docker | 12 | PipeWire stack, sinks, capture, cross-wire, C++ binaries |
| `tests/e2e/auth.spec.ts` | E2E | 5 | Login, logout, authentication flows |
| `tests/e2e/api.spec.ts` | E2E | 17 | Public API, protected endpoints, rate limiting |
| `tests/e2e/public-pages.spec.ts` | E2E | 9 | Landing page, leaderboard, API docs |
| `tests/e2e/console.spec.ts` | E2E | 9 | Console access control, admin routes |

**Total: 400+ tests**

### Test Coverage by Module

- **Main Vox API**: Auth, workflows, jobs, eval sets, organizations, API keys
- **Eval Agent Daemon**: Result parsing, CSV handling, API communication
- **Auth Utilities**: Password hashing, bcrypt verification
- **Cron Parsing**: Expression validation, next run calculation
- **E2E**: Public pages, authentication, API endpoints, access control

When adding new features, write tests for critical paths like authentication, job assignment, and payment flows.

## Common Development Tasks

### Adding a New Database Table
1. Define table in `shared/schema.ts` with Drizzle schema
2. Add insert/select types with Zod validation
3. Run `npm run db:push` to sync to database
4. Add storage methods in `server/storage.ts`
5. Create API routes in `server/routes.ts`

### Adding a New API Route
1. Add route handler in `server/routes.ts` inside `registerRoutes()`
2. Use appropriate auth middleware (`requireAuth`, `requireAdmin`, etc.)
3. Call storage methods for data access
4. Return JSON responses with proper error handling

### Adding a New Page
1. Create page component in `client/src/pages/`
2. Add route in `client/src/App.tsx`
3. Use `ConsoleLayout` wrapper for protected console pages
4. Use TanStack Query hooks for API calls (see existing pages for patterns)

## Project Roadmap

**All phases complete!** See `designs/IMPLEMENTATION_PLAN.md` for details.

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 1 | Core system (database schema, routes, seed data) | ✅ Complete |
| Phase 2 | API key security (prefix-based keys, rate limiting) | ✅ Complete |
| Phase 3 | Google OAuth integration (Passport.js) | ✅ Complete |
| Phase 4 | Organization system + Stripe payments | ✅ Complete |
| Phase 5 | Eval agent concurrency + scheduling | ✅ Complete |
| Phase 6 | Frontend updates (dashboard, leaderboard) | ✅ Complete |
| Phase 7 | API documentation (OpenAPI/Swagger) | ✅ Complete |
| Phase 8 | Comprehensive tests (unit, integration, E2E) | ✅ Complete |

### API Documentation
- **Swagger UI**: `/api/docs` - Interactive API documentation
- **OpenAPI Spec**: `/api/v1/openapi.json` - Machine-readable spec
- **Source**: `docs/openapi.yaml` - Full OpenAPI 3.0 specification

## Important Files

### Core
- `shared/schema.ts` - Single source of truth for all data models (18 tables, 6 enums)
- `server/routes.ts` - All API endpoints (~1200 lines, monolithic by design)
- `server/routes-api-v1.ts` - Versioned API v1 endpoints
- `server/storage.ts` - Database abstraction layer (DatabaseStorage class)
- `server/auth.ts` - Authentication utilities and middleware
- `server/stripe.ts` - Stripe payment integration
- `client/src/App.tsx` - Route definitions and page layouts

### Documentation & Design
- `designs/IMPLEMENTATION_PLAN.md` - Detailed specs and implementation phases
- `designs/vox-arch.png` - Low-level architecture diagram
- `docs/openapi.yaml` - OpenAPI 3.0 specification for API v1

### Scripts
- `scripts/dev-local-run.sh` - Local development environment setup

### Tests
- `tests/tests.dev.data` - Test accounts for local dev (gitignored)
- `tests/api.test.ts` - API integration tests (107+ tests)
- `tests/auth.test.ts` - Auth utilities unit tests (26 tests)
- `tests/cron.test.ts` - Cron parsing unit tests (32 tests)
- `tests/eval-agent-daemon.test.ts` - Eval agent daemon tests (18 tests)
- `tests/e2e/*.spec.ts` - Playwright E2E tests (39 tests)
- `playwright.config.ts` - Playwright configuration

### Eval Agent Daemon
- `vox_eval_agentd/vox-agentd.ts` - Eval agent daemon (single source for Docker & local dev)
- `vox_eval_agentd/Dockerfile` - Eval agent Docker image (compiles TS via esbuild)
- `vox_eval_agentd/aeval-data/` - aeval runtime data (git submodule: corpus, config, examples)
- `vox_eval_agentd/applications/` - Application config files (YAML)
- `vox_eval_agentd/scenarios/` - Test scenario config files (YAML)

#### Eval Frameworks
Two eval frameworks are supported:
- **aeval** (default) — single-binary Python evaluator with JSON metrics output
- **voice-agent-tester** — Node/Puppeteer evaluator with CSV report output

#### System Dependencies (aeval framework)
aeval requires two system packages for its audio analysis pipeline:
- **`libsndfile1`** — C library for reading audio files (WAV, FLAC, OGG). Used by PySoundFile in energy VAD and librosa in STT/Whisper.
- **`ffmpeg`** — Required for decoding WebM/Opus recordings. Browser recordings are saved as `.webm`; libsndfile can't decode this format, so librosa falls back to audioread which needs ffmpeg.

Without these, energy VAD and STT both fail with `NoBackendError` — VAD falls back to events-only (losing interrupt detection), and STT produces an empty transcript.

```bash
# Ubuntu/Debian (including Docker)
sudo apt install libsndfile1 ffmpeg

# macOS
brew install libsndfile ffmpeg
```

The Dockerfile already includes both. For local dev, install them on your host machine.

#### Latency Metrics Calculation (aeval framework)
aeval runs a scenario (e.g. `smoke_test_en_livekit.yaml`), records audio, and runs an analysis pipeline that produces `metrics.json`. The daemon reads this file and maps it to Vox's `evalResults` schema:

**`responseLatencyMedian`** — Response latency median (milliseconds):
- **Source**: Computed from `response_metrics.latency.turn_level[].latency_ms` array
- **What it measures**: Time from when the user finishes speaking to when the AI agent starts responding (first-byte latency)
- **Formula**: True median — sort values, take middle element (odd count) or average of two middle elements (even count)
- **Fallback chain**: turn_level median → `summary.p50_latency_ms` → `aggregated_summary.avg_response_latency_ms`
- **Negative latencies** (overlapping speech) are filtered out before calculation

**`responseLatencySd`** — Response latency standard deviation (milliseconds):
- **Source**: Computed from `response_metrics.latency.turn_level[].latency_ms` array
- **Formula**: Population standard deviation: `SD = sqrt( Σ(xi - mean)² / n )`
  - `xi` = latency of each turn, `mean` = average of all turns, `n` = number of turns
- **Requires**: At least 2 valid turn-level samples; if < 2: SD = 0

**`interruptLatencyMedian`** — Interrupt reaction time median (milliseconds):
- **Source**: Computed from `interruption_metrics.latency.turn_level[].reaction_time_ms` array
- **What it measures**: Time for the agent to stop speaking after being interrupted
- **Fallback chain**: turn_level median → `summary.p50_reaction_time_ms` → `aggregated_summary.avg_interruption_reaction_ms`

**`interruptLatencySd`** — Interrupt latency standard deviation (milliseconds):
- **Source**: Computed from `interruption_metrics.latency.turn_level[].reaction_time_ms`
- **Formula**: Same population SD formula as response latency

**Job failure policy**: If aeval exits with non-zero code (e.g. target agent timeout), the job is marked as failed. Partial results are not reported to avoid polluting metrics with statistically unreliable data.

## External Dependencies

Key runtime dependencies:
- **Drizzle ORM** - Type-safe database queries
- **Express** - Web server framework
- **React 19** - UI framework
- **Vite** - Build tool and dev server
- **Wouter** - Client-side routing
- **TanStack React Query** - Server state management
- **Zod** - Runtime validation
- **shadcn/ui** - Component library
- **Passport.js** - Authentication middleware (Google OAuth)
- **express-rate-limit** - API rate limiting

Development dependencies:
- **TypeScript 5.6.3** - Type checking
- **ESLint** - Linting with TypeScript rules
- **Vitest** - Unit and integration testing
- **Playwright** - End-to-end browser testing
- **tsx** - TypeScript execution for dev server

## Deployment

- **CI/CD:** GitHub Actions triggers Coolify webhook on push to main (`.github/workflows/deploy.yml`)
- Production build creates `dist/` directory with bundled assets
- Database migrations handled by Drizzle Kit (`npm run db:push` for schema sync)

## Notes

- The application listens on port **5000** by default (configurable via `PORT` env var)
- First-time setup requires `INIT_CODE` to create admin user via `/api/auth/init`
- System creates two users on init: admin (active) and Scout (needs activation)
- Default providers seeded: "Agora ConvoAI Engine" and "LiveKit Agents" (both with `convoai` SKU)
- The eval agent daemon supports two frameworks: `aeval` (default, binary) and `voice-agent-tester` (Node/Puppeteer)
  - aeval: `aeval run scenario.yaml` — produces `metrics.json` with latency data
  - voice-agent-tester: `npm start -- -a apps/livekit.yaml -s suites/appointment.yaml --headless false` — produces CSV report
- Architecture diagram available at `designs/vox-arch.png`
