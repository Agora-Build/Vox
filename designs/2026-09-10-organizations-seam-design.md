# Organizations Seam — Design

**Date:** 2026-09-10
**Status:** Draft for review
**Depends on:** plugin platform core (`packages/plugin-sdk`, `server/plugins/*`), the
`vox.eval-marketplace` seam precedent (`server/marketplace.ts`)

## Principle

**Core may know that a row belongs to org 7. Core may not know what org 7 is, or who
is in it.**

Organizations were always meant to become a plugin (agreed 2026-08-14, restated in the
shared-agents north star 2026-08-18: *"orgs become a plugin, more plugins coming"*).
This design does not move them. It makes the boundary real — every question of the form
*"which org does this person belong to, and with what power?"* is answered by a
replaceable provider, so a later extraction swaps an implementation instead of rewriting
Core.

The seam is the deliverable. The extraction is a later cycle that this makes cheap.

## Current state (what this changes)

Organizations are not shaped like `credits` or `shared-agents`. Those were additive —
new tables, new optional concepts, nothing in Core pointing at them. Organizations are
load-bearing in Core's data model:

| Surface | Size |
|---|---|
| Tables owned | `organizations`, `organization_seats`, `org_secrets` |
| Core tables with an `organization_id` FK | 9 — `users`, `projects`, `workflows`, `eval_sets`, `eval_schedules`, `payment_methods`, `payment_histories`, `invite_tokens`, `web_sessions` |
| Org API routes | 23 (org CRUD, members, invites, seats, Stripe payments, org-secrets, admin verify) |
| Console pages | 6 (`console-organization*.tsx`, `admin-organizations.tsx`) plus org-aware branches elsewhere |
| Direct **membership** reads (user-shaped) | **68** — `routes.ts` 56, `permissions.ts` 5, `routes-api-v1.ts` 4, `auth.ts` 2, `dispatch.ts` 1 |
| Direct **resource-ownership** reads | ~14 — `routes.ts` 9, `auth-session.ts` 5 (all scope derivation; unaffected) |

Two platform facts bound what is possible today:

1. **The plugin platform is backend-only.** `VoxPluginContext` offers `http`, `worker`,
   `health`, `drain`, `provideService` — there is no front-end extension point, and
   `plugins/*/` contains only `migrations/`, `server/`, `tests/`. A plugin cannot own
   the 6 console pages.
2. **Moving `organizations` into a `plugin_organizations` schema would invert the
   dependency.** Nine Core tables would FK into a plugin's schema, so Core would hard-
   depend on a plugin that may be absent — the opposite of the marketplace pattern,
   where Core defines the seam and degrades gracefully.

Both are reasons the data stays put in this cycle. Neither blocks the seam.

## The distinction that makes this tractable

Two unrelated concepts are spelled `.organizationId` today:

- **Membership** — `user.organizationId`, `user.orgRole`. *Which org a person belongs
  to and with what power.* 68 call sites. **This is what a plugin would own, and this
  is what moves behind the seam.**
- **Resource ownership** — `workflow.organizationId`, `project.organizationId`, and the
  other 7 FK columns. *Which org owns a Core row.* ~14 call sites. **This stays Core
  permanently**, as an opaque integer. Core needs no interpretation of the value to
  compare it, store it, or filter on it. `server/auth-session.ts` is entirely of this
  kind — its 5 org reads derive a session *scope* from a workflow and are untouched.

Conflating the two is what would turn a refactor into a data migration. Keeping them
apart is what keeps this to one reviewable PR.

## The seam (`server/organizations.ts`, new)

Modeled on `server/marketplace.ts`, with one deliberate difference: it is **never
null**.

```ts
export interface Membership {
  organizationId: number;
  role: 'owner' | 'admin' | 'member';
}

export interface OrgSummary {
  id: number;
  name: string;
  isVerified: boolean;
}

export interface OrganizationsProvider {
  /** Membership of one user; null = belongs to no org. */
  getMembership(userId: number): Promise<Membership | null>;
  /** Batch form for list endpoints — prevents N+1 on member/agent listings. */
  getMemberships(userIds: number[]): Promise<Map<number, Membership>>;
  /** Org identity, for display and the verification gate. */
  getOrganization(orgId: number): Promise<OrgSummary | null>;
  /** Roster of an org, for member-list endpoints. */
  listMembers(orgId: number): Promise<Array<{ userId: number; role: Membership['role'] }>>;
}

export function setOrganizations(p: OrganizationsProvider): void;
export function getOrganizations(): OrganizationsProvider;  // never null
```

**Resolution** happens once at startup in `server/index.ts`, beside the existing
`setMarketplace(...)` call:

```ts
setOrganizations(
  plugins.services.optional<OrganizationsProvider>("vox.organizations", "^1.0.0")
    ?? new CoreOrganizations(storage),
);
```

`server/organizations.ts` holds only the interface, `setOrganizations` and
`getOrganizations` — no storage import, mirroring how `server/marketplace.ts` is pure
interface plus holder. The built-in implementation lives separately in
`server/organizations-core.ts` as `CoreOrganizations`, reading today's
`users.organization_id` / `users.org_role` columns through a narrow indexed query and
taking `storage` by constructor injection so tests can substitute it. When orgs
eventually extract, that one file is deleted and a plugin fills the same service name —
the call sites do not move again.

**Why never-null**, unlike `vox.eval-marketplace`: the marketplace's absence makes one
optional tier inert, which is a coherent product state. Organizations exist in
production today, and 9 Core tables reference them; an absent provider would mean losing
access to live data. "Absent → orgs inert" is the honest end-state *after* extraction,
and the interface is shaped so that flip is a one-line change to the resolution above,
not an interface change.

**Mutations are deliberately not in the interface.** Creating orgs, inviting, changing a
role and removing a member remain Core routes in this cycle. When orgs extract, those
routes move wholesale into the plugin as plugin HTTP routes; putting them behind a read
seam now would be speculative design for a shape we have not yet had to build. Reads and
writes staying briefly asymmetric is safe because a mutation's effect is visible to the
next request's resolution.

## Per-request membership resolution

The hazard in this project is not the interface — it is that today's predicates are
**synchronous** and read the column straight off the user row, while a plugin-owned
membership requires an async lookup. Making 68 sync call sites async would be the whole
risk of the change.

So membership is resolved **once per request, at the auth boundary**.
`getCurrentUser`, `requireAuth`, `requireOrgAdmin` and `getCurrentUserOrApiKeyUser` in
`server/auth.ts` resolve it and hand back:

```ts
export type AuthUser = Omit<User, 'organizationId' | 'orgRole'> & {
  membership: Membership | null;
};
```

Every predicate in `server/permissions.ts` keeps its exact signature and reads
`user.membership` instead of `user.organizationId`:

- `sameOrg(a, b)` → both memberships non-null and equal
- `hasOrg(user)` → `user.membership != null`
- `canAccessResource`, `isOwnerOrOrgManager`, `canEditResource`, `canRunWorkflow`,
  `canScheduleWorkflow` → unchanged logic over the new field
- the team-pool composition helper → unchanged logic

The `Omit` is load-bearing, not cosmetic: **it turns all 68 membership reads into
compile errors**, so `tsc` enumerates the work exhaustively instead of a grep that can
miss a site. This is the difference between a refactor that is provably complete and one
that is merely tested.

**Cost:** one extra indexed primary-key lookup per authenticated request, memoized on
`req` so repeated `getCurrentUser` calls in a single request resolve once. It disappears
into the plugin call after extraction, where it is unavoidable anyway.

**Resource-ownership reads are untouched.** `workflow.organizationId` and its 8 siblings
keep their column, their FK, and their direct reads. Only the *user-shaped* reads move.

**Two categories of membership read, not one.** The `Omit` covers the *caller's* own
membership — the authorization path, and the large majority of sites. It does **not**
cover reads of *other* users' affiliation, because `storage.getAllUsers()` and
`getUsersByOrganization()` return raw `User` rows that still carry the columns (the
admin users listing maps over exactly these). Those sites are not compile errors and
must be found by inspection, then routed through `getMemberships(userIds)` for listings
and `listMembers(orgId)` for rosters. This is the one part of the migration the compiler
cannot enumerate, so it is called out here rather than discovered mid-implementation —
and it is why the batch method exists in the interface at all.

## Call-site migration

Mechanical and compiler-driven, in this order:

1. `server/organizations.ts` (interface + set/get) and `server/organizations-core.ts`
   (`CoreOrganizations`).
2. `server/index.ts` — resolve at startup next to `setMarketplace`.
3. `server/auth.ts` — resolve membership in the four auth entry points; export `AuthUser`.
   `requireOrgAdmin` reads `membership.role` instead of `user.orgRole`.
4. `server/permissions.ts` — re-implement the predicates over `membership`; signatures
   unchanged, so their callers are untouched.
5. `server/routes.ts` (56), `routes-api-v1.ts` (4), `dispatch.ts` (1) — fix what `tsc`
   reports. Each site is a mechanical substitution; any site that is *not* mechanical is
   a finding worth calling out in review rather than papering over.
6. `server/storage.ts` — the org-table methods become `CoreOrganizations`'s
   implementation detail. They are not deleted or moved in this cycle; the org CRUD
   routes still call them directly.
7. **By inspection, not by compiler:** the other-users' -affiliation sites described
   above (admin users listing, member rosters) — route them through `getMemberships` /
   `listMembers`.

## What stays exactly where it is

No schema change. No migration. No data movement. No UI change. No API surface change —
every endpoint keeps its path, request shape, response shape and status codes, because
this is a refactor and any behavioral difference is a bug, not a feature.

Specifically unmoved: `org_secrets` and the job-secrets path; `organization_seats`,
Stripe payment methods/history and volume pricing; all 23 org routes; all 6 console
pages; the 9 FK columns. Each of those gets its own seam when it extracts on its own
schedule.

## Enforcement

A seam nobody has ever swapped is a guess. Two mechanisms keep it honest:

1. **A fake provider installed at the resolution boundary.** `FakeOrganizations`
   answers membership from an in-memory map. A test calls `setOrganizations(fake)`, then
   drives the auth layer and an org-gated route for a user whose *Core columns say
   otherwise* — asserting the behavior follows the **fake**, not the columns. That
   asymmetry is the actual proof the seam is load-bearing; a fake that merely agrees
   with the columns would pass even if every call site still read them directly.
   (The predicates themselves stay pure unit tests over `AuthUser` fixtures — by
   design they receive an already-resolved membership and never see a provider.)
2. **A scan test**, in the style of `tests/sensitive-paths.test.ts` (which scans
   `routes.ts` rather than re-listing entries): fail if a **user-shaped** identifier
   (`user`, `currentUser`, `targetUser`, `member`, `actor`, `apiKeyUser`) is read for
   `.organizationId` or `.orgRole` anywhere under `server/` except
   `organizations-core.ts` and `storage.ts`. Scoping the pattern to user-shaped names is
   what keeps it from firing on the legitimate resource-ownership reads
   (`workflow.organizationId`), which are permanent. Cheap, and it stops the boundary
   from eroding the way these refactors usually die — via `storage.getUser()`, which
   still returns the raw columns and would otherwise be an open back door.

## Non-goals

- Moving any table, row or route into a plugin schema.
- Building the front-end plugin extension mechanism (a prerequisite for the org console
  pages to ever live in a plugin, and a platform project in its own right).
- Extracting org billing/seats, or org secrets.
- Changing any permission semantics. Admin is still not a super-editor; `canScheduleWorkflow`
  is still owner-only; secrets still follow workflow ownership.
- Multi-org membership. Today a user belongs to at most one org, and `Membership` encodes
  exactly that. Widening it later is an interface change, and deliberately out of scope.

## Testing

- **Unit:** `CoreOrganizations` against a seeded DB — membership present/absent, all
  three roles, batch `getMemberships`, unknown user, unknown org.
- **Predicates:** pure unit tests over `AuthUser` fixtures with `membership` set —
  every branch of `sameOrg`, `hasOrg`, `isOwnerOrOrgManager`, `canAccessResource`,
  `canRunWorkflow`, `canScheduleWorkflow`, including the no-org and cross-org cases.
- **Seam override:** the `FakeOrganizations` test described under Enforcement, where the
  fake disagrees with the Core columns and the fake must win.
- **Regression:** the existing org integration tests in `tests/api.test.ts` must pass
  **unchanged** — that is the primary evidence that behavior was preserved. Any test that
  needs editing is a signal to re-examine the change, not the test.
- **Boundary:** the scan test above.
- **Gate:** `./scripts/full-tests-run.sh` (unit + audio + E2E) before merge, per the
  repo's pre-merge rule.

## Rollout

One PR, no migration, no deploy ordering constraint, no operator action. Revert is a
plain `git revert` — there is no data state to unwind, which is the main practical
argument for doing the seam as its own cycle rather than folding it into an extraction.

## What extraction looks like afterwards (not this cycle)

Recorded so the seam is judged against its actual purpose:

1. Build front-end plugin extension in the console (platform work; the current blocker).
2. Create `plugins/organizations` providing `vox.organizations` — the interface above,
   backed by tables in `plugin_organizations`.
3. Move org CRUD/member/invite routes and the console pages into the plugin.
4. Drop `users.organization_id` / `users.org_role`; the plugin owns membership.
5. Flip resolution from `?? new CoreOrganizations(storage)` to null-when-absent, and
   delete `CoreOrganizations`.
6. The 9 FK columns on Core tables become plain integers (FK constraints dropped): Core
   keeps storing which org owns a row, and stops being able to resolve what that org is
   without the plugin.

Steps 1–2 are the expensive ones. Steps 3–6 are small **because** of this cycle — which
is the whole point.
