# Organizations Plugin Extraction — Design

**Date:** 2026-09-16 (rev 2 — after dual review: factual audit + adversarial review, both findings incorporated)
**Status:** Decisions answered 2026-09-16; reviewed twice; ready for the implementation plan
**Depends on:** the organizations seam (`designs/2026-09-10-organizations-seam-design.md`, branch
`feat/organizations-seam` — 18 commits, reviewed, currently unmerged)

## Goal

Make Organizations an actual plugin: `plugins/organizations` owns the org tables and logic,
provides `vox.organizations`, and can be left out of `VOX_PLUGINS` on instances that do not
need orgs. Absence is **inert and reversible**: functions stop, data stays, re-enabling
restores everything.

## Decisions (answered 2026-09-16)

1. **Absence semantics — orgs go inert.** No plugin → cannot create an org, org-owned
   resources unreachable, `team` tier dead. See §7.
2. **Scope — membership + identity + org secrets.** Billing/seats remain Core-owned (they are
   touched only at the integration edges — see §5; the tables, Stripe logic and routes do not
   move).
3. **No dual-read.** The safety net is CI verification before the one-way door (§10) plus a
   database snapshot before each cutover release.
4. **Sequencing — now.**
5. **Disabling the plugin is non-destructive** — enable → use → restart without it (functions
   stop) → restart with it later → everything intact. Zero persistent writes may result from
   plugin absence (§7).

## 1. Current state

Done (seam branch): `server/organizations.ts` (interface + holder; `getOrganizations()`
currently throws if unwired), `server/organizations-core.ts` (`CoreOrganizations`), startup
resolution preferring a plugin (`server/index.ts:223-225`), all Core application-code
membership reads behind the seam, override + boundary guard tests.

Not started: any plugin.

**Membership still bypasses the seam in six `storage.ts` sites** (the boundary scan exempts
`storage.ts` wholesale, so none are visible to it):

| Site | Kind | What it decides |
|---|---|---|
| `storage.ts:804` | SQL join | `getEvalAgentsWithTokenTier` → `tokenOwnerOrgId` for run-targets list (`routes.ts:3398/3404`) and tier-availability count (`routes.ts:4615/4728`) |
| `storage.ts:966`, `:1021` | SQL filter | `team` arm of `claimEvalJob` / `getClaimableJobsForToken` — who may claim a team-pooled job |
| `storage.ts:2731` | raw-row read | `getOrgSecretsForJob` fence — whether a job may spend an org's credentials |
| `storage.ts:2029` | SQL count | `countOrgAdmins` — last-admin protection (`routes.ts:5699`) |
| `storage.ts:2036` | SQL count | `getOrganizationMemberCount` (`routes.ts:5833`, `:5866`) |
| `storage.ts:2043` | **write** | `removeUserFromOrganization` — clears the columns (`routes.ts:5753`, `:5789`) |

Plus **two membership writes outside the org routes**: `POST /api/auth/register` sets
`organizationId`/`orgRole` when redeeming an org invite (`routes.ts:852-862`) — the only path
by which a second person ever joins an org — and `POST /api/organizations` sets the creator's
membership (`routes.ts:5498-5501`).

All of the above must route through the seam before `users.organization_id` can be dropped.

## 2. The constraint that shapes everything

`server/plugins/hosts/http.ts:50` mounts every plugin router at
`app.use('/api/plugins/${id}', router)` — hard-namespaced, and there is no other mounting
path (`context.ts:51`, `loader.ts:78`, `RouteRegistrar` in `packages/plugin-sdk/index.ts:38-45`).
A plugin cannot serve `/api/organizations/:id`. The platform is also backend-only: no client
extension point exists.

## 3. Architecture: plugin owns the data, Core keeps the doorway

| Layer | Owner |
|---|---|
| Org tables, queries, business rules, org-secret ciphertext | **Plugin** (`plugin_organizations` schema) |
| The public HTTP paths | **Core**, as thin adapters over the seam |
| The console | **Core**, with one capability flag (§8) |
| Seats/Stripe billing | **Core**, unchanged except the integration edges in §5 |

**Route inventory, corrected by review** (23 org routes total, `server/routes.ts`):

- **13 become seam adapters** — org CRUD (`:5464`, `:5511`, `:5538`), invite mint (`:5565`),
  members list/role/remove (`:5620`, `:5656`, `:5723`), leave (`:5771`), admin verify/list
  (`:5807`, `:5826`), `/api/user/organization` (`:5852`), org-secrets GET/POST/DELETE
  (`:2813`, `:2843`, `:2895`).
- **1 needs no change** — `POST /api/organizations/move-resources` (`:1451`) reads only
  `user.membership` and mutates Core resource tables (`projects`, `workflows`, `eval_sets`,
  `eval_schedules`). Already seam-clean; org id is an opaque integer here.
- **8 stay as-is** — seats + payments (`:5895`–`:6236`): Core tables, Stripe, org id opaque.
  (One touchpoint: setup-intent reads org identity for the Stripe customer name,
  `routes.ts:6083` — that read goes through `getOrganization` on the seam.)
- **2 auth-path writes join the migration** — register-with-invite (`:852-862`) and
  org-create's creator membership (`:5498-5501`) route through `addMember` /
  `createOrganization`.

Rejected alternatives (unchanged from rev 1): moving routes into the plugin namespace breaks
all 23 public paths and the console; an HTTP proxy layer adds two hops and a session-forwarding
problem to avoid writing thin handlers.

## 4. The provider interface (full, corrected by review)

The rev-1 sketch could not reproduce today's responses. The real surface:

```ts
export interface Organization {          // full row — three routes res.json() it verbatim
  id: number; name: string; address: string | null;
  verified: boolean; createdAt: Date; updatedAt: Date;
}
export interface OrgSecretRow {          // hand-written, NOT drizzle-inferred (the drizzle
  id: number; organizationId: number;    // type dies with shared/schema.ts's table in Release B)
  name: string; encryptedValue: string;  // ciphertext passes through opaque
  brokerType: string | null; isTestAccount: boolean;
  createdBy: number | null; createdAt: Date; updatedAt: Date;
}

export interface OrganizationsProvider {
  // reads (existing)
  getMembership(userId: number): Promise<Membership | null>;
  getMemberships(userIds: number[]): Promise<Map<number, Membership>>;
  getOrganization(orgId: number): Promise<Organization | null>;
  listMembers(orgId: number): Promise<Array<{ userId: number; role: OrgRole }>>;
  // reads (new — the counts the routes actually use)
  countMembers(orgId: number): Promise<number>;
  countOrgAdmins(orgId: number): Promise<number>;
  listOrganizations(): Promise<Organization[]>;              // admin console
  // mutations
  createOrganization(input: { name: string; address?: string }, creator: { userId: number }): Promise<Organization>;
  updateOrganization(orgId: number, patch: { name?: string; address?: string }): Promise<Organization>;
  setVerified(orgId: number, verified: boolean): Promise<void>;   // writes the `verified` column
  addMember(orgId: number, userId: number, role: OrgRole): Promise<void>;   // throws AlreadyMemberError if user belongs to ANY org
  setMemberRole(orgId: number, userId: number, role: OrgRole): Promise<void>;
  removeMember(orgId: number, userId: number): Promise<void>;
  // org secrets — ciphertext only; the key never enters the plugin
  listOrgSecrets(orgId: number): Promise<OrgSecretRow[]>;
  upsertOrgSecret(orgId: number, row: { name: string; encryptedValue: string; brokerType: string | null; isTestAccount: boolean; createdBy: number }): Promise<OrgSecretRow>;  // returns the row — routes.ts:2887 echoes brokerType/isTestAccount
  deleteOrgSecret(orgId: number, name: string): Promise<void>;
}
```

Rules the interface encodes:

- **Authorization stays in Core.** The provider executes; it never decides. `requireOrgAdmin`
  and the predicates keep gating routes.
- **At-most-one-org is the provider's invariant now.** Today it is physically enforced by
  `users.organization_id` being one column. The plugin's `memberships` table carries
  `UNIQUE (user_ref)`, and `addMember` throws a typed `AlreadyMemberError` (register-with-invite
  and create-org surface it as today's 400s). §Non-goals still excludes multi-org; this is
  where the constraint that keeps that true now lives.
- **Transactions do not cross the boundary.** `ctx.db.withTransaction` gives the plugin
  intra-plugin atomicity (org + owner membership commit together). Core-side compensating
  writes follow a fixed order (§5). No distributed transaction is attempted.
- **Error semantics: "cannot answer" ≠ "no".** A loaded-but-failing provider (DB blip) must
  not be indistinguishable from "user has no org" — that distinction is what keeps a transient
  failure from becoming a persistent write (§7). Contract: providers **throw** on failure;
  Core's gating choke points catch and treat *unavailable* exactly like *absent* (skip, 503
  where an answer is required — never a membership-shaped `null`, never a disable).

Core-side additions the routes need: `storage.getUsersByIds(ids)` (the members list joins
roster user rows — `username/email/plan/createdAt` — and no such method exists today), and
`CoreOrganizations.getMemberships` becomes a single query over it (fixing the recorded N+1).

## 5. Seats/billing: unchanged, but the integration edges are real

Review falsified "untouched": org create writes a Core seat row (`routes.ts:5489`),
remove/leave decrement it (`:5758`, `:5794`), invite gates on seat availability (`:5584`),
two listings join seats (`:5828-5841`, `:5864-5873`), setup-intent reads org identity
(`:6083`). The tables, Stripe logic and the 8 routes stay in Core; what this cycle specifies
is the **write-order contract** for the cross-boundary flows:

- **Create:** plugin `withTransaction(org + owner membership)` commits **first**; Core inserts
  the seat row after. A crash between the two leaves a missing seat row — tolerated everywhere
  today (`seats?.totalSeats || 0`), so the failure mode is benign. The reverse order is not.
- **Remove/leave:** plugin removes membership first; Core decrements the seat count after.
- **Seat-availability and last-admin checks** stay Core-side, reading counts through the seam
  (`countMembers`, `countOrgAdmins`).

`organization_seats.organization_id` keeps its column (opaque integer) but must drop its FK —
and it is the **only** org FK with `ON DELETE CASCADE` (`shared/schema.ts:644`,
`migrations/0000:310`). No org-deletion route exists anywhere in `server/`, so nothing relies
on that cascade today; after the drop, org deletion (if ever built) must clean the Core seat
row explicitly. One sentence in the plugin's SPEC records this.

## 6. Two releases — forced by the migration runners

Review finding (blocking, verified): Core migrations run **pre-start** in a separate process
(`package.json:10`: `node dist/migrate.cjs && node dist/index.cjs`); plugin migrations run
**in-app after start** (`server/plugins/loader.ts:56`). Within any single release, Core drops
would execute *before* the plugin copy reads the data. A one-release cutover is physically
impossible. The sequence:

**Release A — cutover.** Ships together because FK-drop-then-copy is the correct order:
- Core migration (generated from `shared/schema.ts`, registered in `server/migrate.ts`'s
  `MIGRATIONS`): drop the **10** org FK constraints on Core-retained tables — users, projects,
  workflows, eval_sets, eval_schedules, payment_methods, payment_histories, invite_tokens,
  web_sessions, **organization_seats** (11 references exist in schema.ts; `org_secrets`'
  travels with its table in Release B). In `shared/schema.ts`, `.references(...)` comes off
  those columns (plain `integer()`) or `db:generate` recreates them.
- Plugin ships: schema + **copy migration** (plugin migrations can read `public` —
  `SET LOCAL search_path TO "<schema>", public`, `server/plugins/migrate.ts:78`):
  `INSERT ... SELECT` with explicit ids; `setval` the plugin sequences to `max(id)`;
  membership copied out of `users.organization_id`/`org_role`; then **in-migration
  assertions** — row counts and `max(id)` equal on both sides, or the migration throws and
  the app refuses to start. Ids must survive verbatim: nine Core tables reference them as
  integers.
- Resolution flips: `getOrganizations()` becomes **nullable** (absent → §7 semantics), the
  `?? new CoreOrganizations(storage)` fallback is **deleted along with `CoreOrganizations`**.
  Review finding: leaving the fallback alive past the copy is an authorization regression —
  an operator dropping the plugin from `VOX_PLUGINS` would silently serve *pre-cutover*
  memberships from the stale columns as current, instead of going inert.
- After Release A the stale `users.organization_id`/`org_role` columns and the old
  `public.organizations`/`org_secrets` tables still exist but are **never read or written** —
  that is the no-dual-read guarantee in its achievable form.

**Release B — the drops.** Core migration: drop `users.organization_id`/`org_role`,
`public.organizations`, `public.org_secrets`; remove both tables from `shared/schema.ts`
(that is what makes `db:generate` emit the drops); delete or re-point the surviving org
storage methods **in the same commit** — review counted ~38 `storage.getOrganization*/
getOrgSecret*/getUsersByOrganization/...` call sites that would keep compiling against
dropped tables, so `tsc` only protects Release B if the methods go with the tables. The seam's
`OrgSecretRow`/`Organization` types are hand-written (§4) and survive.

**Rollback:** DB snapshot before each release. Release A rollback = restore snapshot +
previous image (the copy is additive, but the FK drops and resolution flip are not worth
reversing piecemeal). Release B rollback = restore snapshot, full stop — it is the one-way
door and is taken only after Release A has soaked.

## 7. Absence must be inert — the full audit (review-expanded)

**Requirement:** enable → use → run without the plugin (functions stop) → re-enable later →
everything back, zero data loss. Therefore: **zero persistent writes may be caused by plugin
absence or provider failure.**

Without the provider: `hasOrg` false, `sameOrg` never matches, org-owned resources
inaccessible, `team` tier dead, org routes fail cleanly, personal/`private`/`public`/`shared`
unaffected. HTTP contract: org routes return **501 "Organizations feature not enabled"** —
including the 14 `requireOrgAdmin`-gated routes, so that middleware distinguishes *provider
absent* (501, checked first) from *caller has no membership* (403, unchanged). One status for
one cause, consistently.

**Write paths reachable from absence — each gets an explicit guard and a test** (the rev-1
audit listed two; review confirmed a third and found three more):

| Path | Today's effect under absence | Required behavior |
|---|---|---|
| `index.ts:442-444` — sessionPoolViolation on null creator org | schedule **disabled** | skip |
| `index.ts:458-460` — org secrets read as missing | schedule **disabled** | skip |
| `index.ts:465-467` — `misconfigured` stamp: `detectSessionNeed` → `getBrokeredSecretNames` → `getOrgSecrets` (`auth-session.ts:112-113`) — **confirmed third destructive write**, not a "candidate" | schedule **disabled** | skip |
| `auth-session.ts:122` — mint path can't resolve org secret | `web_sessions.status='failed'` + failed job | never reached: the skip short-circuits first |
| `runMaintenanceTasks` (`index.ts:288-313`) — `failPendingJobsWithNoAgent` / `failExpiredPendingJobs` | every pending `team` job **permanently failed** (claim arm can never match), escrow settled | fail-sweeps exclude team-tier pending jobs while orgs are unavailable — transiently unclaimable is not expired |
| `storage.ts:2731` fence returns `{}` | job runs, aeval aborts on unresolved secret, job failed | org-workflow jobs are not dispatched at all while orgs are unavailable |

**Mechanism:** one scheduler discriminator — `provider unavailable && workflow.organizationId != null`
→ skip — placed **before** `detectSessionNeed` (`index.ts:437`) and `stampOwnerSession`, so a
skipped schedule never burns a broker mint on its way to being skipped. Same predicate gates
the maintenance sweeps' team-tier exclusion. Provider *failure* takes the identical path as
absence (§4 error contract): a transient DB blip must never disable a schedule.

**The reason is computed, never stored.** Schedules list (`GET /api/eval-schedules`,
`routes.ts:2200`, flags at `:2219-2227` — **both** the normal and the admin
`getAllEvalSchedulesWithWorkflow` branches) gains:

```ts
dispatchBlocked: { reason: "organizations-unavailable",
                   detail: "Organization plugin/feature not enabled" } | null
```

Self-clearing on re-enable, zero writes, honest in the UI. Scheduler logs the skip once per
tick, not once per schedule.

**The test is concrete:** with the provider absent, tick `processScheduledJobs` **and**
`runMaintenanceTasks` against a seeded org schedule + pending team job, and assert **zero
rows changed** (review: the rev-1 test ticked only the scheduler and would have missed the
sweep failures).

## 8. Client changes — small, but more than one line (review-corrected)

Server: `/api/config` (`routes.ts:5405`) gains computed `organizationsEnabled` — appended the
way `geoipAttribution` is (`:5417-5418`), **not** via `PUBLIC_CONFIG_KEYS` (that whitelist is
for DB `systemConfig` rows).

Client (`user.organizationId` on the client is already seam-computed server-side —
`routes.ts:341-342` — so absence automatically reads as "no org" everywhere; these are the
places that then do the wrong thing):

1. `console-layout.tsx:235-241` — the unconditional "Create Organization" nav entry (the org/
   members/**billing**/settings entries at `:208-233` — four, not three — already gate
   correctly). This component does not currently fetch `/api/config`; it gains the query.
2. `client/src/App.tsx:562-564, :606-608, :650-651, :694-695` — four route guards that
   **actively redirect** org-less users to `/console/organization/create`; plus `:738-740`
   redirecting org-ful users away from it. Under an org-less instance every deep link to
   `/console/organization*` funnels into the 501 form. All five guards gate on
   `organizationsEnabled`.
3. The schedules view renders `dispatchBlocked` (a computed field nobody renders is
   invisible).

## 9. Invite / register — the join flow the rev-1 design omitted

`invite_tokens` is a Core table and stays one (`organization_id` opaque). The flow
post-extraction:

- Mint (`routes.ts:5565`, admin variant `:655`): Core validates org-admin + **seat
  availability** (`:5584`, Core-side per §5), writes the invite row.
- Redeem (`/api/auth/register`, `:832-864`): Core validates the token, creates the user, then
  calls `addMember(invite.organizationId, user.id, 'member')` through the seam instead of
  writing columns. `AlreadyMemberError` cannot occur for a just-created user; the handler
  still maps it defensively to the route's existing 400.
- Org-create (`:5498-5501`): creator membership via `createOrganization`'s intra-plugin
  transaction (§5).

## 10. Verification — what replaces both dual-read and the rev-1 differential test

Review finding: the rev-1 "run the org route suite against both providers" is not runnable as
described — the API suite hits an already-running server (no in-process harness, no second
server in CI), the test would have a one-release lifetime, and independently-seeded databases
make "identical responses" false by construction. Replaced with a three-layer net that keeps
the intent (CI proof before the one-way door):

1. **Copy integrity, inside the migration** (§6): row counts + `max(id)` assertions that fail
   startup rather than serving wrong data. Cheap, runs on every environment including prod.
2. **Provider equivalence at the seam:** the existing seam/override/org unit suites run
   against the plugin provider on the dedicated plugin test DB
   (`tests/helpers/plugin-test-db.ts`), the same way credits' destructive tests do — plus the
   Task-10-style disagreement test pointed at the plugin. Proves the plugin implements the
   contract, without needing two servers.
3. **Post-Release-A smoke:** the org routes exercised against a local/staging server with the
   plugin enabled (the ordinary integration suite, since after Release A the plugin **is** the
   provider), before Release B is cut.

**Test-evidence standard, restated** (review falsified "api.test.ts passes unedited"):
`tests/api.test.ts:4231-4232` writes `users.organization_id` raw, and
`tests/tier-pool-claim.test.ts:108` / `tests/session-secrets-class.test.ts:60` seed orgs via
storage. Test **plumbing** may change (seeding through the seam/plugin instead of columns);
**assertions may not**. "No assertion changes" is the standard the plan holds.

**Boundary scan hardening** (review: the current scan cannot see any of this): add a
**snake-case** pattern (`users.organization_id`, `org_role`) so surviving SQL is caught;
narrow the `storage.ts` exemption to the provider-serving methods instead of the whole file;
extend the scan to `plugins/organizations/server/**` (its own tables have different names, so
the Core-column patterns stay valid there).

## 11. Residuals R1–R3: the mechanisms (review: "one line each" was not a plan)

- **R1 (`storage.ts:804` join):** the two consumer routes batch-resolve owner orgs through
  `getMemberships` (single-query after §4's `getUsersByIds` fix) and stop selecting
  `tokenOwnerOrgId` from the join.
- **R2 (claim SQL, `:966`/`:1021`) — decided: stamp, don't join.** New column
  `eval_jobs.creator_org_id`, written at job creation from the seam (matching the existing
  frozen-`snapshot`/`tokenVisibility` pattern), Core migration + backfill from
  `users.organization_id`; the claim SQL compares the stamped column. **Semantic change,
  accepted and pinned by test:** today a pending team job stops being claimable the moment its
  creator leaves the org; stamped, it stays claimable until claimed or reaped. The window is
  bounded by pending-job lifetime, and schedule-level freshness is preserved (the scheduler
  re-checks per tick). The alternative — per-candidate seam lookups inside
  `FOR UPDATE ... SKIP LOCKED` — puts N async calls in the hottest lock path.
- **R3 (`storage.ts:2731` fence):** creator membership through the seam, compared to
  `workflow.organizationId` in Core. Its own task, its own cross-org negative test, strictest
  review on the branch — this is the check that stops one org spending another's credentials.
- Counts/write sites (`:2029`, `:2036`, `:2043`) are absorbed by §4's interface.

## 12. Phasing & ordering

**Phase 1 — pre-plugin (one branch, ships green, no behavior change for org-ful instances):**
merge the seam branch first (user's mark), then: R1/R2/R3; interface growth (§4) with
`CoreOrganizations` implementing everything against today's tables; the 13 route adapters +
register/org-create writes; nullable-holder groundwork + 501s + absence guards + zero-writes
test (§7); config flag + client changes (§8); boundary-scan hardening (§10). Everything still
backed by Core tables; absence semantics exercised in tests via `resetOrganizations()`.

**Phase 2 — Release A:** the plugin (schema, provider, copy migration + assertions,
provider-equivalence suite), FK-drop migration, resolution flip, `CoreOrganizations` deleted.

**Phase 3 — Release B:** the drops, `shared/schema.ts` removal, storage-method removal, scan
tightening, after Release A has soaked and the smoke suite is green.

Phase 1 is fully shippable on its own and is where the implementation plan starts. Phases 2–3
get their plan once Phase 1 lands (their details — exact copy SQL, plugin file layout — depend
on the interface Phase 1 proves).

## 13. Non-goals

- Front-end plugin extension (client needs exactly one boolean + one computed field).
- Multi-org membership (the `UNIQUE (user_ref)` constraint in §4 is what keeps this deferral true).
- Moving billing/seats or their 8 routes.
- Org deletion (does not exist today; noted in §5 for the cascade it orphans).
- Changing any permission semantics.

## 14. Deployment runbook facts (review-added)

- Plugin load is **fail-closed and pre-listen**: unknown plugin id throws (`loader.ts:42`),
  checksum mismatch throws (`migrate.ts:58`), all before `httpServer.listen`. A `VOX_PLUGINS`
  typo is a crash loop, not a degraded boot. Treat `VOX_PLUGINS` like `DATABASE_URL`.
- Never remove `organizations` from a deployment that has org data — architecturally optional,
  operationally required there (vox.agora.build today has no orgs and simply omits it).
- DB snapshot before Release A and before Release B; Release B only after soak + smoke.
