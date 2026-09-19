# organizations — Plugin Spec

## Identity
- id: `organizations`
- version: 1.0.0
- voxPluginApi: ^1.0.0

## Function and non-goals
The sole implementation of the `vox.organizations` seam (`server/organizations.ts`):
org membership, org CRUD, and org secrets (ciphertext only). Core's `routes.ts`
endpoints are the HTTP surface — this plugin ships **no routes of its own**
(`vox.plugin.json`'s `routes` is `[]`); every org-facing request goes through
Core's `getOrganizations()`/`requireOrganizations()` and calls into this plugin
as a service. Non-goals: billing/seats (org seats, Stripe, and their 8 routes
stay entirely in Core — unchanged by this plugin); multi-org membership
(`memberships_user_uq`, a `UNIQUE (user_ref)` constraint, is where the
at-most-one-org invariant physically lives — the plugin enforces it, Core no
longer does); org deletion (no such route exists anywhere in Core today, and
`organization_seats.organization_id` dropping its FK removed the org-FK tree's
only `ON DELETE CASCADE` — so org deletion, if ever built, must clean up the
Core seat row explicitly; there is no cascade left to do it automatically).

## Services provided and consumed
- Provides: `vox.organizations@1.0.0` — 16 methods:
  - Reads: `getMembership`, `getMemberships`, `getOrganization`, `listMembers`,
    `countMembers`, `countOrgAdmins`, `listOrganizations`.
  - Org/membership mutations: `createOrganization`, `updateOrganization`,
    `setVerified`, `addMember`, `setMemberRole`, `removeMember`.
  - Org secrets (ciphertext only): `listOrgSecrets`, `upsertOrgSecret`,
    `deleteOrgSecret`.
- Consumes: none. Organizations depends on no other plugin and functions fully
  alone (`requiresServices: {}`, `optionalServices: {}`).

## HTTP and WebSocket URLs
None. All org HTTP endpoints live in Core's `server/routes.ts`, calling through
the seam — this plugin mounts nothing on `HttpHost`.

## Web UI contributions
None (backend-only; the seam is the only integration point).

## Dependencies and minimum versions
None.

## Environment variables
None.

## Database configuration
- Schema: `plugin_organizations`
- Tables: `organizations`, `memberships`, `org_secrets`
- `organizations`/`memberships`/`org_secrets` date columns are naive `timestamp`
  (no time zone) — deliberately matching Core's exact column types
  (`migrations/0006_org_roles_resources.sql`) so the 0002 copy migration's
  `INSERT ... SELECT` from `public.*` is a plain same-type copy, not an
  implicit `timestamp -> timestamptz` cast whose result would depend on the
  copying session's `TimeZone` GUC.

## Data ownership
Owns all `plugin_organizations` tables. `memberships.user_ref` references Core's
`users.id` as an opaque integer, not a foreign key — user lifecycle stays Core's
responsibility, and the plugin does not enforce referential integrity across
the schema boundary. `org_secrets.encrypted_value` is ciphertext-only: the
plugin never encrypts, decrypts, or sees plaintext, and the AES-256-GCM key
never enters the plugin — `encryptValue`/`decryptValue` and the key stay in
Core (`shared/credentials.ts`).

## Permissions
Authorization stays in Core: `requireOrgAdmin` and the permission predicates in
`server/permissions.ts` decide; this plugin only executes. `AlreadyMemberError`
is the one typed signal the plugin raises for Core to map onto its existing
400s (creator/target already belongs to an org).

## Workers
None.

## Enablement and disabled behavior
Enabled via `VOX_PLUGINS=organizations` (typically alongside `credits` and
`shared-agents`). When absent, `getOrganizations()` returns `null` and Core's
own Phase-1 absence semantics take over (org routes 501, scheduler skips,
sweeps exclude the team arm, zero persistent writes) — this plugin's tables are
untouched either way; nothing here degrades or rots on disable (forward-only,
same policy as `credits`).

## Migrations and upgrades
- `migrations/0001_init.sql` — creates the three tables: `organizations`;
  `memberships` (`memberships_user_uq` UNIQUE on `user_ref` — the at-most-one-org
  invariant); `org_secrets` (`org_secrets_org_name_uq` UNIQUE on
  `(org_ref, name)`). Forward-only, checksum-frozen.
- `migrations/0002_copy_from_core.sql` — one-shot data move from Core's
  `public.organizations`/`public.users`/`public.org_secrets` into this plugin's
  schema, ids preserved verbatim. Behavior:
  - **Fresh install**: `to_regclass('public.organizations') IS NULL` → `NOTICE`
    and return — nothing to copy, not an error.
  - **Refuse re-copy**: if the plugin's `organizations` table is already
    populated, `RAISE EXCEPTION` rather than duplicate or silently no-op.
  - **Three named preflights**, each checked before any plugin-side row is
    written (so a bad Core row surfaces as a named, actionable error instead of
    a bare constraint/FK violation deep inside an `INSERT`):
    1. Duplicate `(organization_id, name)` rows in Core's `org_secrets` — Core
       only has a plain index there, the plugin has a unique constraint.
    2. `users.organization_id` values with no matching `public.organizations`
       row (dangling reference).
    3. `org_secrets.organization_id` values with no matching
       `public.organizations` row (same class, different table).
  - **Parity assertions** after the copy: row counts and `max(id)` must match
    on both sides for all three tables, plus a value-level `EXCEPT` diff on
    memberships (catches a user who moved orgs or changed role between the
    `INSERT` and the check — a count match alone can't see that). Any
    assertion failure `RAISE EXCEPTION`s, aborting the migration transaction —
    `loadPlugins` throws and the app refuses to start. This is the fail-closed
    contract: partial or incorrect data must never become this plugin's source
    of truth.
  - **Ids and sequences copied verbatim**: `organizations.id` and
    `org_secrets.id` keep their Core values, then `setval` bumps the sequences
    past `max(id)` — nine Core tables reference these ids as opaque integers
    and must keep resolving after the copy.

## Health and operations
`GET /api/plugins/organizations/health` (generic `HealthHost` route, not
plugin-specific code): reports the plugin's manifest metadata (version,
provided/required services) and DB reachability. No plugin-specific health
logic — there are no workers or invariants to check beyond the DB responding.

## Security and data retention
Org secrets are retained as ciphertext indefinitely; the plugin has no way to
decrypt them, so a compromised plugin process alone cannot leak plaintext.
Membership and org rows are retained forward-only — no org deletion route
exists anywhere in Core today (see Non-goals).

## Failure modes
DB unavailable → provider methods throw. Core's `server/organizations.ts`
treats a thrown error as provider **failure**, distinct from **absence**
(`null`): failure surfaces as `503 "Organizations service unavailable"` on
paths that must give an answer, while absence 501s. Copy-migration failure at
startup → the app refuses to start (fail-closed); the old release keeps
serving until the underlying data problem is fixed (see the Release A runbook
in the root `CLAUDE.md`).

## Drain procedure
No in-flight external work — no workers, no long-lived connections beyond
pooled queries. Drain is a no-op, same as `credits`.
