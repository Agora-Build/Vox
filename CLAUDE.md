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
1. **`db:generate` is inoperative** — drizzle-kit's meta journal stopped at 0004 and the command now hangs on an interactive enum prompt. Every migration 0005–0036 is hand-written: copy the numbered convention already in `migrations/` and write the SQL yourself.
2. Register the file in the `MIGRATIONS` array in `server/migrate.ts` — migrations run via a custom version-based runner (`node dist/migrate.cjs` before app start), and an unregistered SQL file is **never applied**
3. Commit migration + schema change together; migrations apply automatically on next startup

Keep migration SQL plain (`CREATE TABLE`, `ALTER TABLE`) — no `IF NOT EXISTS` / `DO ... EXCEPTION`; each runs exactly once. Never `db:push`/`drizzle-kit push --force` in production (can silently drop columns). Pre-existing databases are auto-baselined at startup (migration 0000 marked applied). `seed-data.ts` is local-dev only; production bootstrap is `/api/auth/init`.

Migration 0036's backfill (`UPDATE eval_jobs ... FROM users`) takes an ACCESS EXCLUSIVE-conflicting write pass over `eval_jobs` — on a large production table, expect a brief pause at deploy. Migrations run pre-start (`dist/migrate.cjs`), so the app is already down; no action needed, noted so the pause isn't mistaken for a hang.

**Dev-mode migration trap:** local dev applies schema via `db:push` (`dev-local-run.sh`'s init path), and `tsx` never runs the version-based runner — `drizzle-kit push --force` **drops the `_schema_version` bookkeeping**. If you push manually, restore the version row afterward, or the next docker-mode start crash-loops re-applying already-applied migrations (this bit a task on this branch; the controller repaired it at version 38).

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
- `VOX_PLUGINS` — comma-separated builtin plugin ids to activate (`sample`, `credits`, `shared-agents`, `organizations`); unset/empty = none load. Unknown id = **crash-before-listen** (`server/plugins/loader.ts`) — treat it like `DATABASE_URL`, not an optional feature flag. Dev default (`dev-local-run.sh`, `docker-compose.yml`): `credits,shared-agents,organizations`.

Broker sidecar only (not read by Core): `VOX_CORE_URL`, `BROKER_REG_TOKEN`, `BROKER_ADVERTISE_URL` (internal-only callback), `BROKER_NAME`, `BROKER_PORT`.

## Architecture

Monorepo: **client/** (React + Vite), **server/** (Express), **shared/** (Drizzle schema + shared types), **tests/**, **scripts/**.

- Frontend: Wouter routing (`client/src/App.tsx`), TanStack React Query for server state, shadcn/ui + Radix, Recharts, session-based auth. Console pages under `/console/*`, admin under `/admin/console/*`.
- Backend: `server/index.ts` entry → `registerRoutes()` in `server/routes.ts` (all API endpoints — large and monolithic by design; versioned v1 in `server/routes-api-v1.ts`). Data access through the `storage` singleton (`server/storage.ts`, DatabaseStorage). Auth middleware in `server/auth.ts`: `requireAuth`, `requireAdmin`, `requirePrincipal`, `authenticateApiKey` (`vox_live_` Bearer), `requireAuthOrApiKey`.
- Rate limiting (production only): 100 req/15min general; strict 20 req/15min on `/api/auth/login`, `/register`, `/activate`, `/api/user/change-password`.
- API docs: Swagger UI at `/api/docs`, spec at `/api/v1/openapi.json`, source `docs/openapi.yaml`. Don't enumerate routes here — read `server/routes.ts`.

### Plugins
Optional, additive backends loaded by `server/plugins/loader.ts` from `VOX_PLUGINS` (see Environment Variables above). Builtins live under `plugins/<id>/` and are registered in `plugins/index.ts`: `sample`, `credits`, `shared-agents`, `organizations`. Each gets its own Postgres schema (`plugin_<id>`, `server/plugins/db.ts:schemaForPlugin`), in-app migrations (`server/plugins/migrate.ts`, fail-closed — a bad migration aborts the transaction and the app refuses to start), and namespaced routes under `/api/plugins/<id>/*` plus a generic `GET /api/plugins/<id>/health`; `GET /api/plugins` lists what activated. A successful load logs exactly one line: `plugins loaded: <id, id, ...>`. Plugin↔Core contracts (`vox.organizations`, `vox.credits`, ...) are looked up via `services.require`/`services.optional`; the `organizations` contract is additionally locked at compile time by `server/plugins/contract-checks.ts`.

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

**Org membership goes through the `vox.organizations` seam** (`server/organizations.ts`): in application code, `getOrganizations().getMembership(userId)` is the only supported way to ask which org a user belongs to. The provider is **plugin-or-absent** — `server/index.ts` installs `plugins.services.optional("vox.organizations", "^1.0.0") ?? null` at startup; there is no Core-side fallback (`CoreOrganizations` was deleted in the Release A flip — see the runbook below). The `organizations` plugin (`plugins/organizations`, enabled via `VOX_PLUGINS`) is the only implementation shipped: it owns org data in its own `plugin_organizations` schema (Core user ids as opaque integers; org secrets stored as ciphertext only — the AES-256-GCM key never enters the plugin, Core encrypts/decrypts). Membership is resolved once per request at the auth boundary, so `AuthUser` carries `membership` and deliberately **omits** the raw columns — reading them is a compile error, and `tests/organizations-boundary.test.ts` fails the build if one creeps back via `storage.getUser()` (the same scan also pins the `orgSecrets` table to 4 leftover provider-serving `storage.ts` methods, callerless since the flip, deleted in Release B). The plugin's contract is locked against Core's seam type at **compile time** by `server/plugins/contract-checks.ts` (`AssertAssignable` both directions — drift fails `npm run check`, not just a test). Resource ownership (`workflow.organizationId` and the other resource-ownership columns) is unaffected: those are Core FK columns compared as opaque integers.

**The seam is the full org contract, not just membership reads** (`OrganizationsProvider` in `server/organizations.ts`, 16 methods): membership reads/counts (`getMembership`/`getMemberships`/`listMembers`/`countMembers`/`countOrgAdmins`), org CRUD (`createOrganization`/`updateOrganization`/`setVerified`/`addMember`/`setMemberRole`/`removeMember`), and org secrets as ciphertext-only rows (`listOrgSecrets`/`upsertOrgSecret`/`deleteOrgSecret` — the provider never sees plaintext; `encryptValue`/`decryptValue` stay in Core). `getOrganizations()` is **nullable** — a plugin may not be installed, and that's a legal state, not a startup bug:
- **Absent ⇒ orgs inert:** org routes 501 (`requireOrganizations`), job-creating routes 501 on org-owned workflows, the scheduler skips (never disables) schedules targeting team-tier dispatch, sweeps exclude the team arm, and no code path performs a persistent write. Proven zero-write over both scheduler and reap workers in `tests/organizations-absence.test.ts`.
- **A `dispatchBlocked` reason is always computed, never stored** — so a schedule re-enables itself for free the moment a provider comes back, with no migration/backfill to undo.
- **Provider failure (a thrown error) is NOT absence** — gating points that can tolerate "no org" still treat a thrown error as absence (skip, never disable); paths that must give an answer surface `503 "Organizations service unavailable"` (vs `501 "Organizations feature not enabled"` when the provider is simply absent). `membershipFor` rethrows rather than swallowing to `null`.

**The six former `storage.ts` SQL bypasses are closed:**
- **R1** (`getEvalAgentsWithTokenTier`'s `tokenOwnerOrgId` join on `users.organization_id`) — removed; callers batch `getOrganizations()?.getMemberships(tokenCreatedBy[])` at the routes.ts call sites instead (`server/routes.ts`).
- **R2** (`claimEvalJob`/`getClaimableJobsForToken` team-arm filter on live `creator.organization_id`) — the claim SQL now reads the frozen `eval_jobs.creator_org_id`, stamped from `user.membership` at job-creation time (migration 0036). **Pinned semantic change:** a pending team job now keeps the claimability it had the instant it was created — a creator's mid-flight org change no longer alters it. Backfilled for pre-existing rows; frozen going forward. Proven both directions in `tests/org-claim-stamp.test.ts`.
- **R3** (org-credential fence): `orgRuntimeSecretsForJob` (`server/routes.ts`, sole caller of the org-secret decrypt tail) resolves the job creator's membership through the seam and compares it to the workflow's org before releasing ciphertext — cross-org negative covered in `tests/org-secret-fence.test.ts`.
- Remaining counts/writes (roster, admin counts, org secrets CRUD) go through the provider directly — no parallel SQL path.

**Release A has landed; the old columns are frozen, not dropped.** Release A (`b13c12a` + `f6b9fdb`) dropped the 10 org FK constraints (ids are opaque integers on Core tables now) and deleted `CoreOrganizations`, but `users.organization_id`/`org_role` and the old `public.organizations`/`public.org_secrets` tables still physically exist — unread and unwritten by any code path (no-dual-read, achieved). Release B (dropping those columns/tables plus the ~38 dead `storage.ts` methods that reference them) is a **separate, one-way-door release**, taken only after Release A soaks — see the Release A runbook below. Boundary scan (`tests/organizations-boundary.test.ts`) covers snake_case SQL too, with marked exemptions for the layer that serves raw rows, and now scans plugin directories. Design: `designs/2026-09-10-organizations-seam-design.md`; plugin extraction: `designs/2026-09-16-organizations-plugin-extraction-design.md`.

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
  `tests/org-claim-stamp.test.ts` (no `afterAll`) leaks its own +1 org / +1 membership per run into `plugin_organizations` (`r2-org-<ts>-<rand>` names, fresh users each run — same pre-existing pattern as `tier-pool-claim.test.ts`). It never touches `owner_id=1`, so it doesn't trip the caps above, but clean it up separately so the plugin schema doesn't grow unbounded:
  ```sql
  DELETE FROM plugin_organizations.memberships
    WHERE org_ref IN (SELECT id FROM plugin_organizations.organizations WHERE name LIKE 'r2-org-%');
  DELETE FROM plugin_organizations.organizations WHERE name LIKE 'r2-org-%';
  ```
- Integration suites hit the **already-running** dev server — after changing `server/`, run `./scripts/dev-local-run.sh stop && start` or the change isn't exercised.

## Eval Agent Daemon

- `vox_eval_agentd/vox-agentd.ts` — the daemon (single source for Docker & local dev); `vox_eval_agentd/Dockerfile`; `aeval-data/` (git submodule); `applications/` + `scenarios/` (YAML configs)
- Two frameworks: **aeval** (default; `aeval run scenario.yaml` → `metrics.json`) and **voice-agent-tester** (Node/Puppeteer → CSV)
- aeval needs `libsndfile1` + `ffmpeg` (Dockerfile has them; install on host for local dev) — without them energy VAD and STT fail with `NoBackendError`
- **aeval ≥0.4 defaults to virtual-soundcard audio I/O** (legacy per-scenario fallback: `audio_io.mode: web_hook`). Linux additionally needs `alsa-utils` + `libportaudio2` and the **host-loaded** `snd-aloop` kernel module as card `VirtualAudio` (`sudo modprobe snd-aloop id=VirtualAudio pcm_substreams=1`; a container cannot modprobe — dockerized agents need **both** `--device /dev/snd` and `--security-opt systempaths=unconfined`, because Docker masks `/proc/asound` by default and aeval resolves the card ID by reading it; the device alone yields "No ALSA card has the ID 'VirtualAudio'" while `aplay` still works, since alsa-utils resolve via `/dev/snd` ioctls). macOS: BlackHole 2ch @ 48 kHz. `dev-local-run.sh` auto-sets this up (`ensure_virtual_audio`); `vox-upgrade.sh` passes the device and warns if the card is missing. The broker never does audio I/O and needs none of this — but that's only true because its composed mint scenario **pins `audio_io.mode: web_hook`** (aeval ≥0.4 platform configs default to soundcard and the session preflight enforces the device even for a zero-audio login; without the pin every mint 502s with SOUNDCARD_DEVICE_NOT_FOUND). Caveat: with `pcm_substreams=1`, concurrent aeval runs on one host contend for the loopback card (affects `--multi-region` local mode)
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

### Organizations Plugin — Release A Runbook
Enabling `organizations` on an instance that already has org data (Release A cutover):
1. **DB snapshot first.**
2. Add `organizations` to `VOX_PLUGINS` in Coolify — **env var only**, no code change.
3. Deploy with a **stop-then-start, never a rolling restart**: writes the old container makes *after* the plugin's copy migration commits are silently lost (uncopied, and the old release is about to stop reading them anyway) — see `plugins/organizations/migrations/0002_copy_from_core.sql`'s header for why REPEATABLE READ isn't the fix.
4. **Fail-closed by design:** a parity or preflight failure in the copy migration aborts the migration transaction — the container refuses to start and the old release keeps serving. The three named preflight errors (duplicate `org_secrets` names, dangling `users.organization_id`, dangling `org_secrets.organization_id`) name the offending rows directly.
5. **Verify after deploy:** `GET /api/plugins` lists `organizations`; `GET /api/plugins/organizations/health` is `ok`; the startup log shows `plugins loaded: ...` including `organizations`.
6. **Never remove `organizations` from an instance with org data** — it would silently make membership inert (Phase-1 absence semantics), not fall back to the old columns. `vox.agora.build` omits it deliberately today (no orgs to migrate).
7. Release B (dropping `users.organization_id`/`org_role`, `public.organizations`/`org_secrets`, and the ~38 dead `storage.ts` methods) is a **separate release after soak** — a one-way door; snapshot again before taking it.
