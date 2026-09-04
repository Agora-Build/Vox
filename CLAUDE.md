# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Working Conventions

- **Reviewing design files:** serve any markdown deliverable for user review with `atem serv files <path>` and surface the **Custom URL** (`genie.netbird.cloud:<port>/...`) — that's the reachable/shareable link. Use `--background` while iterating; manage with `atem serv list` / `atem serv kill files-<port>`.
- **Dev vs test scripts:** `scripts/dev-local-run.sh` = local **service setup** (PostgreSQL + Vox service + eval agent); `scripts/full-tests-run.sh` = the **test runner** (unit + audio + E2E). Not interchangeable.
- **Pre-merge gate:** run `./scripts/full-tests-run.sh` (the full suite, not just `npm test`) before every PR merge.

## Project Overview

Vox is an AI latency evaluation platform for conversational AI products. Distributed eval agents run automated tests across regions (NA, APAC, EU) measuring response latency, interrupt latency, network resilience, naturalness, and noise reduction for AI voice agents.

## Commands

```bash
npm install / npm run dev / npm run build / npm start   # dev server on port 5000
npm run check              # TypeScript
npm run lint               # ESLint

./scripts/dev-local-run.sh start|stop|reset|status      # local env (Postgres in Docker + service + agent)
./scripts/dev-local-run.sh --multi-region start         # na/apac/eu agents
./scripts/dev-local-run.sh logs server|agent
./scripts/dev-local-run.sh docker start|stop            # all-in-containers mode
```

Default credentials after init — Admin: `admin@vox.local` / `admin123456`, Scout: `scout@vox.ai` / `scout123`.

## Database & Migrations

Schema lives in `shared/schema.ts` (single source of truth: tables, enums, Zod insert/select schemas). Data-model changes start there.

```bash
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npm run db:generate  # after every schema.ts change
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npm run db:migrate   # apply pending
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npm run db:push      # local dev ONLY — never production
npm run db:studio
```

**RULE — every `shared/schema.ts` change ships with a migration:**
1. `db:generate` → review the generated SQL (only what you intended)
2. Register the file in the `MIGRATIONS` array in `server/migrate.ts` — migrations run via a custom version-based runner (`node dist/migrate.cjs` before app start), and an unregistered SQL file is **never applied**
3. Commit migration + schema change together; migrations apply automatically on next startup

Keep migration SQL plain (`CREATE TABLE`, `ALTER TABLE`) — no `IF NOT EXISTS` / `DO ... EXCEPTION`; each runs exactly once. Never `db:push`/`drizzle-kit push --force` in production (can silently drop columns). Pre-existing databases are auto-baselined at startup (migration 0000 marked applied). `seed-data.ts` is local-dev only; production bootstrap is `/api/auth/init`.

## Environment Variables

Required: `DATABASE_URL`, `SESSION_SECRET`, `INIT_CODE`.

Optional:
- `CREDENTIAL_ENCRYPTION_KEY` — 32-byte hex (64 chars), AES-256-GCM for secrets feature (`openssl rand -hex 32`)
- `PORT` (default 5000)
- `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_CALLBACK_URL`, `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`/`GITHUB_CALLBACK_URL` — OAuth sign-in
- `WEB_SESSION_TTL_HOURS` (default 1) — minted storageState freshness
- `WEB_SESSION_MINT_TIMEOUT_SECONDS` (default 180) — read by both Core and broker to bound a mint
- `GEOIP_DB_DIR` (default `./geoip`) — absent DBs = non-public agents stay Unverified (safe default; self-heals on refresh)
- `MAXMIND_LICENSE_KEY` — bootstrap-only fallback; the key is normally console-managed (Regions page, stored encrypted in `systemConfig`). `server/geoip-refresh.ts` refreshes in-app (startup when missing/stale >7d, weekly timer, admin Refresh button); no key → automatic DB-IP Lite fallback (no account needed)

Broker sidecar only (not read by Core): `VOX_CORE_URL`, `BROKER_REG_TOKEN`, `BROKER_ADVERTISE_URL` (internal-only callback), `BROKER_NAME`, `BROKER_PORT`.

## Architecture

Monorepo: **client/** (React + Vite), **server/** (Express), **shared/** (Drizzle schema + shared types), **tests/**, **scripts/**.

- Frontend: Wouter routing (`client/src/App.tsx`), TanStack React Query for server state, shadcn/ui + Radix, Recharts, session-based auth. Console pages under `/console/*`, admin under `/admin/console/*`.
- Backend: `server/index.ts` entry → `registerRoutes()` in `server/routes.ts` (all API endpoints — large and monolithic by design; versioned v1 in `server/routes-api-v1.ts`). Data access through the `storage` singleton (`server/storage.ts`, DatabaseStorage). Auth middleware in `server/auth.ts`: `requireAuth`, `requireAdmin`, `requirePrincipal`, `authenticateApiKey` (`vox_live_` Bearer), `requireAuthOrApiKey`.
- Rate limiting (production only): 100 req/15min general; strict 20 req/15min on `/api/auth/login`, `/register`, `/activate`, `/api/user/change-password`.
- API docs: Swagger UI at `/api/docs`, spec at `/api/v1/openapi.json`, source `docs/openapi.yaml`. Don't enumerate routes here — read `server/routes.ts`.

### Eval Agent System
1. Admin or non-basic users mint eval agent tokens with region assignment (admin: public/private visibility; non-admin: private only)
2. Agents register with a token, then heartbeat and fetch/claim jobs for their region (`evalJobs`: `pending` → `running` → `completed`/`failed`)
3. Agents run the eval framework and report to `evalResults`, linked to `workflows`/`evalSets` via nullable FKs

Region locations are admin-managed; site IDs are `<location-base>-<sequence>` (e.g. `apac-in-mumbai-01`). Some UI text still says "workers"/"testSets" for eval agents/eval sets.

**Immutable per-job snapshot:** each `evalJobs` row carries a `snapshot` jsonb (workflow + eval-set metadata + config + provider + creator plan at run time) and `tokenVisibility` (frozen at claim). Everything downstream — provider attribution, provenance UI, tiering — reads the snapshot, never the live rows, so editing/deleting a workflow or eval set never rewrites past history. `evalJobs`/`evalSchedules` FKs are `ON DELETE SET NULL`; orphaned jobs authorize by `createdBy`, orphaned schedules auto-disable. `buildJobSnapshot()` in `server/storage.ts`.

**3-tier metric classification** (reads the frozen snapshot):
- **Mainline** (`/api/metrics/realtime`): snapshot workflow AND eval set public+mainline, `tokenVisibility` public, creator plan principal/fellow
- **Community** (`/api/metrics/community`): both public but not fully mainline
- **My Evals** (`/api/metrics/my-evals`, auth): workflow or eval set private, owned by requester

### Auth-Session Broker
Some targets need an authenticated web login before an eval. Brokered secrets (`brokerType` non-null) are **Core-only** — structurally withheld from the job-secrets path at every dispatch tier; agents get a pre-minted session, never the credential. (`brokerType == null` = runtime/agent-exposed.)

- **Dynamic registry:** admin mints a hashed `broker_registration_tokens` row; the broker sidecar registers against Core, advertising an internal-only callback URL and receiving a per-broker in-memory mint secret. Core tracks `(brokerType, state)` in `brokers` and dispatches mints lease-fenced to a live broker, with cold-cache reregister after Core restarts.
- **Sidecar:** stateless `vox-auth-session-broker` image (Dockerfile `broker` target) mints a `storageState` by driving aeval `setup:account` with the decrypted credential. Internal network only; the password never goes past Core → broker → target site.
- **Agents run `setup:storage`, never `setup:account`:** the daemon forces `mode: storage` and strips credential fields before the agent process sees the config.
- **Server-stamped injection:** job creation (run route + scheduler) strip-then-stamps `config.sessionInjection` when `auth-session.ts`'s `workflowNeedsSession()` detects a login-class secret in the workflow's `platform.setup` — caller-supplied values are never trusted.
- **Session endpoint** `GET /api/eval-agent/jobs/:jobId/session` (lease-fenced): `200 ready` / `202 minting` / `503 failed`. A failed mint fails the job before any eval runs (escrow refund, not a wasted capture). The `503` body carries the real cause only to an **owner-operated** agent (`isOwnerOperatedAgent`); attested marketplace agents get status only — a mint error can quote page state.
- **Failed-mint diagnosis:** broker folds aeval loguru `ERROR` lines into its 502; Core stores it as `webSessions.lastError`; daemon surfaces it as the job error — one `docker logs` at any tier shows the cause. URLs reduced to scheme+host (`reduceUrlsToHost`); last failed HTTP status extracted digits-only from browser console; artifacts path taken from **stderr only** and confined to permitted roots.
- **Credential fingerprints** (`valueLength` + first-10-hex-MD5 `valueFingerprint` on `GET /api/secrets`) let an owner verify a stored value (`printf %s 'value' | md5sum | cut -c1-10`). MD5 is deliberate (owner-reproducible). **Personal secrets only** — org secrets have none because `upsertOrgSecret` keeps the original `createdBy`, so post-rotation the fingerprint would false-mismatch (needs an `updatedBy` column first). Credential-returning routes are excluded from request logs via `server/sensitive-paths.ts` (its test scans `routes.ts`). See `shared/credentials.ts`.
- **Shared-tier gates:** marketplace dispatch of a login secret additionally requires `isTestAccount` attestation and `credentialConsent` on the job snapshot, checked before `authorizeDispatch`.
- `eval_agents.observed_ip` is Core-internal (register/heartbeat IP, fire-and-forget) — never exposed on any endpoint; future network labeling derives from it.

### Users, Orgs, Limits
- Plans: `basic` (free), `premium` (paid), `principal` (Scout, internal), `fellow` (external prestige). `isAdmin` flag for system management. Init creates admin (active) + Scout (needs activation).
- Orgs: first user is org admin; Premium seats with volume discounts (`pricingConfig`).
- Project/workflow caps: basic 5×10, premium 20×20, org 100×20.
- Visibility (workflows + eval sets): `public`/`private` (private is Premium+). Principal/Fellow can mark mainline.

### Permission Model (`server/permissions.ts`)
**A system admin is NOT a super-editor** — admin powers are user management + provider config + **delete (moderation)** only.
- `canAccessResource` (view): owner, same-org, public, or admin
- `isOwnerOrOrgManager` (edit / run-private): owner/creator or org manager — **no admin bypass**; used by PATCH routes and `canRunWorkflow` for private workflows
- `canEditResource` = `isAdmin || isOwnerOrOrgManager` — kept for **delete** routes only
- `canRunWorkflow`: public → anyone; private → `isOwnerOrOrgManager`
- `canScheduleWorkflow` (schedule / run-now / enable / re-cron): **owner/creator only** — a recurring schedule is an indefinite commitment. The scheduler re-checks per tick and disables schedules whose creator lost the right. (Extend + run-once are looser: owner-or-org.)

**Secrets follow workflow ownership** (job-secrets endpoint): org-owned workflow → org secrets (fenced by job creator's org membership); personal workflow → owner's personal secrets. Built-in eval sets (`config.builtIn`) are server-controlled, admin-editable only.

The UI mirrors the server via server-computed flags (`canSchedule`/`canManage`) so it never offers an action that would 403.

### Security-First
- Hash all tokens/keys with SHA256 (`storage.ts:hashToken()`) before storage; passwords via bcrypt (`auth.ts:hashPassword()`)
- Validate inputs with Zod schemas from `shared/schema.ts`
- API keys prefixed (`vox_live_`), shown once at creation
- KISS: straightforward readable code over clever abstraction; web-first but API-ready

## Testing

**Env/test-data files** (all gitignored; CI uses secrets/env vars instead):
- `.env.dev` — OAuth + Stripe test keys; `dev-local-run.sh` loads `.env` then `.env.dev`
- `tests/tests.dev.data` — test account credentials
- **Copy `.env.dev` to `.env` before running tests.** Stripe test keys allow seat purchases without a payment method.

```bash
./scripts/dev-local-run.sh start   # required for integration + E2E
./scripts/full-tests-run.sh        # ALL tests (unit + audio + E2E) — the gate
npm test                           # Vitest only
./scripts/full-tests-run.sh audio  # Clash runner audio pipeline (Docker)
npx playwright test [--ui|--headed]
```

A green gate means all three: unit/integration (Vitest), audio (Docker), E2E (Playwright). Notable suites: `tests/api.test.ts`, `tests/eval-agent-daemon.test.ts`, `tests/clash-runner*.test.ts`, `tests/e2e/*.spec.ts`, `vox_clash_runner/audio/test-audio-pipeline.sh`. Don't trust doc'd test counts — run `npm test`.

**Known gate hazards:**
- Suites leak resources into the dev DB and trip per-user caps (GitHub #134). Before a full run:
  ```sql
  DELETE FROM workflows WHERE owner_id=1;
  DELETE FROM projects  WHERE owner_id=1;
  DELETE FROM secrets   WHERE user_id=1;
  ```
- Integration suites hit the **already-running** dev server — after changing `server/`, run `./scripts/dev-local-run.sh stop && start` or the change isn't exercised.

## Eval Agent Daemon

- `vox_eval_agentd/vox-agentd.ts` — the daemon (single source for Docker & local dev); `vox_eval_agentd/Dockerfile`; `aeval-data/` (git submodule); `applications/` + `scenarios/` (YAML configs)
- Two frameworks: **aeval** (default; `aeval run scenario.yaml` → `metrics.json`) and **voice-agent-tester** (Node/Puppeteer → CSV)
- aeval needs `libsndfile1` + `ffmpeg` (Dockerfile has them; install on host for local dev) — without them energy VAD and STT fail with `NoBackendError`
- **aeval ≥0.4 defaults to virtual-soundcard audio I/O** (legacy per-scenario fallback: `audio_io.mode: web_hook`). Linux additionally needs `alsa-utils` + `libportaudio2` and the **host-loaded** `snd-aloop` kernel module as card `VirtualAudio` (`sudo modprobe snd-aloop id=VirtualAudio pcm_substreams=1`; a container cannot modprobe — dockerized agents need `--device /dev/snd`). macOS: BlackHole 2ch @ 48 kHz. `dev-local-run.sh` auto-sets this up (`ensure_virtual_audio`); `vox-upgrade.sh` passes the device and warns if the card is missing. The broker never does audio I/O and needs none of this. Caveat: with `pcm_substreams=1`, concurrent aeval runs on one host contend for the loopback card (affects `--multi-region` local mode)
- The aeval **binary** version is pinned by `AEVAL_VERSION` in `vox_eval_agentd/Dockerfile`; the **data** (config/examples/corpus) is pinned by the `aeval-data` submodule — bump both together on an aeval release
- Metrics mapping (`metrics.json` → `evalResults`): `responseLatencyMedian`/`Sd` from `response_metrics.latency.turn_level[].latency_ms` (true median; population SD, needs ≥2 samples; negative latencies filtered; fallback turn_level → `summary.p50_latency_ms` → `aggregated_summary.avg_response_latency_ms`); `interruptLatencyMedian`/`Sd` likewise from `interruption_metrics.latency.turn_level[].reaction_time_ms`
- **Failure policy:** non-zero aeval exit → job failed; partial results are never reported

## Key Files

- `shared/schema.ts` — all tables/enums/Zod schemas (single source of truth)
- `shared/secrets.ts` — secret naming + `isAuthFieldName`; **client-safe, must stay dependency-free**
- `shared/credentials.ts` — redaction + fingerprinting shared by Core/daemon/broker; **Node-only, never import from client/**
- `shared/mint-timeout.ts` — the one clamped `WEB_SESSION_MINT_TIMEOUT_SECONDS` reader; the clamp orders four deadlines (broker child < Core abort +15s < stale reclaim +30s < daemon's hard-coded 240s poll) — raising `MAX_MINT_TIMEOUT_SECONDS` requires raising that poll too
- `server/routes.ts`, `server/storage.ts`, `server/auth.ts`, `server/permissions.ts`, `server/stripe.ts`, `client/src/App.tsx`
- `designs/IMPLEMENTATION_PLAN.md`, `designs/CLASH_DESIGN.md`, `designs/vox-arch.png`
- `scripts/vox-upgrade.sh` — upgrade eval agent / clash runner containers

## Deployment & Notes

- CI/CD: GitHub Actions → Coolify webhook on push to main (`.github/workflows/deploy.yml`)
- Default providers (all `convoai`): Agora ConvoAI Engine (`agora`), LiveKit Agents (`livekit`), ElevenLabs Agents (`elevenlabs`), Custom (no `platformId`). `providers.platformId` matches the workflow's `platform.setup → platform_id`; seeding is idempotent-by-name from both migrations and `/api/auth/init`
- Common tasks: new table → schema.ts → migration → storage.ts → routes.ts; new page → `client/src/pages/` → route in `App.tsx` → `ConsoleLayout` + TanStack Query
