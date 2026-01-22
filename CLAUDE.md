# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Vox is an AI latency benchmark platform for conversational AI products. It runs automated benchmark tests across multiple regions (NA, APAC, EU) to monitor response latency, interrupt latency, network resilience, naturalness, and noise reduction for AI voice agents.

## Development Commands

### Build & Development
```bash
npm install                 # Install dependencies
npm run dev                # Start development server (default port 5000)
npm run build              # Build for production
npm start                  # Start production server
```

### Quality Checks
```bash
npm run check              # TypeScript type checking
npm run lint               # ESLint
npm test                   # Run tests with Vitest (requires running server on port 5000)
npm run test:watch         # Run tests in watch mode
```

### Database
```bash
npm run db:push            # Push schema changes to database (uses Drizzle Kit)
```

### Environment Variables
Required:
- `DATABASE_URL` - PostgreSQL connection string (e.g., `postgresql://user:pass@localhost:5432/vox`)
- `SESSION_SECRET` - Session encryption key
- `INIT_CODE` - System initialization code (used during first-time setup)

Optional:
- `PORT` - Server port (default: 5000)
- `GOOGLE_CLIENT_ID` - Google OAuth client ID (enables Google sign-in)
- `GOOGLE_CLIENT_SECRET` - Google OAuth client secret
- `GOOGLE_CALLBACK_URL` - OAuth callback URL (default: `/api/auth/google/callback`)

## Architecture

### Monorepo Structure

- **client/** - React frontend (Vite + TypeScript)
- **server/** - Express backend (Node.js + TypeScript)
- **shared/** - Shared types and database schema (Drizzle ORM)
- **tests/** - Test files (Vitest)
- **script/** - Build scripts

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
The system uses distributed eval agents to run benchmark tests:
1. Admin creates eval agent tokens with region assignments
2. Eval agents register using tokens (`evalAgentTokens` table)
3. Agents fetch jobs matching their region (`evalJobs` table with `pending` → `running` → `completed`/`failed` status)
4. Agents execute tests using external `voice-agent-tester` tool and report results to `evalResults` table
5. Results are linked to `workflows` and `evalSets` via foreign keys

**Important:** The codebase recently underwent a refactor where "workers" were renamed to "eval agents" and "testSets" to "evalSets". Some UI text may still reference old terminology.

#### User & Organization System
- **User Plans:** `basic` (free), `premium` (paid), `principal` (Scout, internal), `fellow` (external prestige)
- **Admin Flag:** `isAdmin` for system management (only admins can create eval agent tokens, verify orgs, approve fund returns)
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

**Admin (`/api/admin/*`):** (requires `requireAdmin` middleware)
- `GET/PATCH /api/admin/users` - User management
- `POST /api/admin/invite` - Create invite tokens
- `GET/POST /api/admin/eval-agent-tokens` - Manage eval agent tokens
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
- `GET /api/eval-agents` - List all agents (public)
- `GET /api/metrics/realtime` - Real-time metrics
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

Test framework: **Vitest**

**Running tests:**
```bash
# Tests require a running server on port 5000 with initialized database
npm run dev &                    # Start server in background
npm test                         # Run tests
```

**Test file:** `tests/api.test.ts` - Integration tests for API endpoints

**Important:** The test file currently uses **old terminology** (workers, test-cases, vendors) that doesn't match the refactored codebase. The tests may need updating to match current API routes (eval-agents, eval-sets, etc.).

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

**Completed phases:**
- Phase 1: Core system (database schema, basic routes, seed data)
- Phase 2: API key security (prefix-based keys, rate limiting, usage tracking)
- Phase 3: Google OAuth integration (Passport.js, account linking)

**Remaining phases** (see `designs/IMPLEMENTATION_PLAN.md`):
- Phase 4: Organization system with Stripe payments
- Phase 5: Eval agent concurrency control with atomic job claims
- Phase 6: Frontend polish (rename routes like `/dive`, `/run-your-own`)
- Phase 7: Public REST API for external integration
- Phase 8: Comprehensive test coverage

## Important Files

- `shared/schema.ts` - Single source of truth for all data models (18 tables, 6 enums)
- `server/routes.ts` - All API endpoints (~1200 lines, monolithic by design)
- `server/storage.ts` - Database abstraction layer (DatabaseStorage class)
- `server/auth.ts` - Authentication utilities and middleware
- `client/src/App.tsx` - Route definitions and page layouts
- `designs/IMPLEMENTATION_PLAN.md` - Detailed specs and implementation phases
- `designs/vox-arch.png` - Low-level architecture diagram
- `tests/api.test.ts` - API integration tests (uses old terminology, may need updates)

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
- **Vitest** - Testing framework
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
- The eval agent system expects external `voice-agent-tester` tool for actual benchmark execution
  - Example: `npm start -- -a apps/livekit.yaml -s suites/appointment.yaml --headless false`
- Architecture diagram available at `designs/vox-arch.png`
