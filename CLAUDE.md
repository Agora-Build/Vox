# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Working Conventions

- **Reviewing design files:** serve any markdown deliverable for user review with `atem serv files <path>` and surface the **Custom URL** (`genie.netbird.cloud:<port>/...`) — that's the reachable/shareable link. Use `--background` while iterating; manage with `atem serv list` / `atem serv kill files-<port>`.
- **Dev vs test scripts:** `scripts/dev-local-run.sh` = local **service setup** (PostgreSQL + Vox service + eval agent); `scripts/full-tests-run.sh` = the **test runner** (unit + audio + E2E). Not interchangeable.
- **Pre-merge gate:** run `./scripts/full-tests-run.sh` (the full suite, not just `npm test`) before every PR merge.

## Project Overview

Vox is an AI latency evaluation platform for conversational AI products. Distributed eval agents run automated tests across regions (NA, APAC, EU, SA) measuring turn success rate, response latency, interrupt latency, network resilience, naturalness, and noise reduction for AI voice agents.

## Commands

```bash
npm install / npm run dev / npm run build / npm start   # dev server on port 5000
npm run check              # TypeScript
npm run lint               # ESLint

./scripts/dev-local-run.sh start|stop|reset|status      # local env (Postgres in Docker + service + agent)
./scripts/dev-local-run.sh --multi-region start         # na/apac/eu/sa agents
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
1. **`db:generate` is inoperative** — drizzle-kit's meta journal stopped at 0004 and the command now hangs on an interactive enum prompt. Every migration 0005–0037 is hand-written: copy the numbered convention already in `migrations/` and write the SQL yourself.
2. Register the file in the `MIGRATIONS` array in `server/migrate.ts` — migrations run via a custom version-based runner (`node dist/migrate.cjs` before app start), and an unregistered SQL file is **never applied**
3. Commit migration + schema change together; migrations apply automatically on next startup

Keep migration SQL plain (`CREATE TABLE`, `ALTER TABLE`) — no `IF NOT EXISTS` / `DO ... EXCEPTION`; each runs exactly once. Never `db:push`/`drizzle-kit push --force` in production (can silently drop columns). Pre-existing databases are auto-baselined at startup (migration 0000 marked applied). `seed-data.ts` is local-dev only; production bootstrap is `/api/auth/init`.

**FK/constraint names diverge by build path — never assume drizzle names in a migration.** `drizzle db:push` (local dev) names constraints `<table>_<col>_<reftable>_<refcol>_fk` (e.g. `workflows_organization_id_organizations_id_fk`); the migration-built path (CI/prod) leaves some on Postgres defaults (`<table>_<col>_fkey`, e.g. `workflows_organization_id_fkey`). A migration doing `DROP CONSTRAINT <assumed-name>` aborts pre-start on whichever DB used the *other* name — this crash-looped prod on migration 0037 (the Release A org-FK drops assumed drizzle names; prod's then-named `workflows`/`eval_sets`/`eval_schedules` were on `_fkey`). (Constraint/index names on `eval_flows` still carry the historical `workflows_*` spelling — two renames since (0039, 0042) moved the table without chasing them, for exactly this reason.) When a migration must drop/alter a constraint that might carry either name, query `pg_constraint` first, or `DROP CONSTRAINT IF EXISTS` **both** variants per table — the one place `IF EXISTS` is warranted despite the plain-SQL rule (still runs once, version-gated).

Migration 0036's backfill (`UPDATE eval_jobs ... FROM users`) takes an ACCESS EXCLUSIVE-conflicting write pass over `eval_jobs` — on a large production table, expect a brief pause at deploy. Migrations run pre-start (`dist/migrate.cjs`), so the app is already down; no action needed, noted so the pause isn't mistaken for a hang.

**Dev-mode migration trap:** `dev-local-run.sh start` uses `db:push` only on a fresh or push-built DB. A DB the version-based runner manages (it has `_schema_version` — created by docker mode or the gate) is brought up to date with the runner instead (`npx tsx server/migrate.ts`, #199), because `db:push` there **drops what migrations create but `shared/schema.ts` doesn't declare** (the expression/partial `eval_jobs_*` indexes) and prompts to drop `_schema_version` itself. Don't "fix" that prompt with a `tablesFilter` entry: the prompt is what stops a manual push from silently dropping those indexes (this was tried in #199 and dropped seven of them). Never answer it Yes; if you did, restore the version row, or the next docker-mode start crash-loops re-applying migrations. **Rename corollary:** against a pre-rename dev DB, `db:push` hits drizzle's interactive create-vs-rename prompt (and never runs the snapshot-key rewrites) — apply the rename migration by hand with psql and stamp `_schema_version`, or just `dev-local-run.sh reset`. This bit both renames (0039 workflow→eval flow, 0042 eval flow→eval_flow).

## Environment Variables

Required: `DATABASE_URL`, `SESSION_SECRET`, `INIT_CODE`.

Optional:
- `CREDENTIAL_ENCRYPTION_KEY` — 32-byte hex (64 chars), AES-256-GCM for secrets feature (`openssl rand -hex 32`)
- `PORT` (default 5000)
- `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_CALLBACK_URL`, `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`/`GITHUB_CALLBACK_URL` — sign-in with Google/GitHub, served by the **`oauth` plugin** (needs `oauth` in `VOX_PLUGINS`; each provider turns on when its ID+secret are set). Google's redirect URI is `<origin>/api/plugins/oauth/google/callback`; GitHub's registered callback is the web page `<origin>/auth/github/callback`, which POSTs the code to the plugin
- `WEB_SESSION_TTL_HOURS` (default 1) — minted storageState freshness
- `WEB_SESSION_MINT_TIMEOUT_SECONDS` (default 180) — read by both Core and broker to bound a mint
- `GEOIP_DB_DIR` (default `./geoip`) — absent DBs = non-public agents stay Unverified (safe default; self-heals on refresh)
- `MAXMIND_LICENSE_KEY` — bootstrap-only fallback; the key is normally console-managed (Regions page, stored encrypted in `systemConfig`). `server/geoip-refresh.ts` refreshes in-app (startup when missing/stale >7d, weekly timer, admin Refresh button); no key → automatic DB-IP Lite fallback (no account needed)
- `VOX_CONTACT_EMAIL` (default `vox@agora.build`), `VOX_GITHUB_URL` (default `https://github.com/Agora-Build/Vox`), `VOX_X_URL` (no default) — public footer contact links, served from `GET /api/config` at runtime so a fork or rebrand changes them with an env var + restart, not a rebuild. **Unset ⇒ the icon is not rendered**, deliberately: a social link that goes nowhere is worse than none (the footer previously shipped a bare `https://twitter.com`).
- `VOX_PLUGINS` — comma-separated builtin plugin ids to activate (`sample`, `credits`, `shared-agents`, `organizations`, `oauth`); unset/empty = none load. Unknown id = **crash-before-listen** (`server/plugins/loader.ts`) — treat it like `DATABASE_URL`, not an optional feature flag. Dev default (`dev-local-run.sh`, `docker-compose.yml`): `credits,shared-agents,organizations,oauth`.

Broker sidecar only (not read by Core): `VOX_CORE_URL`, `BROKER_REG_TOKEN`, `BROKER_ADVERTISE_URL` (internal-only callback), `BROKER_NAME`, `BROKER_PORT`. The same family drives **both** sidecars — the auth-session broker and the REST broker (`vox_rest_broker/rest-broker.ts`, Dockerfile target `rest-broker`, declares `brokerType: "restful"`; `REST_BROKER_ALLOW_PRIVATE=1` opens private/loopback targets for dev only).

## Architecture

Monorepo: **client/** (React + Vite), **server/** (Express), **shared/** (Drizzle schema + shared types), **tests/**, **scripts/**.

- Frontend: Wouter routing (`client/src/App.tsx`), TanStack React Query for server state, shadcn/ui + Radix, Recharts, session-based auth. Console pages under `/console/*`, admin under `/admin/console/*`.
- Backend: `server/index.ts` entry → `registerRoutes()` in `server/routes.ts` (all API endpoints — large and monolithic by design; versioned v1 in `server/routes-api-v1.ts`). Data access through the `storage` singleton (`server/storage.ts`, DatabaseStorage). Auth middleware in `server/auth.ts`: `requireAuth`, `requireAdmin`, `requirePrincipal`, `authenticateApiKey` (`vox_live_` Bearer), `requireAuthOrApiKey`.
- Rate limiting (production only, per IP, `server/index.ts`): 1000 req/15min general; strict 20 req/15min on `/api/auth/login`, `/register`, `/activate`, `/api/user/change-password`.
- API docs: Swagger UI at `/api/docs`, spec at `/api/v1/openapi.json`, source `docs/openapi.yaml`. Don't enumerate routes here — read `server/routes.ts`.

### Plugins
Optional, additive backends loaded by `server/plugins/loader.ts` from `VOX_PLUGINS` (see Environment Variables above). Builtins live under `plugins/<id>/` and are registered in `plugins/index.ts`: `sample`, `credits`, `shared-agents`, `organizations`, `oauth`. Each gets its own Postgres schema (`plugin_<id>`, `server/plugins/db.ts:schemaForPlugin`), in-app migrations (`server/plugins/migrate.ts`, fail-closed — a bad migration aborts the transaction and the app refuses to start), and namespaced routes under `/api/plugins/<id>/*` plus a generic `GET /api/plugins/<id>/health`; `GET /api/plugins` lists what activated. A successful load logs exactly one line: `plugins loaded: <id, id, ...>`. Plugin↔Core contracts (`vox.organizations`, `vox.credits`, ...) are looked up via `services.require`/`services.optional`; the `organizations` contract is additionally locked at compile time by `server/plugins/contract-checks.ts`. Since plugin API 1.1 the other direction exists too: **Core provides services to plugins**, passed to `loadPlugins` and registered before any plugin activates. The one today is `vox.identity@1.0.0` (`server/identity.ts`, contract in `@vox/plugin-sdk`): find/create a user, mark an email verified, sign in/out — the only way a plugin touches Core users or sessions. The `oauth` plugin uses it; its account links live in `plugin_oauth.identities` (copied from `users.github_id`/`google_id` by its migration 0002, fail-closed on a count mismatch — those Core columns are frozen, dropped later). Design: `designs/2026-09-27-oauth-plugin-design.md`.

### Eval Agent System
1. Admin or non-basic users mint eval agent tokens with region assignment (admin: public/private visibility; non-admin: private only)
2. Agents register with a token, then heartbeat and fetch/claim jobs for their region (`evalJobs`: `pending` → `running` → `completed`/`failed`)
3. Agents run the eval framework and report to `evalResults`, linked to `eval_flows`/`evalSets` via nullable FKs

Region locations are admin-managed; site IDs are `<location-base>-<sequence>` (e.g. `apac-in-mumbai-01`). Some UI text still says "workers"/"testSets" for eval agents/eval sets.

**Transport axis (Phone vs Agent, Phase A — `designs/2026-09-21-phone-vs-agent-design.md`):** eval flows carry `transport` (`web`|`phone`, default web, editable by owner); each job freezes its own copy (snapshot field + stamped `eval_jobs.transport` column, `creator_org_id` pattern — claim SQL reads the stamp, never the live eval flow). Phone jobs are claimable only by agents declaring the `phone` capability (register/heartbeat `capabilities: ["phone"]`, refreshed per beat, `[]` clears); the gate lives in both claim SQL paths AND `permissions.isClaimable` — keep them mirrored. Metrics endpoints take `?transport=` (default `web`) — web and phone are a hard partition, never mixed in one response. `evalResults.callMetadata` (jsonb, 4 KB cap at the complete endpoint) is phone-only call detail. Phases B–D (REST broker, DialF integration, UI) are separate releases.

**Tools → Analyze** (design `designs/2026-09-30-tools-analyze-design.md`): a user uploads stereo WAVs (left = user, right = agent) with a provider, the region the recording was made in, and a source (web/phone). Each becomes a hidden `eval_jobs` row, `kind = 'analyze'` (priority -10, so waiting eval runs go first).
- **Claim rule** (same in `permissions.isClaimable` and both claim SQL paths): an agent reporting the `analyze` capability (the daemon does when `aeval` runs). **Free** (untargeted): public, or the uploader's own; never a marketplace agent. **Paid**: the uploader picks a marketplace agent, ticks consent (`snapshot.recordingConsent`: its operator receives the recording), and one unit at its listed price is held via `authorizeDispatch` at upload (existing paid-dispatch flow: captured on a result, refunded otherwise); the job targets that token, and only it may claim. Region and site play no part, and the phone gate doesn't apply.
- **On the agent:** it fetches the file through the lease-fenced `GET /api/eval-agent/jobs/:id/upload` and runs `aeval analyze` with the phone preset.
- **Storage:** the WAV lives only in the uploader's own bucket (Storage page, `user_storage_config`, so Premium and up); no system fallback. Core connects to that user-typed endpoint itself, so it is **SSRF-guarded** (`server/storage-endpoint.ts`): public HTTPS only, and every connection's DNS answer is checked against loopback/private/link-local/CGNAT ranges. `VOX_STORAGE_ALLOW_PRIVATE=1` lifts this for local development only. Each upload records its endpoint+bucket; if the user's storage moves, downloads refuse and delete removes the analysis from Vox and reports where the file stayed.
- **Nothing leaves the agent:** an analysis uploads **no artifacts**. The agent deletes its work dir, and `/storage-config` refuses analyze jobs, so an agent the uploader doesn't run never gets their credentials.
- **Access:** the job routes never serve an analysis (`canViewJob`/`canCancelJob` refuse `kind = 'analyze'`, admins included); only `/api/tools/analyze/*` does, for its uploader.
- **Uploads and delete:** one upload in flight per user (3 in total). Delete is soft (`deleted_at`) so the daily cap still counts the row; a failed removal from the bucket keeps the row for a retry.
- **Where results show:** kept out of the Eval Jobs lists (`evalJobConditions`) and off Mainline/Community; shown in the uploader's My Evals, filed by `eval_results.recording_region` (`site_id` stays NULL).
- **Honest metrics:** network/naturalness/noise are reported as null, not measured (see #217).

**Immutable per-job snapshot:** each `evalJobs` row carries a `snapshot` jsonb (eval flow + eval-set metadata + config + provider + creator plan at run time) and `tokenVisibility` (frozen at claim). Everything downstream — provider attribution, provenance UI, tiering — reads the snapshot, never the live rows, so editing/deleting an eval flow or eval set never rewrites past history. `evalJobs`/`evalSchedules` FKs are `ON DELETE SET NULL`; orphaned jobs authorize by `createdBy`, orphaned schedules auto-disable. `buildJobSnapshot()` in `server/storage.ts`.

**3-tier metric classification** (reads the frozen snapshot):
- **Mainline** (`/api/metrics/realtime`): snapshot eval flow AND eval set public+mainline, `tokenVisibility` public, creator plan principal/fellow
- **Community** (`/api/metrics/community`): both public but not fully mainline
- **My Evals** (`/api/metrics/my-evals`, auth): eval flow or eval set private, owned by requester

### Auth-Session Broker
Some targets need an authenticated web login before an eval. Brokered secrets (`brokerType` non-null) are **Core-only** — structurally withheld from the job-secrets path at every dispatch tier; agents get a pre-minted session, never the credential. (`brokerType == null` = runtime/agent-exposed.)

- **Dynamic registry:** admin mints a hashed `broker_registration_tokens` row; the broker sidecar registers against Core, advertising an internal-only callback URL and receiving a per-broker in-memory mint secret. Core tracks `(brokerType, state)` in `brokers` and dispatches mints lease-fenced to a live broker, with cold-cache reregister after Core restarts.
- **Sidecar:** stateless `vox-auth-session-broker` image (Dockerfile `broker` target) mints a `storageState` by driving aeval `setup:account` with the decrypted credential. Internal network only; the password never goes past Core → broker → target site.
- **Agents run `setup:storage`, never `setup:account`:** the daemon forces `mode: storage` and strips credential fields before the agent process sees the config.
- **Server-stamped injection:** job creation (run route + scheduler) strip-then-stamps `config.sessionInjection` when `auth-session.ts`'s `evalFlowNeedsSession()` detects a login-class secret in the eval flow's `platform.setup` — caller-supplied values are never trusted.
- **Session endpoint** `GET /api/eval-agent/jobs/:jobId/session` (lease-fenced): `200 ready` / `202 minting` / `503 failed`. A failed mint fails the job before any eval runs (escrow refund, not a wasted capture). The `503` body carries the real cause only to an **owner-operated** agent (`isOwnerOperatedAgent`); attested marketplace agents get status only — a mint error can quote page state.
- **Failed-mint diagnosis:** broker folds aeval loguru `ERROR` lines into its 502; Core stores it as `webSessions.lastError`; daemon surfaces it as the job error — one `docker logs` at any tier shows the cause. URLs reduced to scheme+host (`reduceUrlsToHost`); last failed HTTP status extracted digits-only from browser console; artifacts path taken from **stderr only** and confined to permitted roots.
- **`brokerType: 'restful'` = trusted REST execution** (design `2026-09-21-phone-vs-agent-design.md` §5): same registry, same routing, same structural withholding as auth-session. An eval flow's `restful.request` Setup step (validated shape, `${secrets.*}`/`${phoneNumber}` placeholders) is resolved by Core from the **frozen job snapshot's** `stepsPrefix` — addressed by `stepIndex` — at `POST /api/eval-agent/jobs/:jobId/restful` (lease-fenced; caller supplies only `stepIndex` + the `phoneNumber` variable, never the template) and dispatched to a live `restful` broker via `executeViaBroker`; everything returned to the agent is redacted with the resolved secret values then capped. Org-owned eval flows resolve through `orgAllSecretsForTrustedExec` (same R3 fence, all classes — Core→broker path only).
- **Credential fingerprints** (`valueLength` + first-10-hex-MD5 `valueFingerprint` on `GET /api/secrets`) let an owner verify a stored value (`printf %s 'value' | md5sum | cut -c1-10`). MD5 is deliberate (owner-reproducible). **Personal secrets only** — org secrets have none because `upsertOrgSecret` keeps the original `createdBy`, so post-rotation the fingerprint would false-mismatch (needs an `updatedBy` column first). Credential-returning routes are excluded from request logs via `server/sensitive-paths.ts` (its test scans `routes.ts`). See `shared/credentials.ts`.
- **Shared-tier gates:** marketplace dispatch of a login secret additionally requires `isTestAccount` attestation and `credentialConsent` on the job snapshot, checked before `authorizeDispatch`.
- `eval_agents.observed_ip` is Core-internal (register/heartbeat IP, fire-and-forget) — never exposed on any endpoint; future network labeling derives from it.

### Users, Orgs, Limits
- Plans: `basic` (free), `premium` (paid), `principal` (Scout, internal), `fellow` (external prestige). `isAdmin` flag for system management. Init creates admin (active) + Scout (needs activation).
- Orgs: first user is org admin; Premium seats with volume discounts (`pricingConfig`).
- Project/eval flow caps: basic 5×10, premium 20×20, org 100×20.
- Visibility (eval flows + eval sets): `public`/`private` (private is Premium+). Principal/Fellow can mark mainline.

### Permission Model (`server/permissions.ts`)
**A system admin is NOT a super-editor** — admin powers are user management + provider config + **delete (moderation)** only.
- `canAccessResource` (view): owner, same-org, public, or admin
- `isOwnerOrOrgManager` (edit / run-private): owner/creator or org manager — **no admin bypass**; used by PATCH routes and `canRunEvalFlow` for private eval flows
- `canEditResource` = `isAdmin || isOwnerOrOrgManager` — kept for **delete** routes only
- `canRunEvalFlow` (**console only**): public → anyone; private → `isOwnerOrOrgManager`. "Anyone on a public flow" is a deliberate console exception so people can try Vox with an easy test run. **`/api/v1` run is stricter — the eval flow's `ownerId` only, not org managers** — and must stay that way (decision #200); don't "unify" the two.
- `canViewJob` / `canCancelJob` (jobs): **one rule each, shared by the console and `/api/v1`** — they are separate handlers and drifted apart before. View: anyone who can view the job's eval flow (live visibility), or the runner once the flow is deleted. Cancel: the person who started the job, **or** whoever controls its eval flow (`isOwnerOrOrgManager` — secrets follow eval-flow ownership, so a run on your flow spends your credentials and you must be able to stop it); viewing is never enough. Admins may view and cancel anyone's. Job lists take `scope=mine` (default) | `visible` (the view rule, as SQL in `storage.evalJobConditions` — keep in step).
- **API keys never carry admin rights** (`authenticateApiKey` sets `isAdmin: false` on `req.apiKeyUser`), even an admin's own key: every admin power — moderation, `requireAdmin` routes, the admin arms of the job rules — is browser-session only.
- **The `/api/admin` prefix is exact for Core routes:** every admin-only route in `server/routes.ts` lives under it, and everything under it is exactly `requireAuth, requireAdmin` (session only) — enforced both ways by `tests/admin-routes.test.ts`, so it can be governed as a unit. Plugins keep their own admin routes under `/api/plugins/<id>` (e.g. credits). Reads others need stay outside (`GET /api/providers`, `GET /api/region-locations`); routes open to more than admins go elsewhere (`GET /api/clash/runners`: admin + principal/fellow); machine routes (`/api/brokers/register`) are not admin routes. "Owner **or** admin" moderation checks stay on the resource's own path.
- `canScheduleEvalFlow` (schedule / run-now / enable / re-cron): **owner/creator only** — a recurring schedule is an indefinite commitment. The scheduler re-checks per tick and disables schedules whose creator lost the right. (Extend + run-once are looser: owner-or-org.)

**Org membership goes through the `vox.organizations` seam** (`server/organizations.ts`): in application code, `getOrganizations().getMembership(userId)` is the only supported way to ask which org a user belongs to. The provider is **plugin-or-absent** — `server/index.ts` installs `plugins.services.optional("vox.organizations", "^1.0.0") ?? null` at startup; there is no Core-side fallback (`CoreOrganizations` was deleted in the Release A flip — see the runbook below). The `organizations` plugin (`plugins/organizations`, enabled via `VOX_PLUGINS`) is the only implementation shipped: it owns org data in its own `plugin_organizations` schema (Core user ids as opaque integers; org secrets stored as ciphertext only — the AES-256-GCM key never enters the plugin, Core encrypts/decrypts). Membership is resolved once per request at the auth boundary, so `AuthUser` carries `membership` and deliberately **omits** the raw columns — reading them is a compile error, and `tests/organizations-boundary.test.ts` fails the build if one creeps back via `storage.getUser()` (the same scan also pins the `orgSecrets` table to 4 leftover provider-serving `storage.ts` methods, callerless since the flip, deleted in Release B). The plugin's contract is locked against Core's seam type at **compile time** by `server/plugins/contract-checks.ts` (`AssertAssignable` both directions — drift fails `npm run check`, not just a test). Resource ownership (`evalFlow.organizationId` and the other resource-ownership columns) is unaffected: those are Core FK columns compared as opaque integers.

**The seam is the full org contract, not just membership reads** (`OrganizationsProvider` in `server/organizations.ts`, 16 methods): membership reads/counts (`getMembership`/`getMemberships`/`listMembers`/`countMembers`/`countOrgAdmins`), org CRUD (`createOrganization`/`updateOrganization`/`setVerified`/`addMember`/`setMemberRole`/`removeMember`), and org secrets as ciphertext-only rows (`listOrgSecrets`/`upsertOrgSecret`/`deleteOrgSecret` — the provider never sees plaintext; `encryptValue`/`decryptValue` stay in Core). `getOrganizations()` is **nullable** — a plugin may not be installed, and that's a legal state, not a startup bug:
- **Absent ⇒ orgs inert:** org routes 501 (`requireOrganizations`), job-creating routes 501 on org-owned eval flows, the scheduler skips (never disables) schedules targeting team-tier dispatch, sweeps exclude the team arm, and no code path performs a persistent write. Proven zero-write over both scheduler and reap workers in `tests/organizations-absence.test.ts`.
- **A `dispatchBlocked` reason is always computed, never stored** — so a schedule re-enables itself for free the moment a provider comes back, with no migration/backfill to undo.
- **Provider failure (a thrown error) is NOT absence** — gating points that can tolerate "no org" still treat a thrown error as absence (skip, never disable); paths that must give an answer surface `503 "Organizations service unavailable"` (vs `501 "Organizations feature not enabled"` when the provider is simply absent). `membershipFor` rethrows rather than swallowing to `null`.

**The six former `storage.ts` SQL bypasses are closed:**
- **R1** (`getEvalAgentsWithTokenTier`'s `tokenOwnerOrgId` join on `users.organization_id`) — removed; callers batch `getOrganizations()?.getMemberships(tokenCreatedBy[])` at the routes.ts call sites instead (`server/routes.ts`).
- **R2** (`claimEvalJob`/`getClaimableJobsForToken` team-arm filter on live `creator.organization_id`) — the claim SQL now reads the frozen `eval_jobs.creator_org_id`, stamped from `user.membership` at job-creation time (migration 0036). **Pinned semantic change:** a pending team job now keeps the claimability it had the instant it was created — a creator's mid-flight org change no longer alters it. Backfilled for pre-existing rows; frozen going forward. Proven both directions in `tests/org-claim-stamp.test.ts`.
- **R3** (org-credential fence): `orgRuntimeSecretsForJob` (`server/routes.ts`, sole caller of the org-secret decrypt tail) resolves the job creator's membership through the seam and compares it to the eval flow's org before releasing ciphertext — cross-org negative covered in `tests/org-secret-fence.test.ts`.
- Remaining counts/writes (roster, admin counts, org secrets CRUD) go through the provider directly — no parallel SQL path.

**Release A has landed; the old columns are frozen, not dropped.** Release A (`b13c12a` + `f6b9fdb`) dropped the 10 org FK constraints (ids are opaque integers on Core tables now) and deleted `CoreOrganizations`, but `users.organization_id`/`org_role` and the old `public.organizations`/`public.org_secrets` tables still physically exist — unread and unwritten by any code path (no-dual-read, achieved). Release B (dropping those columns/tables plus the ~38 dead `storage.ts` methods that reference them) is a **separate, one-way-door release**, taken only after Release A soaks — see the Release A runbook below. Boundary scan (`tests/organizations-boundary.test.ts`) covers snake_case SQL too, with marked exemptions for the layer that serves raw rows, and now scans plugin directories. Design: `designs/2026-09-10-organizations-seam-design.md`; plugin extraction: `designs/2026-09-16-organizations-plugin-extraction-design.md`.

**Secrets follow eval flow ownership** (job-secrets endpoint): org-owned eval flow → org secrets only (fenced by job creator's org membership), never a personal secret; personal eval flow → owner's personal secrets. **Only what the job fills is released** (`secretsJobFills`, #203): computed from the frozen job config with the agent's own filling function (`shared/placeholders.ts` — shared by Core and the agent so they can't disagree). Built-in eval sets (`config.builtIn`) are server-controlled, admin-editable only.

**Secret substitution — one design for web and phone** (`designs/2026-09-29-secret-substitution.md`). Brokered secrets never leave Core (brokers act server-side and return a session or a redacted response); runtime secrets go to the agent, which fills `${config.*}` then `${secrets.*}` just before aeval (web) or DialF (phone) receives the script — one implementation, `vox_eval_agentd/placeholders.ts`, on parsed values (quoted or bare placeholders both work), never touching `restful.request` steps (Core fills those).
- **Only when trusted:** Setup/Teardown (the eval flow's own steps) are always filled; the eval set's scenario only when `evalSetMayUseSecrets` (`server/auth-session.ts`): same secret owner (the org when there is one, else the user) **and** the eval set's owner can edit the eval flow now (`isOwnerOrOrgManager`) — i.e. its author could have written the same references into the Setup. An org-owned eval set created by a plain member, any personal eval set on an org flow, and anyone else's eval set are untrusted.
- **One gate, one stamp:** every job-creating path (console run, `/api/v1` run, schedule create/enable/run-now, scheduler tick) runs `secretGate()` — untrusted eval set referencing a secret, or a missing secret, refuses the job — and passes its answer to `mergeEvalConfig(…, { evalSetSecrets })`, which strips any caller value and stamps it (the signature makes the stamp mandatory). The agent treats an unstamped job as untrusted. A failing organizations provider throws — a tick skips, never disables.
- **YAML alias bombs:** every part a job fills is checked with aliases expanded (`withinBounds`, `MAX_FILL_NODES` 200k, depth 64) before any walk — a parsed alias is a shared reference and ~1 KB of nested aliases exhausts memory. `secretGate` refuses such a job at creation, so it never reaches an agent. Any new code that walks parsed job YAML must run after that check.
- **An untrusted eval set is checked on its whole config** (`untrustedEvalSetConfigError`): every string key becomes a `${config.*}` value, so it may not mention `${secrets.*}` anywhere (directly or via a `${config.*}` it reads), nor — when the eval flow uses secrets — supply a config value the eval flow's Setup/Teardown reads. Server-side, so agents older than the stamp are covered too.
- **No secret value printed, logged, or stored:** logs carry counts and names only, and aeval's output is redacted line by line before the agent logs it (`createRedactingLineLogger`); the agent redacts every job error in one place (`processJobs`) and scrubs every artifact (`scrubSecretsFromArtifacts`: text by content, byte-for-byte; other binaries scanned in full and deleted if they hold a secret; audio never byte-scanned; fail-closed — no upload, output deleted, if a file can't be handled) before upload. Only secrets the job actually filled are redacted; secrets shorter than 4 characters — or with a line under 4 that has letters or digits (a line-by-line echo would expose it; JSON punctuation lines are fine) — can't be stored (`secretValueError`/`MIN_SECRET_VALUE_LENGTH` in `shared/secrets.ts`, used by the console form, both save routes and the agent), and a job using one stored earlier is refused before it runs. Each line of a multi-line value is its own redaction target (`secretNeedles`). Keep it that way — never log a decrypted value or a filled script.

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

Run `./scripts/dev-local-run.sh clean-test-data [--yes]` on a DB that has accumulated suite leakage (it prompts unless `--yes`, and refuses outright if `DATABASE_URL` is not local — the predicates are broad by necessity and cannot tell a fixture from a real row): it disarms orphaned recurring schedules (the expensive kind — they keep firing on their cron long after the run that made them) and deletes by reference, keeping anything a surviving job or schedule points at plus every job that produced an `eval_result`.

**Known gate hazards:**
- Suites leak resources into the dev DB and trip per-user caps (GitHub #134). `clean-test-data` above replaces the hand-written SQL this section used to carry — it covers the same rows plus the `plugin_organizations` leakage from `tests/org-claim-stamp.test.ts` (`r2-org-*`, no `afterAll`; same pre-existing pattern as `tier-pool-claim.test.ts`).
- **Treat a red gate as a real failure.** The suites that used to be waved off as flaky were each a defect, fixed 2026-09-26: two suites leaked *enabled recurring* schedules that kept firing forever (264k jobs / 565 MB accumulated, which is what made logins and list endpoints time out); `site-id-wire` and `dispatch-integration` ran against `wf[0]`/`es[0]` out of a shared list rather than their own fixtures; the my-evals test asserted a `limit` the server documents it ignores; `agent-region.spec.ts` was budgeted below the two page loads it performs.
- Integration suites hit the **already-running** dev server — after changing `server/`, run `./scripts/dev-local-run.sh stop && start` or the change isn't exercised.
- **E2E flakes were three separate causes (#201), each fixed, not retried away:** (1) leaked test users (`@example.com`, `@test.local`) — at ~5,000 the unpaginated `/console/users` page blocked the browser past the admin-login tests' 15 s budget; `clean-test-data` now removes unreferenced test users, and the gate runs it before E2E. (2) One dev server (a single Node process serving the API and every Vite module) can't serve 4 browsers — local Playwright runs 2 workers. (3) Node's 5 s keep-alive default raced socket reuse (`socket hang up`/`ECONNRESET`) — `server/index.ts` sets 65 s. Measured: ~1.7 failures/run before, 0 in 3 cold runs after.

## Eval Agent Daemon

- `vox_eval_agentd/vox-agentd.ts` — the daemon (single source for Docker & local dev); `vox_eval_agentd/Dockerfile`; `aeval-data/` (git submodule); `scenarios/` (YAML configs)
- Eval frameworks are a SEAM (`SUPPORTED_FRAMEWORKS` in `server/storage.ts` + the daemon's `executeJob` switch + `EVAL_FRAMEWORK` default; per-job override via `config.framework`, stamped into every merged job config so an un-upgraded agent can't fall back to its own default); **aeval** is currently the only implementation (`aeval run scenario.yaml` → `metrics.json`). Adding one means: a `SUPPORTED_FRAMEWORKS` entry, an `executeJob` case, and a `resolvableSecretSources` field mapping.
- **An unsupported framework fails closed at three layers** (`unsupportedFrameworkError()` is the one shared check): both run routes refuse it, the scheduler disables the schedule, and the daemon rejects the job. voice-agent-tester was removed 2026-09 — the `app` config key is rejected on eval flows AND eval sets, and migration 0041 deletes any surviving VAT eval flow (unrunnable and uneditable; schedules disabled first, completed jobs keep their history) after failing its queued jobs
- aeval needs `libsndfile1` + `ffmpeg` (Dockerfile has them; install on host for local dev) — without them energy VAD and STT fail with `NoBackendError`
- **aeval ≥0.4 defaults to virtual-soundcard audio I/O** (legacy per-scenario fallback: `audio_io.mode: web_hook`). Linux additionally needs `alsa-utils` + `libportaudio2` and the **host-loaded** `snd-aloop` kernel module as card `VirtualAudio` (`sudo modprobe snd-aloop id=VirtualAudio pcm_substreams=1`; a container cannot modprobe — dockerized agents need **both** `--device /dev/snd` and `--security-opt systempaths=unconfined`, because Docker masks `/proc/asound` by default and aeval resolves the card ID by reading it; the device alone yields "No ALSA card has the ID 'VirtualAudio'" while `aplay` still works, since alsa-utils resolve via `/dev/snd` ioctls). macOS: BlackHole 2ch @ 48 kHz. `dev-local-run.sh` auto-sets this up (`ensure_virtual_audio`); `vox-upgrade.sh` passes the device and warns if the card is missing. The broker never does audio I/O and needs none of this — but that's only true because its composed mint scenario **pins `audio_io.mode: web_hook`** (aeval ≥0.4 platform configs default to soundcard and the session preflight enforces the device even for a zero-audio login; without the pin every mint 502s with SOUNDCARD_DEVICE_NOT_FOUND). Caveat: with `pcm_substreams=1`, concurrent aeval runs on one host contend for the loopback card (affects `--multi-region` local mode)
- The aeval **binary** version is pinned by `AEVAL_VERSION` in `vox_eval_agentd/Dockerfile`; the **data** (config/examples/corpus) is pinned by the `aeval-data` submodule — bump both together on an aeval release
- Metrics mapping (`metrics.json` → `evalResults`): `responseLatencyMedian`/`Sd` from `response_metrics.latency.turn_level[].latency_ms` (true median; population SD, needs ≥2 samples; negative latencies filtered; fallback turn_level → `summary.p50_latency_ms` → `aggregated_summary.avg_response_latency_ms`); `interruptLatencyMedian`/`Sd` likewise from `interruption_metrics.latency.turn_level[].reaction_time_ms`
- **Failure policy:** non-zero aeval exit → job failed; partial results are never reported
- **DialF over Docker (dialfd on host, daemon in container):** `vox-upgrade.sh` auto-detects the dialfd socket and bind-mounts it + an **exchange dir at the identical path both sides** (`.env` keys: `DIALF_SOCKET`, `DIALF_EXCHANGE_DIR` default `$HOME/vox-phone-exchange`), setting `VOX_DIALF_SOCKET`/`VOX_DIALF_EXCHANGE_DIR` in the container. The daemon stages `audio.play` files into `<exchange>/corpus/` (paths valid on both sides) and routes recordings into `<exchange>/recordings` via `job.run`'s per-run `record_dir` (**dialfd ≥ 0.3.16**; precedence per-run > `override.set` > config — older dialfd silently ignores the field and the job then fails with "recording leg missing on disk": upgrade dialfd, don't hand-configure). Socket is file-mounted: dialfd restart ⇒ restart the container (or point dialfd's `control_socket` inside the exchange dir). `lab.trace` steps compile to DialF `log`; relative `file:` refs resolve against aeval-data — so `turn_taking_en` compiles for phone unmodified (`turn_taking_en_phone_smoke` = 3-samples/case trim for short calls; per-case analysis presets/chunking do NOT apply on the phone path).
- **Phone transport (Phase C, design `2026-09-21-phone-vs-agent-design.md` §6):** phone jobs delegate the call to **DialF ≥ v0.3.8** (`dialfd` co-located, per-user service recommended; probe = `server.info` ten_vad≠stub + `server.manifest` spec 0.1 + a connected phone — drives the `phone` capability on register/heartbeat, self-healing). Our SIM's own number is read from DialF (`sims.list`, default SIM preferred) — no env needed. v1 supports the **inbound** mode — direction is always the AGENT's perspective: inbound = we dial the agent (a `call.dial` Setup step → `job.run` → conversation compiled from the eval set via the corpus index → `aeval analyze` on the session dir → metrics + `callMetadata`); the trigger/**outbound** mode (agent calls us after a REST/web trigger) is pending DialF R7 (machine-readable serve results / `call.wait_for_ring`). One call at a time per host (DialF's sound-card lock aligns with the daemon's one-job model; the daemon's failure-rescue `call.hangup` is line-wide by the same assumption — on a host with several agents sharing one dialfd it could end another agent's call, `job.cancel` alone is job-scoped). **Unified steps model** (design `2026-09-25-unified-workflow-steps-design.md`, migration 0040): Setup/Teardown Steps are the same fields in every Evaluation Mode; phone Setup = `call.dial`/`call.wait_answered` (+ leading `restful.request` pre-call steps, executed daemon-side via Core), Teardown = `call.hangup` — the daemon splits the script by Libretto execution class, hands the session block to DialF whole, appends a trailing `call.hangup` when Teardown omitted one, and best-effort `job.cancel`+`call.hangup` rescues on any `job.run` failure so a call is never left off-hook. Step vocabulary is validated per transport at save (`validateStepsScript` in `server/storage.ts`); the run route refuses a phone eval flow whose Setup has no `call.dial` (trigger-only scripts name the R7 gap). The old `phoneDial`/`restfulTrigger` config keys are deleted (rejected at save with pointer errors).

## Key Files

- `shared/schema.ts` — all tables/enums/Zod schemas (single source of truth)
- `shared/secrets.ts` — secret naming + `isAuthFieldName`; **client-safe, must stay dependency-free**
- `shared/credentials.ts` — redaction + fingerprinting shared by Core/daemon/broker; **Node-only, never import from client/**
- `shared/mint-timeout.ts` — the one clamped `WEB_SESSION_MINT_TIMEOUT_SECONDS` reader; the clamp orders four deadlines (broker child < Core abort +15s < stale reclaim +30s < daemon's hard-coded 240s poll) — raising `MAX_MINT_TIMEOUT_SECONDS` requires raising that poll too
- `server/routes.ts`, `server/storage.ts`, `server/auth.ts`, `server/permissions.ts`, `server/stripe.ts`, `client/src/App.tsx`
- `designs/CLASH_DESIGN.md`, `designs/vox-arch.png`; dated design docs in `designs/` carry the reasoning per change. `designs/IMPLEMENTATION_PLAN.md` is the ORIGINAL plan, kept for history and no longer accurate
- `scripts/vox-upgrade.sh` — upgrade eval agent / clash runner containers

## Deployment & Notes

- CI/CD: GitHub Actions → Coolify webhook on push to main (`.github/workflows/deploy.yml`)
- Default providers (all `convoai`): Agora ConvoAI Engine (`agora`), LiveKit Agents (`livekit`), ElevenLabs Agents (`elevenlabs`), Custom (no `platformId`). `providers.platformId` matches the eval flow's `platform.setup → platform_id`; seeding is idempotent-by-name from both migrations and `/api/auth/init`
- Common tasks: new table → schema.ts → migration → storage.ts → routes.ts; new page → `client/src/pages/` → route in `App.tsx` → `ConsoleLayout` + TanStack Query
- Deployment guide for humans: `docs/DEPLOYMENT.md` (env vars, `VOX_PLUGINS`, Coolify, migrations, brokers, checklist) — keep it in step with this file.
- **OAuth plugin — LIVE in prod (2026-09-27).** `VOX_PLUGINS=credits,shared-agents,organizations,oauth` on Coolify; GitHub sign-in on, Google off until a Google OAuth client exists (redirect URI `https://vox.agora.build/api/plugins/oauth/google/callback`, `GOOGLE_CALLBACK_URL` already set). Rollout rule for any **new plugin id**: add it to `VOX_PLUGINS` right before the release that contains it deploys — earlier, a restart of the old build crash-loops on the unknown id; later, the new build boots without the feature.
- **Plugin migrations are checksummed** (`_plugin_schema_versions`): editing one after it has run on a database stops that instance from starting (`checksum mismatch`). Add a new migration instead. Locally, if you edited one during development, reset that plugin: `DROP SCHEMA plugin_<id> CASCADE; DELETE FROM _plugin_schema_versions WHERE plugin_id = '<id>';`.

### Organizations Plugin — Release A Runbook
**Status: Release A is LIVE in prod (2026-09-19).** `main @ 4f1d45f`, schema v38, `VOX_PLUGINS=credits,shared-agents,organizations` on Coolify; `organizations` plugin active, orgs are plugin-backed. Cutover note: the deploy first crash-looped on migration 0037 (FK-name divergence — see the migrations section) and was recovered fix-forward (0037 rewritten to drop both name variants with `IF EXISTS`). Release B (below) remains deferred until Release A soaks.

Enabling `organizations` on an instance that already has org data (Release A cutover):
1. **DB snapshot first.**
2. Add `organizations` to `VOX_PLUGINS` in Coolify — **env var only**, no code change.
3. Deploy with a **stop-then-start, never a rolling restart**: writes the old container makes *after* the plugin's copy migration commits are silently lost (uncopied, and the old release is about to stop reading them anyway) — see `plugins/organizations/migrations/0002_copy_from_core.sql`'s header for why REPEATABLE READ isn't the fix.
4. **Fail-closed by design:** a parity or preflight failure in the copy migration aborts the migration transaction — the container refuses to start and the old release keeps serving. The three named preflight errors (duplicate `org_secrets` names, dangling `users.organization_id`, dangling `org_secrets.organization_id`) name the offending rows directly.
5. **Verify after deploy:** `GET /api/plugins` lists `organizations`; `GET /api/plugins/organizations/health` is `ok`; the startup log shows `plugins loaded: ...` including `organizations`.
6. **Never remove `organizations` from an instance with org data** — it would silently make membership inert (Phase-1 absence semantics), not fall back to the old columns. `vox.agora.build` now runs `organizations` in prod (enabled 2026-09-19); once enabled on an instance, it stays enabled.
7. Release B (dropping `users.organization_id`/`org_role`, `public.organizations`/`org_secrets`, and the ~38 dead `storage.ts` methods) is a **separate release after soak** — a one-way door; snapshot again before taking it.
