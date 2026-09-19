# Organizations Plugin — Phase 2 (Release A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `plugins/organizations` (schema, provider, copy migration with fail-closed
assertions) and cut Release A: drop the 10 Core org FKs, re-point the last storage-direct
org readers through the seam, flip resolution to plugin-or-absent, delete `CoreOrganizations`.

**Architecture:** The plugin owns org data in `plugin_organizations` and provides
`vox.organizations@1.0.0`; Core keeps every public HTTP path as the Phase-1 seam adapters.
`server/index.ts:194` already resolves the service — Release A deletes its
`?? new CoreOrganizations(storage)` fallback so absence is real. Data crosses once, in a
checksummed plugin migration that copies from `public` with verbatim ids and refuses to start
the app on any mismatch.

**Tech Stack:** `@vox/plugin-sdk` (PluginDb/raw SQL — plugins cannot use drizzle or import
Core), Express (Core adapters unchanged), vitest + per-worker plugin-schema harness.

**Spec:** `designs/2026-09-16-organizations-plugin-extraction-design.md` (rev 2) — §3
(ownership), §4 (interface + error contract), §5 (write order + seats CASCADE note), §6
(Release A contents), §10 (three-layer verification), §14 (runbook). This plan implements
**Phase 2 = Release A only**; Release B (the drops) is a separate later branch after
production soak (§6, §12).

## Global Constraints

- **Plugin import boundary:** files under `plugins/organizations/server/**` import ONLY
  `@vox/plugin-sdk` (`eslint.config.js:44-60` enforces). The provider interface, `Membership`,
  `Organization`, `OrgSecretRow`, `OrgRole`, `AlreadyMemberError` are duck-typed LOCALLY in
  the plugin (shared-agents' `CreditsPort` precedent, `plugins/shared-agents/server/service.ts:5-34`).
  Structural drift vs `server/organizations.ts` is caught by the mirror-drift test (Task 1),
  never by tsc — keep the two declaration-identical.
- **Ciphertext only:** the plugin never sees plaintext or the encryption key
  (`server/organizations.ts:99-101`). Core encrypts/decrypts; the plugin stores/returns
  `encrypted_value` opaquely.
- **Providers throw on failure; never a membership-shaped null for "unavailable"**
  (`server/organizations.ts:83-84`). No catch-and-return-null anywhere in the provider.
- **Authorization stays in Core** — the provider executes, never decides.
- **Byte-identical responses:** zero route-shape changes. All Phase-1 adapters keep working
  against the plugin provider unchanged; `tests/api.test.ts` assertions untouched (plumbing
  additions allowed under Phase-1 Ruling J: new tests OK, existing assertions immutable).
- **Ids survive verbatim** in the copy (nine Core tables reference them as opaque integers).
- **Core migration conventions:** hand-written SQL (db:generate is inoperative — CLAUDE.md),
  plain statements, registered in `MIGRATIONS` in `server/migrate.ts`, one file `0037_*.sql`,
  version 38. **Plugin migration conventions:** `NNNN_name.sql` in
  `plugins/organizations/migrations/`, split on `--> statement-breakpoint` (never on `;` — DO
  blocks are safe), checksummed-immutable once committed (`server/plugins/migrate.ts:56-61`),
  transaction-per-file with `search_path "<schema>", public`, throw ⇒ app refuses to start.
- **Never `git stash`** (pre-existing stash stack). Commits end
  `🤖 Built with SMT <smt@agora.build>`.
- Env for every test run: `set -a; source .env; set +a; export DATABASE_URL=postgresql://vox:vox123@localhost:5432/vox`.
  Plugin-DB tests additionally use `TEST_PLUGIN_DATABASE_URL` (defaults to
  `postgresql://vox:vox123@localhost:5432/vox_plugin_test`, auto-created by
  `tests/helpers/plugin-test-db.ts`).
- Integration suites hit the ALREADY-RUNNING dev server: after server/ or plugin changes,
  `./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start`. From Task 7 on, the
  dev server MUST run with `VOX_PLUGINS=credits,shared-agents,organizations`.
- Known pre-existing failures (do not chase): api.test.ts my-evals `limit`; `:8099`
  daemon-health ×3 when the daemon is down; `dispatch-integration` shared-DB pollution
  (passes in isolation, #134). DB-cap cleanup before full runs:
  `DELETE FROM workflows WHERE owner_id=1; DELETE FROM projects WHERE owner_id=1; DELETE FROM secrets WHERE user_id=1;`
- **STOP at the end:** no push, no PR, no merge — Release A DEPLOYMENT (snapshot,
  `VOX_PLUGINS` change, Coolify) is the user's action, documented in Task 8, never executed
  by this plan.

## File Structure

```
plugins/organizations/
  vox.plugin.json                 # manifest (Task 1)
  SPEC.md                         # function, services, schema, CASCADE note (Task 8)
  migrations/
    0001_init.sql                 # organizations, memberships, org_secrets (Task 1)
    0002_copy_from_core.sql       # guarded copy + assertions + setval (Task 4)
  server/
    index.ts                      # activate(): provideService + health (Task 1)
    types.ts                      # duck-typed provider contract (Task 1)
    provider.ts                   # OrganizationsPluginProvider (Tasks 2–3)
  tests/
    provider-contract.test.ts     # ported Core corpus + new cases (Tasks 2–3)
    copy-migration.test.ts        # 0002 guard + assertion behavior (Task 4)
tests/helpers/organizations-db.ts # per-worker harness (Task 2)
tests/organizations-mirror.test.ts# mirror-drift + registry resolution (Task 1)
migrations/0037_release_a_drop_org_fks.sql          (Task 6)
```
Modified: `plugins/index.ts` (T1), `server/auth-session.ts` + `server/routes.ts` fence tail +
`server/storage.ts` (T5), `shared/schema.ts` + `server/migrate.ts` (T6), `server/index.ts` +
delete `server/organizations-core.ts` + delete `tests/organizations-core.test.ts` (T7),
`scripts/dev-local-run.sh` + `docker-compose.yml` + `CLAUDE.md` (T7/T8),
`tests/organizations-boundary.test.ts` (T5, T7).

---

### Task 1: Plugin skeleton — manifest, schema migration, activate, mirror-drift test

**Files:**
- Create: `plugins/organizations/vox.plugin.json`, `plugins/organizations/migrations/0001_init.sql`,
  `plugins/organizations/server/types.ts`, `plugins/organizations/server/index.ts`,
  `tests/organizations-mirror.test.ts`
- Modify: `plugins/index.ts`

**Interfaces:**
- Produces: `organizationsPlugin: VoxPlugin` registered as `organizations` in
  `BUILTIN_PLUGINS`; `plugins/organizations/server/types.ts` exporting `OrgRole`,
  `Membership`, `Organization`, `OrgSecretRow`, `OrganizationsProvider`,
  `AlreadyMemberError` — declaration-identical to `server/organizations.ts:39-111`.
- Consumes: `@vox/plugin-sdk` only.

- [ ] **Step 1: Manifest** — exactly:

```json
{
  "id": "organizations",
  "version": "1.0.0",
  "voxPluginApi": "^1.0.0",
  "providesServices": { "vox.organizations": "1.0.0" },
  "requiresServices": {},
  "optionalServices": {},
  "migrations": "migrations",
  "routes": []
}
```

- [ ] **Step 2: `0001_init.sql`** (schema-relative names; NO cross-schema FKs — user ids and
  legacy ids are opaque integers, matching the credits precedent):

```sql
CREATE TABLE organizations (
  id         integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  address    text,
  verified   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE memberships (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_ref    integer NOT NULL REFERENCES organizations(id),
  user_ref   integer NOT NULL,
  role       text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_user_uq UNIQUE (user_ref)
);
--> statement-breakpoint
CREATE INDEX memberships_org_idx ON memberships (org_ref);
--> statement-breakpoint
CREATE TABLE org_secrets (
  id              integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_ref         integer NOT NULL REFERENCES organizations(id),
  name            text NOT NULL,
  encrypted_value text NOT NULL,
  broker_type     text,
  is_test_account boolean NOT NULL DEFAULT false,
  created_by      integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_secrets_org_name_uq UNIQUE (org_ref, name)
);
```

`GENERATED BY DEFAULT` (not `ALWAYS`) on `organizations.id` and `org_secrets.id` is
deliberate: the copy migration inserts explicit ids. `UNIQUE (user_ref)` is the §4
at-most-one-org invariant in its new home. `role` is text+CHECK, not an enum — the Core
`org_role` enum belongs to `public` and dies in Release B.

- [ ] **Step 3: `types.ts`** — copy the contract block from `server/organizations.ts`
  verbatim (types `OrgRole`, `Membership`, `Organization`, `OrgSecretRow`, class
  `AlreadyMemberError extends Error` with the same message text, interface
  `OrganizationsProvider` — all 16 methods, same names/signatures/order), with a header
  comment: `// Duck-typed mirror of server/organizations.ts — plugins import only
  @vox/plugin-sdk. tests/organizations-mirror.test.ts fails the build on drift.`

- [ ] **Step 4: `server/index.ts` (plugin)**:

```ts
import type { VoxPlugin, VoxPluginContext } from "@vox/plugin-sdk";
import { createOrganizationsProvider } from "./provider";

const plugin: VoxPlugin = {
  async activate(ctx: VoxPluginContext): Promise<void> {
    const provider = createOrganizationsProvider(ctx.db);
    ctx.health(async () => {
      try {
        await ctx.db.query("SELECT 1");
      } catch (err) {
        return { status: "down", detail: String(err) };
      }
      const orphans = await ctx.db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM memberships m WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = m.org_ref)",
      );
      if (orphans.rows[0].n !== "0") return { status: "degraded", detail: `${orphans.rows[0].n} orphaned memberships` };
      return { status: "ok" };
    });
    ctx.provideService("vox.organizations", "1.0.0", provider);
  },
};
export default plugin;
```

For this task only, `provider.ts` exports a `createOrganizationsProvider(db)` whose 16
methods all `throw new Error("not implemented")` — Tasks 2–3 fill them in test-first.

- [ ] **Step 5: register** — `plugins/index.ts`: add
  `import organizationsPlugin from "./organizations/server/index";` and
  `organizations: organizationsPlugin,` to `BUILTIN_PLUGINS`.

- [ ] **Step 6: mirror-drift test** — `tests/organizations-mirror.test.ts` (Core-side test,
  free to import both worlds):

```ts
import { describe, it, expect } from "vitest";
import type { OrganizationsProvider as CoreContract } from "../server/organizations";
import type { OrganizationsProvider as PluginContract } from "../plugins/organizations/server/types";
import { AlreadyMemberError as PluginAME } from "../plugins/organizations/server/types";
import { AlreadyMemberError as CoreAME } from "../server/organizations";

describe("plugin contract mirrors the Core seam", () => {
  it("plugin provider is assignable to the Core contract and back", () => {
    // Compile-time drift check in both directions — a missing/renamed/retyped method
    // fails `npm run check`, which is the point.
    const _toCore: CoreContract = null as unknown as PluginContract;
    const _toPlugin: PluginContract = null as unknown as CoreContract;
    void _toCore; void _toPlugin;
    expect(true).toBe(true);
  });
  it("AlreadyMemberError shape matches (name + message contract)", () => {
    expect(new PluginAME().name).toBe(new CoreAME().name);
    expect(new PluginAME().message).toBe(new CoreAME().message);
  });
});
```

Also in this file: a registry-resolution test in the `tests/marketplace-seam.test.ts:34-40`
style — build a `ServiceRegistry`, `provide("vox.organizations","1.0.0", stub)`, assert
`makeServicesView(...).optional<OrganizationsProvider>("vox.organizations","^1.0.0")` returns
it (read marketplace-seam.test.ts first and mirror its imports exactly).

- [ ] **Step 7: loader e2e smoke** (same file): the `tests/plugin-sample-e2e.test.ts:21-35`
  pattern — `process.env.VOX_PLUGINS = "organizations"`, `loadPlugins(app, pool, BUILTIN_PLUGINS)`
  against the plugin test DB pool, assert `services.optional("vox.organizations","^1.0.0")`
  is non-null and `GET /api/plugins/organizations/health` returns ok — this proves manifest,
  0001 migration, and activation all load fail-closed-clean. Restore env in teardown.
  NOTE: with the not-implemented provider this still passes (health only queries tables).
- [ ] **Step 8:** `npm run check` clean; `npx vitest run tests/organizations-mirror.test.ts`
  green; `npx eslint plugins/organizations` → 0 errors (proves the import boundary holds).
- [ ] **Step 9: Commit** — `feat(orgs-plugin): skeleton — manifest, plugin_organizations schema, service registration, mirror-drift lock`

### Task 2: Provider reads + per-worker test harness

**Files:**
- Create: `tests/helpers/organizations-db.ts`, `plugins/organizations/tests/provider-contract.test.ts`
- Modify: `plugins/organizations/server/provider.ts`

**Interfaces:**
- Consumes: `PluginDb` (`query`, `withTransaction`, `schema`) from the SDK; harness pattern
  from `tests/helpers/credits-db.ts` (read it first, copy its shape).
- Produces: `setupOrganizationsDb(): Promise<OrgsHarness>` where
  `OrgsHarness = { pool: Pool; db: PluginDb; provider: OrganizationsProvider; schema: string }`;
  provider reads implemented: `getMembership`, `getMemberships`, `getOrganization`,
  `listMembers`, `countMembers`, `countOrgAdmins`, `listOrganizations`.

- [ ] **Step 1: harness** — `tests/helpers/organizations-db.ts`, verbatim adaptation of
  `credits-db.ts`: per-worker schema
  `plugin_organizations_${process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? process.pid}`,
  `ensurePluginTestDatabase()`, DROP/CREATE schema, replay
  `plugins/organizations/migrations/*.sql` under
  `SET LOCAL search_path TO "<schema>", public` splitting on `--> statement-breakpoint`,
  then `createPluginDb(pool, schema)` + `createOrganizationsProvider(db)`. (When Task 4 adds
  0002, its `to_regclass` guard makes it a no-op here — the harness DB has no Core tables;
  that no-op IS a test, see Task 4.)
- [ ] **Step 2: failing tests first.** Port the READ cases from
  `tests/organizations-core.test.ts` (open it; every `describe` covering getMembership /
  getMemberships / getOrganization / listMembers / counts / listOrganizations moves over with
  storage-seeding swapped for direct SQL seeding through `harness.db.query`). Semantics that
  MUST carry over exactly: unknown user → `getMembership` returns `null`; `getMemberships`
  returns a `Map` containing only found users; `getOrganization` unknown id → `null`;
  `listMembers` returns `{userId, role}` with role values `owner|admin|member`;
  `listOrganizations` ordered by `created_at DESC, id DESC` (match whatever
  `CoreOrganizations.listOrganizations` does — READ it and replicate its ordering exactly;
  the admin console list order is user-visible).
- [ ] **Step 3:** run → all red (not-implemented). Implement the seven reads in
  `provider.ts` as plain SQL over `organizations`/`memberships` (schema-relative names;
  never qualify with `public`). `getMemberships` is ONE query
  (`WHERE user_ref = ANY($1)`), preserving Phase 1's N+1 fix.
- [ ] **Step 4:** `npx vitest run plugins/organizations/tests/provider-contract.test.ts`
  green; `npm run check`; `npx eslint plugins/organizations` clean.
- [ ] **Step 5: Commit** — `feat(orgs-plugin): provider reads over plugin tables — contract corpus ported, one-query getMemberships`

### Task 3: Provider mutations + org secrets — the full contract, equivalence-complete

**Files:**
- Modify: `plugins/organizations/server/provider.ts`, `plugins/organizations/tests/provider-contract.test.ts`

**Interfaces:**
- Produces: the remaining 9 methods: `createOrganization`, `updateOrganization`,
  `setVerified`, `addMember`, `setMemberRole`, `removeMember`, `listOrgSecrets`,
  `upsertOrgSecret`, `deleteOrgSecret`. Behavior contract = `CoreOrganizations`
  (`server/organizations-core.ts`) — read it method-by-method before writing tests.

- [ ] **Step 1: failing tests** — port ALL remaining cases from
  `tests/organizations-core.test.ts` plus these (each was load-bearing in Phase 1 reviews):
  - `createOrganization` creates org + owner membership ATOMICALLY
    (`ctx.db.withTransaction` — §4; this is an upgrade over Core's sequential writes, note it
    in a comment) and throws `AlreadyMemberError` if the creator belongs to any org.
  - `addMember` throws `AlreadyMemberError` when the user has ANY membership
    (the `UNIQUE (user_ref)` violation maps to the typed error — catch pg code `23505` on
    constraint `memberships_user_uq`, rethrow as `AlreadyMemberError`; any other error
    rethrows untouched).
  - `updateOrganization` unknown id throws `Error("organization not found")` — EXACT message
    (Phase-1 adapters string-match it; deferred-minor from T8 review, not fixed, so the
    string is load-bearing).
  - `setMemberRole` / `removeMember` on unknown userId are silent no-ops (Phase-1 T2 carry:
    the adapters' 404 guards sit in Core, AHEAD of these calls).
  - `upsertOrgSecret`: unconditional write; INSERT sets `created_by` from input, UPDATE (on
    `(org_ref, name)` conflict) preserves the ORIGINAL `created_by` and overwrites
    `encrypted_value`, `broker_type`, `is_test_account`, `updated_at` — this is what
    `storage.upsertOrgSecretRow` does today (read it at `server/storage.ts:~2750-2775`) and
    the route's isTestAccount compensation (Phase-1 T9) depends on it. Returns the stored row
    mapped to `OrgSecretRow` (camelCase keys, `organizationId` = `org_ref`).
  - `listOrgSecrets` ordered `created_at DESC` (match `storage.getOrgSecrets` ordering,
    `server/storage.ts:2699-2701`); ciphertext round-trips VERBATIM (assert byte equality on
    a fixture string — no encoding surprises).
  - `deleteOrgSecret(orgId, name)` deletes exactly the `(org_ref, name)` row; no-op when absent.
- [ ] **Step 2:** red → implement → green. Use single-statement SQL where possible
  (`INSERT ... ON CONFLICT (org_ref, name) DO UPDATE SET ... RETURNING *` for the upsert —
  with `created_by` NOT in the SET list, which implements preserve-original for free).
- [ ] **Step 3: provider-disagreement case** (design §10 layer 2): port the
  `tests/organizations-override.test.ts` FakeOrganizations widening test's INTENT — register
  the plugin provider through a real `ServiceRegistry` and assert a seeded membership
  resolves through `optional<>()` exactly as through the provider directly.
- [ ] **Step 4:** full plugin suite green; `npm run check`; eslint clean.
- [ ] **Step 5: Commit** — `feat(orgs-plugin): full provider — transactional create, typed AlreadyMemberError, createdBy-preserving ciphertext upsert`

### Task 4: The copy migration — guarded, asserted, fail-closed

**Files:**
- Create: `plugins/organizations/migrations/0002_copy_from_core.sql`,
  `plugins/organizations/tests/copy-migration.test.ts`

**Interfaces:**
- Consumes: `public.organizations`, `public.org_secrets`, `public.users`
  (`organization_id`, `org_role`) — readable because plugin migrations run with
  `search_path "<schema>", public` (`server/plugins/migrate.ts:78`).
- Produces: data parity with verbatim ids, or no app start.

- [ ] **Step 1: the migration** — one DO block per concern (no `--> statement-breakpoint`
  inside a DO block; separate blocks WITH breakpoints between them):

```sql
DO $$
BEGIN
  -- Fresh install / post-Release-B enable: Core tables absent or empty ⇒ nothing to copy.
  IF to_regclass('public.organizations') IS NULL THEN
    RAISE NOTICE 'organizations copy: no public.organizations — fresh install, skipping';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM organizations) THEN
    RAISE EXCEPTION 'organizations copy: plugin tables already populated — refusing to re-copy';
  END IF;

  INSERT INTO organizations (id, name, address, verified, created_at, updated_at)
    SELECT id, name, address, verified, created_at, updated_at FROM public.organizations;

  INSERT INTO memberships (org_ref, user_ref, role)
    SELECT u.organization_id, u.id, COALESCE(u.org_role::text, 'member')
    FROM public.users u WHERE u.organization_id IS NOT NULL;

  INSERT INTO org_secrets (id, org_ref, name, encrypted_value, broker_type,
                           is_test_account, created_by, created_at, updated_at)
    SELECT id, organization_id, name, encrypted_value, broker_type,
           is_test_account, created_by, created_at, updated_at
    FROM public.org_secrets;

  -- Assertions: counts and max(id) equal on both sides, or the app refuses to start (§6).
  IF (SELECT count(*) FROM organizations) IS DISTINCT FROM (SELECT count(*) FROM public.organizations)
     OR (SELECT coalesce(max(id),0) FROM organizations) IS DISTINCT FROM (SELECT coalesce(max(id),0) FROM public.organizations) THEN
    RAISE EXCEPTION 'organizations copy: organizations parity check failed';
  END IF;
  IF (SELECT count(*) FROM memberships) IS DISTINCT FROM
     (SELECT count(*) FROM public.users WHERE organization_id IS NOT NULL) THEN
    RAISE EXCEPTION 'organizations copy: memberships parity check failed';
  END IF;
  IF (SELECT count(*) FROM org_secrets) IS DISTINCT FROM (SELECT count(*) FROM public.org_secrets)
     OR (SELECT coalesce(max(id),0) FROM org_secrets) IS DISTINCT FROM (SELECT coalesce(max(id),0) FROM public.org_secrets) THEN
    RAISE EXCEPTION 'organizations copy: org_secrets parity check failed';
  END IF;

  PERFORM setval(pg_get_serial_sequence('organizations','id'),
                 (SELECT coalesce(max(id),0)+1 FROM organizations), false);
  PERFORM setval(pg_get_serial_sequence('org_secrets','id'),
                 (SELECT coalesce(max(id),0)+1 FROM org_secrets), false);
END $$;
```

Verify column names against `shared/schema.ts` (`organizations` table ~line 141 region,
`orgSecrets` ~line 505 region) before writing — the SELECT lists must match the REAL Core
columns, and `org_role` casts enum→text.

- [ ] **Step 2: tests** — `copy-migration.test.ts`. ISOLATION RULE: this test creates fake
  `public.organizations`/`public.users`/`public.org_secrets` tables, and `public` is shared
  across vitest workers — so it must NOT use the shared `vox_plugin_test` DB (a parallel
  provider-contract worker replaying 0002 would find the fakes and copy them). Use a
  DEDICATED database: `postgresql://vox:vox123@localhost:5432/vox_plugin_copy_test`, created
  idempotently the same way `ensurePluginTestDatabase` does (copy that helper's
  CREATE-DATABASE/42P04 pattern into this test file or a small local helper — do not modify
  the shared helper's default). Cases: (a) fresh DB, replay 0001+0002 → succeeds, plugin
  tables empty (fresh-install guard); (b) CREATE minimal fake Core tables in `public`
  (only the columns 0002 SELECTs), seed 2 orgs / 3 members (one with NULL org_role) /
  2 secrets with gappy ids (1 and 7), replay into a fresh schema → ids verbatim, NULL role
  → 'member', `nextval` on the orgs sequence = 8, ciphertext byte-identical; (c) re-running
  0002 against the populated schema raises "refusing to re-copy"; (d) tamper (delete one
  plugin-side org), re-run 0002 alone → parity exception. afterAll drops the fake public
  tables; the whole DB is throwaway and never the dev DB.
- [ ] **Step 3:** suite green; `npm run check`.
- [ ] **Step 4: Commit** — `feat(orgs-plugin): copy migration — verbatim ids, parity assertions fail startup, fresh-install and re-copy guards`

### Task 5: Re-point the last storage-direct org readers through the seam

**Files:**
- Modify: `server/auth-session.ts` (`:112`, `:122`, `:340` — `storage.getOrgSecrets`),
  `server/routes.ts` (`orgRuntimeSecretsForJob`, ~`:341-360`), `server/storage.ts`
  (delete `getDecryptedOrgRuntimeSecrets`; `getOrgSecrets` stays ONLY if
  `CoreOrganizations` still calls it — check), `tests/organizations-boundary.test.ts`
  (Ruling-H pin), `tests/org-secret-fence.test.ts` (plumbing only)

**Interfaces:**
- Consumes: `getOrganizations()` + `listOrgSecrets(orgId)` (ciphertext rows);
  `decryptValue` — find the exact Core decrypt helper `getDecryptedOrgRuntimeSecrets`
  uses today (read `server/storage.ts:~2783-2800`) and reuse it in the new location.
- Produces: ZERO Core reads of org-secret DATA outside the provider path. After this task,
  `grep -rn "storage.getOrgSecrets\|getDecryptedOrgRuntimeSecrets" server/` returns only
  provider-serving/marked lines in storage.ts (or nothing).

- [ ] **Step 1: failing test update** — the Ruling-H boundary pin currently asserts
  `getDecryptedOrgRuntimeSecrets` has exactly one call site; it will be retargeted to pin the
  NEW helper (Step 2's `decryptOrgRuntimeRows` or equivalent). Write the updated pin first,
  watch it fail.
- [ ] **Step 2: the fence tail** — `orgRuntimeSecretsForJob` (routes.ts) currently:
  scope → seam `getMembership(scope.createdBy)` → compare →
  `storage.getDecryptedOrgRuntimeSecrets(orgId)`. Re-point the tail: on verdict-pass,
  `const orgs = getOrganizations(); if (!orgs) return {};` (absence ⇒ `{}` — matches the
  §7 fail-closed fence semantics already tested) then
  `const rows = await orgs.listOrgSecrets(orgId)` and apply IN CORE the exact same filter +
  decrypt the deleted storage method had: **brokered rows excluded**
  (`brokerType == null` only), decrypt `encryptedValue`, return the same
  `Record<string, string>` shape. Keep the eleven-row truth table green:
  `npx vitest run tests/org-secret-fence.test.ts` with plumbing-only edits (the suite seeds
  through the seam already; assertions untouched).
- [ ] **Step 3: auth-session** — replace the three `storage.getOrgSecrets(scope.organizationId)`
  sites with a small local helper:

```ts
async function orgSecretRowsViaSeam(organizationId: number) {
  const orgs = getOrganizations();
  if (!orgs) throw new Error("Organizations service unavailable for org-scoped session");
  return orgs.listOrgSecrets(organizationId);
}
```

READ each of the three call sites in full first: they consume the same row fields
(`name`, `encryptedValue`, `brokerType`, `isTestAccount`) — map `OrgSecretRow` camelCase to
whatever field names the call sites use today so downstream logic is untouched. The throw
(never a silent `[]`) is deliberate: an org-scoped mint with no provider is a real failure
that must surface in `webSessions.lastError`, not a credential-less browse. Under Phase-1
absence guards no org job should reach mint; this is the §4 failure-is-loud backstop.
- [ ] **Step 4: sweep** — `grep -rn "from(orgSecrets)\|from(organizations)" server/*.ts`:
  every remaining hit must be inside a provider-serving method that `CoreOrganizations`
  still calls (they die with it in Task 7 or in Release B). Delete
  `getDecryptedOrgRuntimeSecrets` from storage.ts now (its logic moved to Core routes);
  keep the boundary markers count in sync (`EXPECTED_MARKERS` may change — adjust the pin
  and say why in the report).
- [ ] **Step 5:** restart dev server; `npx vitest run tests/org-secret-fence.test.ts
  tests/organizations-boundary.test.ts tests/api.test.ts` — known failures only;
  `npx vitest run tests/session-dispatch.test.ts` unedited.
- [ ] **Step 6: Commit** — `refactor(orgs): last storage-direct org-secret readers go through the seam — mint throws loud, fence decrypts in Core`

### Task 6: Release A Core migration — drop the 10 FKs

**Files:**
- Create: `migrations/0037_release_a_drop_org_fks.sql`
- Modify: `shared/schema.ts` (10 `.references()` removals), `server/migrate.ts` (version 38)

**Interfaces:**
- Produces: org id columns as plain integers on Core tables; `organizations` and
  `org_secrets` tables REMAIN in schema.ts (Release B removes them).

- [ ] **Step 1: migration** — constraint names verified against the live DB (2026-09-18):

```sql
ALTER TABLE users             DROP CONSTRAINT users_organization_id_organizations_id_fk;
ALTER TABLE projects          DROP CONSTRAINT projects_organization_id_organizations_id_fk;
ALTER TABLE workflows         DROP CONSTRAINT workflows_organization_id_organizations_id_fk;
ALTER TABLE eval_sets         DROP CONSTRAINT eval_sets_organization_id_organizations_id_fk;
ALTER TABLE eval_schedules    DROP CONSTRAINT eval_schedules_organization_id_organizations_id_fk;
ALTER TABLE payment_methods   DROP CONSTRAINT payment_methods_organization_id_organizations_id_fk;
ALTER TABLE payment_histories DROP CONSTRAINT payment_histories_organization_id_organizations_id_fk;
ALTER TABLE invite_tokens     DROP CONSTRAINT invite_tokens_organization_id_organizations_id_fk;
ALTER TABLE web_sessions      DROP CONSTRAINT web_sessions_organization_id_organizations_id_fk;
ALTER TABLE organization_seats DROP CONSTRAINT organization_seats_organization_id_organizations_id_fk;
```

`org_secrets_organization_id_organizations_id_fk` is deliberately NOT here — it travels with
its table in Release B (§6). The `organization_seats` drop removes the tree's only
`ON DELETE CASCADE` (§5) — one line in the plugin SPEC records that org deletion (if ever
built) must clean seat rows explicitly.
- [ ] **Step 2:** schema.ts — on the ten listed tables' `organizationId` columns, drop
  `.references(() => organizations.id, ...)` leaving `integer("organization_id")` (+
  `.notNull()` where it exists today: `org_secrets` keeps its references — untouched;
  `organization_seats` keeps `.notNull()`). Register
  `{ version: 38, file: "0037_release_a_drop_org_fks.sql" }`-shaped entry in `MIGRATIONS`
  (copy the array's real entry shape).
- [ ] **Step 3:** restart dev server (migration applies), verify:
  `docker exec <pg> psql -U vox -d vox -tA -c "SELECT count(*) FROM pg_constraint WHERE confrelid = 'organizations'::regclass"` → `1` (org_secrets' only).
- [ ] **Step 4:** `npm run check`; `npx vitest run tests/api.test.ts` — known failures only
  (nothing behavioral changed; FKs were never load-bearing for reads).
- [ ] **Step 5: Commit** — `feat(orgs): Release A migration — 10 org FKs dropped, ids are opaque integers on Core tables`

### Task 7: The flip — plugin-or-absent, CoreOrganizations deleted, dev runs the plugin

**Files:**
- Modify: `server/index.ts:194-197`, `scripts/dev-local-run.sh`, `docker-compose.yml:36`
- Delete: `server/organizations-core.ts`, `tests/organizations-core.test.ts`
- Modify: `tests/organizations-boundary.test.ts` (marker pin — CoreOrganizations' serving
  methods in storage.ts are now dead: mark-count changes ONLY if you delete methods; do NOT
  delete storage methods in this task — Release B owns that; the pin stays 7 unless Task 5
  already moved it), any test that imports `CoreOrganizations`
  (`grep -rln CoreOrganizations tests/`) — those tests re-point to the plugin harness or die
  with rationale in the report.

**Interfaces:**
- Produces: `setOrganizations(plugins.services.optional<OrganizationsProvider>("vox.organizations", "^1.0.0") ?? null)`
  — absent plugin ⇒ genuine absence (§7 semantics, already fully tested in Phase 1).

- [ ] **Step 1:** `server/index.ts` — delete the `?? new CoreOrganizations(storage)` arm and
  the `CoreOrganizations`/`storage` imports it used. `setOrganizations` accepts
  `OrganizationsProvider | null` (verify `server/organizations.ts`'s setter signature —
  Phase 1 made the holder nullable; if the setter still requires non-null, widen it here).
- [ ] **Step 2:** delete `server/organizations-core.ts` and `tests/organizations-core.test.ts`
  (superseded by `plugins/organizations/tests/provider-contract.test.ts` — same corpus,
  Task 2/3). `grep -rn CoreOrganizations server/ tests/ client/` must return ZERO after this
  step (design §6: leaving it alive past cutover is an authorization regression).
- [ ] **Step 3: dev defaults** — `scripts/dev-local-run.sh`: wherever the server process env
  is composed, default `VOX_PLUGINS="${VOX_PLUGINS:-credits,shared-agents,organizations}"`
  (find how the script exports env — mirror its existing pattern); `docker-compose.yml:36`
  default becomes `credits,shared-agents,organizations`.
- [ ] **Step 4:** `./scripts/dev-local-run.sh stop && start` — the plugin loads, 0001+0002
  apply to the dev DB (0002 copies whatever org rows exist; assertions pass), and the org
  API suites now exercise the PLUGIN provider end-to-end (design §10 layer 3):
  `npx vitest run tests/api.test.ts` — Organization Management / Roles / member / Org Secrets
  suites green, known failures only. `npx vitest run tests/organizations-absence.test.ts
  tests/organizations-override.test.ts tests/auth-membership.test.ts` — green (they
  set/reset providers in-process; the absence suite's "restore default provider" afterEach
  must be checked: if it re-instantiated CoreOrganizations, re-point it to a
  FakeOrganizations/harness provider — plumbing only, assertions untouched).
- [ ] **Step 5:** `npx playwright test tests/e2e/user-roles.spec.ts` → 28/28 (org-ful UI
  unchanged against the plugin).
- [ ] **Step 6: Commit** — `feat(orgs): Release A flip — vox.organizations is plugin-or-absent, CoreOrganizations deleted, dev enables the plugin`

### Task 8: SPEC, runbook, CLAUDE.md, full gate — then STOP

**Files:**
- Create: `plugins/organizations/SPEC.md`
- Modify: `CLAUDE.md` (plugin roster + org seam paragraph + Release A runbook), final gate

- [ ] **Step 1: SPEC.md** — follow `plugins/credits/SPEC.md`'s section structure exactly:
  identity; function and non-goals (no HTTP routes — Core adapters are the surface; no
  billing/seats; no multi-org — `memberships_user_uq` is the §4 invariant's home; no org
  deletion — and the seats-CASCADE note from §5 verbatim); services provided
  (`vox.organizations@1.0.0`, 16 methods listed); consumed: none; env: none; schema
  `plugin_organizations` tables `organizations`, `memberships`, `org_secrets`; data
  ownership (references Core user ids as opaque integers; ciphertext-only secrets — the
  encryption key never enters the plugin); copy-migration behavior incl. fresh-install skip
  and parity-abort.
- [ ] **Step 2: CLAUDE.md** — three sentence-level edits in the telegraphic register:
  (a) plugin roster mention wherever plugins are described (credits, shared-agents,
  organizations); (b) the Permission-Model seam paragraph: provider now comes from the
  `organizations` plugin via `VOX_PLUGINS` (absent ⇒ Phase-1 absence semantics — 501s,
  scheduler skips, sweeps exclude team); `CoreOrganizations` is gone; (c) deployment note:
  **Release A runbook** — DB snapshot → add `organizations` to `VOX_PLUGINS` in Coolify
  (env only) → deploy; plugin migrations are fail-closed (parity mismatch = container
  refuses start = old release keeps serving); treat `VOX_PLUGINS` like `DATABASE_URL`
  (typo = crash loop); NEVER remove `organizations` from an instance with org data;
  vox.agora.build omits it deliberately; Release B (column/table drops) only after soak,
  separate release, one-way door.
- [ ] **Step 3: the gate** — DB-cap cleanup SQL → `./scripts/dev-local-run.sh stop && start`
  → `./scripts/full-tests-run.sh` (do NOT pipe through tail — capture full output to a file
  and read the summaries). Green = unit + audio + E2E modulo the named pre-existing set;
  re-run any new failure in isolation before classifying; anything on the org surface that
  persists is a gate FAILURE to report, not rationalize.
- [ ] **Step 4: Commit** — `docs(orgs-plugin): SPEC + Release A runbook; the plugin is the provider`
- [ ] **Step 5: STOP.** No push, no PR, no merge, no deploy. Release A deployment and the
  Release B follow-up branch are the user's calls.

---

## Verification summary

| Design requirement (§) | Evidence |
|---|---|
| Plugin owns data, Core keeps doorway (§3) | Tasks 1–3; adapters untouched; eslint boundary 0 errors |
| Full §4 contract incl. error semantics | provider-contract suite (ported corpus + AlreadyMemberError/not-found/no-op cases); mirror-drift test both directions |
| Copy integrity fail-closed (§6, §10.1) | 0002 parity assertions; copy-migration.test.ts tamper case |
| Provider equivalence (§10.2) | same corpus as organizations-core.test.ts, run against plugin on the plugin test DB |
| Post-flip smoke (§10.3) | Task 7 Step 4: api.test.ts org suites against the plugin-backed dev server; playwright 28/28 |
| No stale reads post-A (§6 no-dual-read) | Task 5 sweep: zero Core readers of org/org-secret data outside provider path |
| FK drops exact (§6) | Task 6: 10 named constraints; live-DB count check = 1 remaining |
| Stale-fallback regression closed (§6) | Task 7: `?? new CoreOrganizations` deleted; grep zero |
| Runbook (§14) | Task 8 CLAUDE.md + SPEC; deployment NOT executed |
