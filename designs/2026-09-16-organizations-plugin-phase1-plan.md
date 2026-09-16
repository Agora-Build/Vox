# Organizations Plugin Extraction — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the org-plugin cutover needs that can ship *before* any plugin exists: the full provider interface implemented by `CoreOrganizations`, all six remaining membership bypasses routed through the seam, org routes as seam adapters, absence-is-inert semantics with zero persistent writes, and the client/verification hardening — all green and shippable with zero behavior change for org-ful instances (one pinned exception, Task 5).

**Architecture:** Grow `vox.organizations` from a read-only seam into the full provider contract (reads, counts, mutations, ciphertext org-secrets), keep `CoreOrganizations` as the implementation over today's tables, flip the holder to nullable with Core degrading per the design's §7, and convert Core's org routes into thin adapters. Phase 2 (the plugin + Release A) swaps the implementation; nothing in this phase moves data.

**Tech Stack:** TypeScript, Express, Drizzle ORM, Vitest, Playwright, React (one small client change set).

**Spec:** `designs/2026-09-16-organizations-plugin-extraction-design.md` (rev 2). Read it first — this plan argues from it. Section references (§N) below point into it.

## Global Constraints

- **Branch:** the seam branch `feat/organizations-seam` (18 commits) must merge to `main` first — **merging happens only on the user's explicit mark**. After it merges, create `feat/organizations-plugin-phase1` from `main`. If told to start before that merge, branch from `feat/organizations-seam` instead and say so in the first report.
- **Every commit message ends with:** `🤖 Built with SMT <smt@agora.build>`
- **API surface:** no path, status code, or response-key changes, with exactly two ADDITIVE exceptions the design authorizes: `dispatchBlocked` on the schedules list (§7) and `organizationsEnabled` on `/api/config` (§8). Error bodies for the new 501/503 cases are new codes on new conditions (provider absent/failing), never replacing an existing code on an existing condition.
- **Permission semantics:** unchanged, with ONE pinned exception (§11 R2): a pending team job's claimability becomes frozen at creation. Task 5 pins it with a test; nothing else may shift.
- **Migrations:** every `shared/schema.ts` change ships `db:generate` output registered in `server/migrate.ts`'s `MIGRATIONS` array, in the same commit (CLAUDE.md rule). Plain SQL, no `IF NOT EXISTS`. Next slot: file `0036_*.sql`, `version: 37`.
- **`npm run check` clean before every commit.** But **never bound blast radius with `tsc` alone** — `tsconfig.json:3` excludes `**/*.test.ts`. After any signature change, grep `tests/` and run the affected suites.
- **Env traps (each cost a prior cycle a debugging round):**
  - `npm test` needs `.env` sourced: `set -a; source .env; source .env.dev 2>/dev/null; set +a` — else ~11 spurious `CREDENTIAL_ENCRYPTION_KEY` failures.
  - `export DATABASE_URL=postgresql://vox:vox123@localhost:5432/vox` for DB-backed vitest runs.
  - Integration suites hit the **already-running** dev server: `./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start` after changing `server/`, or you test stale code.
  - Run `tests/api.test.ts` **unfiltered** — `-t "organization"` skips the `orgSession` setup test (`tests/api.test.ts:2249`) and spuriously fails 15 dependents.
  - Known pre-existing failures, NOT yours: `should get my-evals metrics with time filter` (route ignores `limit`); occasional parallelism flakes (`tier-pool-claim`, `clash-runner-lifecycle`, `admin.spec.ts` login-redirect) — each passes in isolation.
  - Before a full gate: clean leaked test resources (`DELETE FROM workflows WHERE owner_id=1; DELETE FROM projects WHERE owner_id=1; DELETE FROM secrets WHERE user_id=1;` via `docker exec -i $(docker ps -qf name=vox-postgres) psql -U vox -d vox`).
- **Test-evidence standard (§10):** test *plumbing* may change (seeding, fixtures); test *assertions* may not. Any assertion change is a finding to report, not an edit to make.
- **Boundary-scan regex note:** identifier-based patterns must keep the `(?!\w*[Mm]embership\b)` lookahead (plain `member\w*` matches `membership` — self-matching regexes burned a prior cycle).

## File Structure (locked by this plan)

- `server/organizations.ts` — grows: full `Organization`, `OrgSecretRow`, `AlreadyMemberError`, complete `OrganizationsProvider`; holder becomes nullable.
- `server/organizations-core.ts` — `CoreOrganizations` implements the full contract against today's tables. Still the only business-logic file allowed to touch the org columns.
- `server/scheduler.ts` — **new**: `processScheduledJobs` + `runMaintenanceTasks` extracted from `server/index.ts` so the zero-writes test can tick them without booting the server.
- `server/storage.ts` — gains `getUsersByIds`, `upsertOrgSecretRow`, `getJobOrgSecretScope`, `getDecryptedOrgRuntimeSecrets`; `claimEvalJob`/`getClaimableJobsForToken` read the stamped column; fail-sweeps gain a team-exclusion flag; `getOrgSecretsForJob` is deleted.
- `shared/schema.ts` — `evalJobs.creatorOrgId` (Task 5 only; no other schema change in Phase 1).
- `server/routes.ts` — 13 adapters + register/org-create writes + `dispatchBlocked` + config flag; `server/auth.ts` — 501-aware `requireOrgAdmin`, failure-tolerant `membershipFor`.
- Client: `client/src/components/console-layout.tsx`, `client/src/App.tsx`, the schedules page (located in Task 11).
- Tests: extend `tests/organizations-core.test.ts`, `tests/organizations-seam.test.ts`, `tests/organizations-boundary.test.ts`; new `tests/organizations-absence.test.ts`, `tests/org-claim-stamp.test.ts`, `tests/org-secret-fence.test.ts`.

---

### Task 1: Read-side interface growth + the batch fix

**Files:**
- Modify: `server/organizations.ts` (interface block, lines 19-34)
- Modify: `server/organizations-core.ts`
- Modify: `server/storage.ts` (add `getUsersByIds` near `getUsersByOrganization`, ~line 388)
- Test: `tests/organizations-core.test.ts` (extend)

**Interfaces:**
- Consumes: existing `storage.getUser/getUsersByOrganization/getOrganization/getAllOrganizations` (`storage.ts:349/388/397/407`), `countOrgAdmins` (`:2029`), `getOrganizationMemberCount` (`:2036`).
- Produces (later tasks rely on these exact names): `Organization { id; name; address: string | null; verified: boolean; createdAt: Date; updatedAt: Date }` replacing `OrgSummary`; `getOrganization(orgId): Promise<Organization | null>`; `countMembers(orgId): Promise<number>`; `countOrgAdmins(orgId): Promise<number>`; `listOrganizations(): Promise<Organization[]>`; `storage.getUsersByIds(ids: number[]): Promise<User[]>`.

- [ ] **Step 1: Write the failing tests** — extend `tests/organizations-core.test.ts`. The existing fake storage grows the needed methods; new cases:

```ts
// additions to the existing fakeStorage object:
//   getAllOrganizations: async () => [ORG7],
//   countOrgAdmins: async (id: number) => (id === 7 ? 1 : 0),
//   getOrganizationMemberCount: async (id: number) => (id === 7 ? 3 : 0),
//   getUsersByIds: async (ids: number[]) => ids.map((i) => users[i]).filter(Boolean),
// where ORG7 = { id: 7, name: "Acme", address: null, verified: true,
//                createdAt: new Date(0), updatedAt: new Date(0) }

it("getOrganization returns the FULL row (address/verified/timestamps), not a summary", async () => {
  expect(await orgs.getOrganization(7)).toEqual(ORG7);   // `verified`, not `isVerified`
});
it("countMembers and countOrgAdmins delegate", async () => {
  expect(await orgs.countMembers(7)).toBe(3);
  expect(await orgs.countOrgAdmins(7)).toBe(1);
});
it("listOrganizations returns full rows", async () => {
  expect(await orgs.listOrganizations()).toEqual([ORG7]);
});
it("getMemberships resolves via ONE getUsersByIds call, not per-user getUser", async () => {
  let batchCalls = 0, singleCalls = 0;  // wrap the fake's methods with counters
  const m = await countingOrgs.getMemberships([1, 3, 4, 999]);
  expect(m.get(1)).toEqual({ organizationId: 7, role: "owner" });
  expect(batchCalls).toBe(1);
  expect(singleCalls).toBe(0);          // the N+1 is gone (recorded deferred-minor, now closed)
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/organizations-core.test.ts` → FAIL (`countMembers` not a function; `isVerified` shape mismatch).
- [ ] **Step 3: Implement.** In `server/organizations.ts` replace `OrgSummary` with `Organization` (shape above; keep a `/** full row — three routes res.json() it verbatim (design §4) */` comment) and extend `OrganizationsProvider` with the three new reads. In `server/storage.ts` add:

```ts
async getUsersByIds(ids: number[]): Promise<User[]> {
  if (ids.length === 0) return [];
  return db.select().from(users).where(inArray(users.id, Array.from(new Set(ids))));
}
```

In `server/organizations-core.ts`: widen `StorageLike` with the four new picks; `getOrganization` returns the row verbatim (`{ ...org }` — the `verified→isVerified` mapping is deleted); `countMembers` → `storage.getOrganizationMemberCount(orgId)`; `countOrgAdmins` → `storage.countOrgAdmins(orgId)`; `listOrganizations` → `storage.getAllOrganizations()`; rewrite `getMemberships`:

```ts
async getMemberships(userIds: number[]): Promise<Map<number, Membership>> {
  const out = new Map<number, Membership>();
  for (const u of await this.storage.getUsersByIds(userIds)) {
    const m = toMembership(u.organizationId, u.orgRole);
    if (m) out.set(u.id, m);
  }
  return out;
}
```

- [ ] **Step 4: Fix the fallout `tsc` shows, then the fallout it cannot show.** `npm run check` — expected breaks: `OrgSummary` importers (`organizations-core.ts`, possibly `tests/organizations-override.test.ts`'s `FakeOrganizations.getOrganization` returning `{ id, name: \`org-${id}\`, isVerified: false }` → update to the full shape). Then grep tests (tsc can't see them): `grep -rn 'OrgSummary\|isVerified' tests/ server/` → update fixtures only, no assertions except the shape-assertions this task deliberately changes in `organizations-core.test.ts`.
- [ ] **Step 5: Run** — `npx vitest run tests/organizations-core.test.ts tests/organizations-seam.test.ts tests/organizations-override.test.ts` → PASS; `npm run check` clean.
- [ ] **Step 6: Commit** — `feat(orgs): full Organization shape, counts, listing, single-query getMemberships`

---

### Task 2: Mutation surface

**Files:**
- Modify: `server/organizations.ts`, `server/organizations-core.ts`
- Test: `tests/organizations-core.test.ts` (extend)

**Interfaces:**
- Consumes: `storage.createOrganization(org: InsertOrganization): Promise<Organization>` (`storage.ts:392`), `updateOrganization(id, data): Promise<Organization | undefined>` (`:402`), `updateUser(id, data): Promise<User | undefined>` (`:379`), `removeUserFromOrganization(userId): Promise<User | undefined>` (`:2043`).
- Produces: `createOrganization(input: { name: string; address?: string }, creator: { userId: number }): Promise<Organization>`; `updateOrganization(orgId, patch: { name?: string; address?: string }): Promise<Organization>` (throws `Error("organization not found")` when absent — adapters map to 404); `setVerified(orgId, verified): Promise<void>`; `addMember(orgId, userId, role: OrgRole): Promise<void>` throwing `AlreadyMemberError`; `setMemberRole(orgId, userId, role): Promise<void>`; `removeMember(orgId, userId): Promise<void>`; `export class AlreadyMemberError extends Error`.

- [ ] **Step 1: Write the failing tests:**

```ts
it("createOrganization creates the org and makes the creator its owner", async () => {
  const org = await orgs.createOrganization({ name: "New" }, { userId: 3 }); // user 3 has no org
  expect(org.name).toBe("New");
  expect(await orgs.getMembership(3)).toEqual({ organizationId: org.id, role: "owner" });
});
it("addMember enforces at-most-one-org with AlreadyMemberError", async () => {
  await expect(orgs.addMember(8, 1, "member")).rejects.toBeInstanceOf(AlreadyMemberError); // user 1 is in org 7
});
it("createOrganization refuses a creator who already belongs to an org", async () => {
  await expect(orgs.createOrganization({ name: "X" }, { userId: 1 })).rejects.toBeInstanceOf(AlreadyMemberError);
});
it("setMemberRole / removeMember round-trip", async () => {
  await orgs.setMemberRole(7, 2, "admin");
  expect((await orgs.getMembership(2))?.role).toBe("admin");
  await orgs.removeMember(7, 2);
  expect(await orgs.getMembership(2)).toBeNull();
});
it("setVerified writes the verified column; updateOrganization throws on unknown org", async () => {
  await orgs.setVerified(7, false);
  expect((await orgs.getOrganization(7))?.verified).toBe(false);
  await expect(orgs.updateOrganization(999, { name: "x" })).rejects.toThrow("organization not found");
});
```

(Fake storage grows `createOrganization`/`updateOrganization`/`updateUser`/`removeUserFromOrganization` as in-memory mutations of the shared fixtures.)

- [ ] **Step 2: Run to verify failure** → `createOrganization is not a function`.
- [ ] **Step 3: Implement.** In `server/organizations.ts` add `AlreadyMemberError` and the six method signatures with doc comments carrying the §4 rules verbatim (provider executes, never authorizes; at-most-one-org lives here; intra-provider atomicity only). In `CoreOrganizations`:

```ts
async addMember(orgId: number, userId: number, role: OrgRole): Promise<void> {
  const user = await this.storage.getUser(userId);
  if (!user) throw new Error("user not found");
  if (user.organizationId != null) throw new AlreadyMemberError(
    `user ${userId} already belongs to organization ${user.organizationId}`);
  await this.storage.updateUser(userId, { organizationId: orgId, orgRole: role });
}
async createOrganization(input: { name: string; address?: string }, creator: { userId: number }): Promise<Organization> {
  const user = await this.storage.getUser(creator.userId);
  if (user?.organizationId != null) throw new AlreadyMemberError(
    `user ${creator.userId} already belongs to organization ${user.organizationId}`);
  // Sequential, mirroring today's route behavior exactly. The PLUGIN provider
  // wraps these two in ctx.db.withTransaction (design §5); Core cannot and
  // does not pretend to.
  const org = await this.storage.createOrganization({ name: input.name, address: input.address ?? null });
  await this.storage.updateUser(creator.userId, { organizationId: org.id, orgRole: "owner" });
  return org;
}
async setMemberRole(orgId: number, userId: number, role: OrgRole): Promise<void> {
  await this.storage.updateUser(userId, { orgRole: role });
}
async removeMember(_orgId: number, userId: number): Promise<void> {
  await this.storage.removeUserFromOrganization(userId);
}
async setVerified(orgId: number, verified: boolean): Promise<void> {
  await this.storage.updateOrganization(orgId, { verified });
}
async updateOrganization(orgId: number, patch: { name?: string; address?: string }): Promise<Organization> {
  const updated = await this.storage.updateOrganization(orgId, patch);
  if (!updated) throw new Error("organization not found");
  return updated;
}
```

Widen `StorageLike` accordingly. Note `InsertOrganization` may not accept `address: null` — check its Zod/insert shape (`shared/schema.ts:44-48`) and pass `undefined` instead if so.
- [ ] **Step 4: Run** — target file green; `npm run check` clean; `grep -rn 'AlreadyMemberError' server/ tests/` shows only this task's sites.
- [ ] **Step 5: Commit** — `feat(orgs): provider mutation surface with at-most-one-org enforced in the provider`

---

### Task 3: Org-secrets surface (ciphertext only)

**Files:**
- Modify: `server/organizations.ts`, `server/organizations-core.ts`
- Modify: `server/storage.ts` (add `upsertOrgSecretRow` beside `upsertOrgSecret`, ~line 2670)
- Test: `tests/organizations-core.test.ts` (extend)

**Interfaces:**
- Consumes: `storage.getOrgSecrets(orgId): Promise<OrgSecret[]>` (`:2658`), `deleteOrgSecret(orgId, name)` (`:2701`).
- Produces: `OrgSecretRow` (hand-written, §4 — NOT the drizzle-inferred `OrgSecret`, which dies in Release B); `listOrgSecrets(orgId): Promise<OrgSecretRow[]>`; `upsertOrgSecret(orgId, row: { name; encryptedValue; brokerType: string | null; isTestAccount: boolean; createdBy: number }): Promise<OrgSecretRow>`; `deleteOrgSecret(orgId, name): Promise<void>`; `storage.upsertOrgSecretRow(orgId, row): Promise<OrgSecret>` — stores the given ciphertext **verbatim** (no encryption inside; the key stays with Core, §"Org secrets move too").

- [ ] **Step 1: Failing tests:**

```ts
it("org-secret rows pass through as opaque ciphertext, and upsert returns the row", async () => {
  const row = await orgs.upsertOrgSecret(7, { name: "API_KEY", encryptedValue: "v1:aa:bb:cc",
    brokerType: null, isTestAccount: false, createdBy: 1 });
  expect(row.encryptedValue).toBe("v1:aa:bb:cc");         // untouched — provider never decrypts
  expect(row.brokerType).toBeNull();                       // routes.ts:2887 echoes these two
  expect((await orgs.listOrgSecrets(7)).map(r => r.name)).toContain("API_KEY");
  await orgs.deleteOrgSecret(7, "API_KEY");
  expect((await orgs.listOrgSecrets(7)).map(r => r.name)).not.toContain("API_KEY");
});
```

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** `storage.upsertOrgSecretRow` mirrors `upsertOrgSecret`'s insert/update SQL but takes `encryptedValue` as given (copy the existing method's conflict handling verbatim, minus any `encryptValue` call — read `storage.ts:2670-2699` first and preserve the `createdBy`-preservation behavior documented in CLAUDE.md). `CoreOrganizations.listOrgSecrets` maps `storage.getOrgSecrets(orgId)` rows onto `OrgSecretRow` field-by-field; `deleteOrgSecret` delegates.
- [ ] **Step 4: Run + check** (target file, `npm run check`).
- [ ] **Step 5: Commit** — `feat(orgs): ciphertext org-secret surface — the key never enters the provider`

---

### Task 4: Nullable holder, 501 contract, config flag

The design's §7 contract: **absent → orgs inert (501 where an answer is required); provider FAILURE → same gating outcome as absent, 503 where an answer is required; neither ever causes a persistent write.**

**Files:**
- Modify: `server/organizations.ts` (holder), `server/auth.ts` (`membershipFor`, `requireOrgAdmin`), `server/index.ts:223-225` (resolution comment only), `server/routes.ts` (`/api/config` ~5405; null-guards at the enumerated call sites)
- Test: `tests/organizations-seam.test.ts` (rewrite the throw case), new `tests/organizations-absence.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `getOrganizations(): OrganizationsProvider | null` (no throw); `requireOrganizations(res): OrganizationsProvider | null` helper in `server/organizations.ts` that writes the 501 and returns null when absent; `membershipFor` returns `null` when the provider is absent and **rethrows** provider errors; `/api/config` carries `organizationsEnabled: "true" | "false"`.

- [ ] **Step 1: Failing tests.** In `tests/organizations-seam.test.ts` replace the throws-when-uninitialized case:

```ts
it("returns null when no provider is installed — absence is a state, not a crash", () => {
  expect(getOrganizations()).toBeNull();
});
```

New `tests/organizations-absence.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { setOrganizations, resetOrganizations, type OrganizationsProvider } from "../server/organizations";
import { membershipFor } from "../server/auth";

const failing: OrganizationsProvider = { /* every method: async () => { throw new Error("db blip"); } */ } as never;

describe("absence and failure semantics", () => {
  beforeEach(() => resetOrganizations());
  it("membershipFor returns null under an ABSENT provider (inert, fails closed)", async () => {
    expect(await membershipFor({} as never, 1)).toBeNull();
  });
  it("membershipFor RETHROWS under a FAILING provider — failure must stay distinguishable from 'no org'", async () => {
    setOrganizations(failing);
    await expect(membershipFor({} as never, 1)).rejects.toThrow("db blip");
  });
});
```

- [ ] **Step 2: Verify failure** (holder still throws).
- [ ] **Step 3: Implement.** Holder: `getOrganizations()` returns `current` (may be null); replace the never-null doc comment with the §7 contract and add:

```ts
/** Route guard: absent provider → 501, one sentence, one status, everywhere. */
export function requireOrganizations(res: { status(n: number): { json(b: unknown): unknown } }): OrganizationsProvider | null {
  const p = getOrganizations();
  if (!p) res.status(501).json({ error: "Organizations feature not enabled" });
  return p;
}
```

`membershipFor` (`auth.ts`): `const orgs = getOrganizations(); if (!orgs) return null;` before the cache fill; provider throws propagate (callers decide). `requireOrgAdmin`: FIRST `if (!getOrganizations()) return res.status(501).json({ error: "Organizations feature not enabled" });` then existing logic wrapped so a thrown provider error returns `503 { error: "Organizations service unavailable" }` instead of a 500. `/api/config` (after the `geoipAttribution` append at `routes.ts:5417-5418` — same computed-value pattern, NOT the `PUBLIC_CONFIG_KEYS` whitelist): `configObject.organizationsEnabled = getOrganizations() !== null ? "true" : "false";`

- [ ] **Step 4: Sweep the call sites the flip breaks.** `npm run check` will NOT find them all (optional chaining hides some) — use the enumerated list (verified by review): `server/auth.ts:41` (now handled), `server/index.ts:416` (Task 10 owns it — interim: `getOrganizations()?.getMembership(...) ?? null` via optional call so this task compiles), `server/routes.ts:599, 3664, 3756, 4208, 4436` (owner-membership lookups: `await getOrganizations()?.getMembership(id) ?? null` — absent ⇒ null ⇒ existing null-handling fails closed), `routes.ts:5640, 5677, 5738` (org routes — interim optional-call; Task 8 converts them to `requireOrganizations`). Then grep: `grep -rn 'getOrganizations()' server/ | grep -v 'organizations.ts'` and confirm every site either null-checks, optional-chains, or sits behind `requireOrganizations`.
- [ ] **Step 5: Run** — both org test files + `tests/auth-membership.test.ts` + `tests/organizations-override.test.ts`; `npm run check`; restart dev server; `npx vitest run tests/api.test.ts` (unfiltered) — no assertion changes expected: with `CoreOrganizations` always installed at startup, live behavior is identical.
- [ ] **Step 6: Commit** — `feat(orgs): nullable provider — absence is inert (501), failure is loud (503), never a silent no-org`

---

### Task 5: R2 — stamp `eval_jobs.creator_org_id` (migration 0036/v37)

The one **pinned semantic change** (§11): claimability of a pending team job freezes at creation. Today it tracks the creator's live org; stamped, it stays claimable after the creator leaves, bounded by pending-job lifetime. The scheduler still re-checks per tick, so schedule-level freshness is unchanged.

**Files:**
- Modify: `shared/schema.ts` (`evalJobs` table, line 367 block — add column), `server/storage.ts` (`claimEvalJob` ~966, `getClaimableJobsForToken` ~1021, `createEvalJob` callers' insert type), `server/routes.ts` + `server/index.ts` (stamp at creation), `server/migrate.ts` (register)
- Create: `migrations/0036_eval_jobs_creator_org_id.sql` (via `db:generate`, then hand-add the backfill)
- Test: new `tests/org-claim-stamp.test.ts`; plumbing in `tests/tier-pool-claim.test.ts`

**Interfaces:**
- Produces: `evalJobs.creatorOrgId: integer("creator_org_id")` (nullable, **no FK** — org ids are opaque, §3); every `storage.createEvalJob` caller passes `creatorOrgId: <seam-resolved creator org> | null`.

- [ ] **Step 1: Schema + migration.** Add to the `evalJobs` table block: `creatorOrgId: integer("creator_org_id"),` with comment `// frozen at creation from the seam (design §11 R2) — the claim SQL reads THIS, never users.organization_id`. Run `DATABASE_URL=... npm run db:generate`; review the SQL (one `ALTER TABLE ADD COLUMN` only); append the backfill to the same file:

```sql
UPDATE eval_jobs SET creator_org_id = u.organization_id
FROM users u WHERE eval_jobs.created_by = u.id AND eval_jobs.creator_org_id IS NULL;
```

Register: `{ version: 37, description: "R2: stamp creator_org_id on eval_jobs; claim SQL stops joining users", file: "0036_eval_jobs_creator_org_id.sql" },`
- [ ] **Step 2: Failing test** (`tests/org-claim-stamp.test.ts`, DB-backed — seed via storage, model on `tests/tier-pool-claim.test.ts`'s setup):

Copy the seeding helpers from `tests/tier-pool-claim.test.ts` (top of file: org/user/token/job factories against the dev DB) — reuse them, do not reinvent. The two cases, concretely:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { storage } from "../server/storage";

describe("R2: claimability is frozen at creation (design §11, pinned semantic change)", () => {
  let orgId: number, creatorId: number, tokenId: number;
  beforeAll(async () => {
    const org = await storage.createOrganization({ name: `r2-${Date.now()}` });
    orgId = org.id;
    creatorId = (await storage.createUser({ username: `r2c-${Date.now()}`, email: `r2c${Date.now()}@t.io`,
      passwordHash: "x", plan: "premium", organizationId: orgId, orgRole: "member" } as never)).id;
    const memberId = (await storage.createUser({ username: `r2m-${Date.now()}`, email: `r2m${Date.now()}@t.io`,
      passwordHash: "x", plan: "premium", organizationId: orgId, orgRole: "member" } as never)).id;
    tokenId = (await storage.createEvalAgentToken({ /* copy tier-pool-claim's token factory: */
      name: "r2-team-token", createdBy: memberId, dispatchTier: "team", region: "na-us-test" } as never)).id;
  });

  it("a pending team job stays claimable after its creator leaves the org", async () => {
    const job = await storage.createEvalJob({ workflowId: null, evalSetId: null, createdBy: creatorId,
      targetRegion: "na-us-test", targetTier: "team", status: "pending",
      creatorOrgId: orgId /* the stamp — resolved from the seam at the real creation sites */ } as never);
    await storage.removeUserFromOrganization(creatorId);        // creator leaves AFTER creation
    const claimed = await storage.claimEvalJob(tokenId);
    expect(claimed?.id).toBe(job.id);                            // frozen: still claimable (was: unclaimable)
  });

  it("a team job stamped with creatorOrgId null is never claimable via the team arm", async () => {
    await storage.createEvalJob({ workflowId: null, evalSetId: null, createdBy: creatorId,
      targetRegion: "na-us-test", targetTier: "team", status: "pending", creatorOrgId: null } as never);
    expect(await storage.claimEvalJob(tokenId)).toBeNull();
  });
});
```

(The `as never` casts follow the repo's existing test-fixture convention; exact factory field names come from `tier-pool-claim.test.ts` — align with what it actually passes, keep these assertions.)

- [ ] **Step 3: Verify failure** (column absent / claim still joins users → first test red).
- [ ] **Step 4: Implement.** In both claim queries replace the `LEFT JOIN users creator ... AND creator.organization_id = $N` arm with `AND ej.creator_org_id = $N` (drop the join if nothing else reads it — check the surrounding SELECT). Stamp at creation: `grep -n 'createEvalJob(' server/` — for each caller add `creatorOrgId:` from the already-resolved membership (`user.membership?.organizationId ?? null` in routes; `creatorMembership?.organizationId ?? null` in the scheduler at `index.ts:439` area). `tier-pool-claim.test.ts` plumbing: storage-direct job seeds add `creatorOrgId` (assertions untouched).
- [ ] **Step 5: Run** — `npm run db:migrate` locally; new test green; `npx vitest run tests/tier-pool-claim.test.ts tests/tier-pool-dispatch.test.ts` green with **no assertion edits**; `npm run check`.
- [ ] **Step 6: Commit** — `feat(orgs): R2 — claim reads frozen creator_org_id, not live membership (pinned semantic change)` — schema + migration + registration + stamps + tests in ONE commit (CLAUDE.md migration rule).

---

### Task 6: R1 — run-targets/count read owner orgs through the seam

**Files:**
- Modify: `server/storage.ts:804` region (`getEvalAgentsWithTokenTier` — remove the `tokenOwnerOrgId: users.organizationId` select and, if now unused, the join), `server/routes.ts` consumers (`:3398/3404` run-targets; `:4615/4728` tier-availability)
- Test: existing `tests/dispatch-dispatchable.test.ts`, `tests/tier-pool-dispatch.test.ts` (must pass, assertions untouched)

**Interfaces:**
- Consumes: `getMemberships` (single-query since Task 1); rows expose `tokenCreatedBy`.
- Produces: routes build `ownerOrgId` themselves: `const ownerOrgs = (await getOrganizations()?.getMemberships(rows.map(r => r.tokenCreatedBy))) ?? new Map();` then `ownerOrgId: ownerOrgs.get(r.tokenCreatedBy)?.organizationId ?? null`. `filterDispatchableAgents`' `DispatchableAgentRow.ownerOrgId` field is unchanged — only its source moves.

- [ ] **Step 1:** Read both consumer blocks; apply the pattern at each; delete the select column (and dead join) in storage.
- [ ] **Step 2:** `npm run check`; grep `tokenOwnerOrgId` → remaining hits only in comments/types you just updated.
- [ ] **Step 3: Run** — the two dispatch suites + restart server + `npx vitest run tests/api.test.ts` unfiltered. Absent-provider behavior (empty map → all `ownerOrgId` null → team arm never offered) is fail-closed by construction — covered by Task 10's absence suite.
- [ ] **Step 4: Commit** — `refactor(orgs): R1 — owner-org for dispatch listings resolves through the seam, join column dropped`

---

### Task 7: R3 — the credential fence through the seam (strictest review of the branch)

**Files:**
- Modify: `server/storage.ts` — DELETE `getOrgSecretsForJob` (`:2717-2737`); ADD `getJobOrgSecretScope(jobId): Promise<{ workflowOrgId: number; createdBy: number | null } | null>` (the job→workflow lookup from `:2718-2724`; null when the workflow is personal) and `getDecryptedOrgRuntimeSecrets(orgId): Promise<Record<string, string>>` (the `:2732-2736` tail verbatim: non-brokered rows only, `decryptValue` each).
- Modify: `server/routes.ts` job-secrets endpoint (org branch ~`:4146`)
- Test: new `tests/org-secret-fence.test.ts`

**Interfaces:**
- Produces: the fence lives in the ROUTE (Core authorizes, §4): scope → `getOrganizations()?.getMembership(scope.createdBy)` → compare → fetch or `{}`.

- [ ] **Step 1: Failing tests** (DB-backed; seed two orgs A/B, org-A workflow, jobs by an A-member and a B-member; secrets in A):

Seed once in `beforeAll` (factories per `tests/tier-pool-claim.test.ts` / `tests/session-secrets-class.test.ts` conventions): orgs A and B; users `aMember∈A`, `bMember∈B`, `nobody` (no org); an org-A workflow `wfA`; org-A secrets `RUNTIME_KEY` (brokerType null) and `LOGIN_EMAIL` (brokerType `"agora"`), both via `storage.upsertOrgSecretRow` with `encryptValue`-produced ciphertext; jobs `jobByA`/`jobByB`/`jobByNobody` on `wfA` created by each user. The route-level fence logic is exercised through a small exported helper so the test needs no HTTP server — Task 7 Step 3 extracts the route's fence block into `export async function orgRuntimeSecretsForJob(jobId: number): Promise<Record<string, string>>` in `server/routes.ts` (the route calls it; the test imports it):

```ts
it("same-org creator gets the org's runtime secrets", async () => {
  await expect(orgRuntimeSecretsForJob(jobByA.id)).resolves.toHaveProperty("RUNTIME_KEY");
});
it("CROSS-ORG creator gets {} — one org can never spend another's credentials", async () => {
  await expect(orgRuntimeSecretsForJob(jobByB.id)).resolves.toEqual({});
});
it("creator with no membership gets {}", async () => {
  await expect(orgRuntimeSecretsForJob(jobByNobody.id)).resolves.toEqual({});
});
it("absent provider gets {} — never a leak, never a write", async () => {
  resetOrganizations();
  await expect(orgRuntimeSecretsForJob(jobByA.id)).resolves.toEqual({});
  setOrganizations(new CoreOrganizations(storage));   // restore for later cases
});
it("brokered (login-class) rows never appear in the runtime map", async () => {
  const m = await orgRuntimeSecretsForJob(jobByA.id);
  expect(m).not.toHaveProperty("LOGIN_EMAIL");        // Core-only class, structurally excluded
});
```

- [ ] **Step 2: Verify failure** (new storage methods absent).
- [ ] **Step 3: Implement** route-side:

```ts
const scope = await storage.getJobOrgSecretScope(parseInt(jobId));
if (scope) {
  const creatorMembership = scope.createdBy != null
    ? await getOrganizations()?.getMembership(scope.createdBy) ?? null : null;
  if (creatorMembership?.organizationId === scope.workflowOrgId) {
    Object.assign(decrypted, await storage.getDecryptedOrgRuntimeSecrets(scope.workflowOrgId));
  } // else: fence closed — {} exactly as before (storage.ts:2731's behavior, relocated to Core)
}
```

- [ ] **Step 4: Run** — new suite; `grep -n 'getOrgSecretsForJob' server/ tests/` → zero; session/dispatch suites (`tests/session-dispatch.test.ts tests/session-endpoint.test.ts`) green unedited; restart + api.test.ts unfiltered.
- [ ] **Step 5: Commit** — `feat(orgs): R3 — org-credential fence resolves membership through the seam, in Core`

---

### Task 8: Adapters, part 1 — org CRUD / members / leave / admin (10 routes)

**Files:** `server/routes.ts` — routes at `:5464` (create), `:5511` (get), `:5538` (patch), `:5565` (invite mint), `:5620` (members), `:5656` (member role), `:5723` (member remove), `:5771` (leave), `:5807` (admin verify), `:5826` (admin list), `:5852` (`/api/user/organization`). (11 handlers; "10 routes" + the user-org read.)

**The adapter pattern** — each handler becomes: `const orgs = requireOrganizations(res); if (!orgs) return;` → existing auth/validation unchanged → seam calls replace `storage.*` org calls → response keys/status codes byte-identical. Seats/counts stay per §5. Worked examples (write the rest to match; the per-route seam mapping is):

| Route | storage call today → seam call |
|---|---|
| create `:5464` | `createOrganization`+`updateUser`+seat insert → `orgs.createOrganization(input,{userId})` **then** `storage.createOrganizationSeat(...)` (write order §5: plugin-side first, seat after) |
| get `:5511` | `getOrganization` → `orgs.getOrganization` (full row — response unchanged) |
| patch `:5538` | `updateOrganization` → `orgs.updateOrganization` (catch not-found → existing 404) |
| invite mint `:5565` | membership/seat checks stay Core (`orgs.countMembers` for the `:5584` seat gate); invite row write unchanged |
| members `:5620` | `getUsersByOrganization` → `orgs.listMembers` + `storage.getUsersByIds` join for `username/email/plan/createdAt`; roles from the roster |
| member role `:5656` | last-admin guard `storage.countOrgAdmins` → `orgs.countOrgAdmins`; write → `orgs.setMemberRole` |
| member remove `:5723` | guards via seam counts; `removeUserFromOrganization` → `orgs.removeMember` **then** seat decrement (order §5) |
| leave `:5771` | same as remove, self-target |
| admin verify `:5807` | `updateOrganization({verified})` → `orgs.setVerified` |
| admin list `:5826` | `getAllOrganizations` → `orgs.listOrganizations`; member counts → `orgs.countMembers`; seats stay `storage.getOrganizationSeat` |
| user-org `:5852` | `getOrganization`+member count → `orgs.getOrganization` + `orgs.countMembers`; seats stay storage |
| setup-intent `:6066` | **not an adapter** (payments stay, §3) — but its ONE org-identity read (`storage.getOrganization` for the Stripe customer name, `:6083`) switches to `orgs.getOrganization` (guarded: absent → 501, since the org cannot exist without the feature). No other payments route changes. |

Fully worked example (member role, `:5656`) — the shape every other conversion copies:

```ts
app.patch("/api/organizations/:id/members/:userId", requireAuth, requireOrgAdmin, async (req, res) => {
  const orgs = requireOrganizations(res); if (!orgs) return;   // 501 before anything else
  // ...existing param/role validation and self-change rejection UNCHANGED...
  const targetMembership = await orgs.getMembership(parseInt(userId));
  if (!targetMembership || targetMembership.organizationId !== parseInt(id)) {
    return res.status(404).json({ error: "Member not found" });          // same body as today
  }
  if (targetMembership.role === "owner") { /* existing owner-protection branch unchanged */ }
  if (orgRole === "admin" && (await orgs.countOrgAdmins(parseInt(id))) >= 4) { /* existing max-admins branch */ }
  await orgs.setMemberRole(parseInt(id), parseInt(userId), orgRole);
  // response: SAME KEYS as today — echo the just-written role, not a re-read
  res.json({ id: parseInt(userId), orgRole });
});
```

- [ ] **Step 1:** Read each handler in full before converting it; convert one route at a time; after each, `npm run check`.
- [ ] **Step 2: Run** — restart server; `npx vitest run tests/api.test.ts` unfiltered — the Organization Management / Roles / Org Secrets suites are the acceptance evidence, **no assertion changes**. E2E org specs: `npx playwright test tests/e2e/user-roles.spec.ts` (org sections).
- [ ] **Step 3: Commit** — `refactor(orgs): org/member/admin routes are seam adapters — Core authorizes, the provider executes`

---

### Task 9: Adapters, part 2 — org-secrets routes + the two auth-path writes

**Files:** `server/routes.ts` — `:2813` (GET org-secrets), `:2843` (POST), `:2895` (DELETE), `:852-862` (register invite redemption), `:5498-5501` is absorbed by Task 8's create-org conversion (verify, don't re-do).

- [ ] **Step 1: Org-secrets routes.** GET → `orgs.listOrgSecrets(orgId)` mapped to today's response keys (names/metadata; values are never returned — preserve exactly). POST → **encrypt in the route** (`encryptValue(value)` — the key stays in Core, §"Org secrets move too"), then `orgs.upsertOrgSecret(orgId, { name, encryptedValue, brokerType, isTestAccount, createdBy: user.id })`; response echoes `brokerType`/`isTestAccount` from the returned row (`:2887` behavior). DELETE → `orgs.deleteOrgSecret`. All three behind `requireOrganizations` (GET included — reading org secrets with no org feature is a 501, and `requireOrgAdmin` on POST/DELETE already 501s first from Task 4; keep both, guard first).
- [ ] **Step 2: Register redemption (`:852-862`).** `createUser` loses the org fields; after creation: `if (invite.organizationId != null) { const orgs = getOrganizations(); if (!orgs) return res.status(400).json({ error: "Organizations feature not enabled" }); await orgs.addMember(invite.organizationId, user.id, "member"); }` — `AlreadyMemberError` mapped defensively to the route's existing 400 shape. Mint-side already guards (Task 8), so this 400 is a race-window defense, not a normal path.
- [ ] **Step 3: Run** — restart; api.test.ts unfiltered (Org Secrets + registration/invite suites, assertions untouched); `npx vitest run tests/session-secrets-class.test.ts` (plumbing only if it seeded via the deleted path).
- [ ] **Step 4: Commit** — `refactor(orgs): org-secret routes + invite redemption through the provider; ciphertext at the boundary`

---

### Task 10: Absence guards — scheduler skip, sweep exclusion, the zero-writes test

**Files:**
- Create: `server/scheduler.ts` — move `processScheduledJobs` and `runMaintenanceTasks` (plus their helpers) out of `server/index.ts` **verbatim** (mechanical extraction; `index.ts` imports and keeps the `setInterval` wiring at `:522-523`). This exists so the test can tick them without booting a server.
- Modify: `server/scheduler.ts` (the guards), `server/storage.ts` (`failPendingJobsWithNoAgent` `:1105`, `failExpiredPendingJobs` `:1137` — new `excludeTeamTier: boolean` param appending `AND target_tier IS DISTINCT FROM 'team'` when true)
- Test: new section in `tests/organizations-absence.test.ts` (DB-backed)

**Interfaces:**
- Produces: exported `processScheduledJobs()` / `runMaintenanceTasks()`; the discriminator: **provider unavailable (absent OR threw) && `workflow.organizationId != null` → skip, count, one log line per tick, zero writes** — placed BEFORE `detectSessionNeed` (`old index.ts:437`) and `stampOwnerSession`, so a skipped schedule never burns a broker mint (§7).

- [ ] **Step 1: Extraction commit first** (no behavior change): move, wire imports, `npm run check`, restart server, confirm a scheduler tick still logs. Commit `refactor: extract scheduler/maintenance ticks into server/scheduler.ts` — separate commit so the guard diff reviews clean.
- [ ] **Step 2: Failing zero-writes test:**

```ts
describe("plugin absence causes zero persistent writes", () => {
  // seed (beforeAll): org O; creator C∈O; enabled session-injected TEAM schedule S on an
  // org workflow (the exact shape that hits old index.ts:442/:458/:465);
  // pending team job J (stamped creatorOrgId=O, old enough to be reaper-eligible)
  it("scheduler + maintenance ticks with provider ABSENT change nothing", async () => {
    resetOrganizations();
    const before = await snapshot();           // schedules(is_enabled,next_run), jobs(status), web_sessions(count)
    await processScheduledJobs();
    await runMaintenanceTasks();
    expect(await snapshot()).toEqual(before);  // ZERO rows changed — the design's §7 test, both workers
  });
  it("a FAILING provider takes the same path — skip, never disable", async () => {
    setOrganizations(throwingProvider);
    const before = await snapshot();
    await processScheduledJobs();
    expect(await snapshot()).toEqual(before);
  });
  it("personal schedules still dispatch while orgs are absent", async () => { /* non-org schedule fires normally */ });
});
```

- [ ] **Step 3: Verify failure** — today's ticks disable S (`:442-444`/`:458-460`/`:465-467`) and fail J (sweeps): snapshot diff non-empty.
- [ ] **Step 4: Implement.** In the schedule loop, before session-need detection:

```ts
if (workflow.organizationId != null) {
  const orgs = getOrganizations();
  let creatorOrg: number | null = null, orgsAnswered = orgs !== null;
  if (orgs) { try { creatorOrg = (await orgs.getMembership(schedule.createdBy))?.organizationId ?? null; }
              catch { orgsAnswered = false; } }        // failure == absence: §4 error contract
  if (!orgsAnswered) { orgSkips++; continue; }          // skip — enabled, undispatched, unwritten
  // ...creatorOrg feeds the existing sessionPoolViolation call (replaces the old :415 lookup)
}
```

After the loop: `if (orgSkips) log(\`\${orgSkips} org schedule(s) skipped — organizations unavailable\`, "scheduler");` (once per tick, §7). Sweeps: callers pass `excludeTeamTier: getOrganizations() === null`.

**Also in this task — the run-route arm of §7's table** ("org-workflow jobs are not dispatched at all while orgs are unavailable"): a PUBLIC org-owned workflow is runnable by anyone, so under absence it would create a job whose secret fence returns `{}` → job fails → a persistent write caused by absence. Close it at the source: in each job-creating route (`grep -n 'createEvalJob(' server/routes.ts` — run, run-now, schedule-create/extend paths), before job creation:

```ts
if (workflow.organizationId != null && !getOrganizations()) {
  return res.status(501).json({ error: "Organizations feature not enabled" });
}
```

Add an absence-suite case: running a public org-owned workflow with the provider reset returns 501 and creates zero job rows.
- [ ] **Step 5: Run** — absence suite green; restart; `npx vitest run tests/api.test.ts tests/session-dispatch.test.ts` unedited; `npm run check`.
- [ ] **Step 6: Commit** — `feat(orgs): absence is inert — scheduler skips, sweeps exclude team, zero-writes proven over both workers`

---

### Task 11: `dispatchBlocked` + the client change set

**Files:**
- Modify: `server/routes.ts:2219-2227` (the single `withPerms` map — it covers BOTH the admin and non-admin branches since `schedules` is one variable)
- Modify: `client/src/components/console-layout.tsx` (config query + `:235-241` gate), `client/src/App.tsx` (guards at `:562-564, :606-608, :650-651, :694-695, :738-740`), the schedules page (locate: `grep -rln 'canExtend' client/src/pages/` — the file consuming the schedule flags)
- Test: `tests/api.test.ts` additions are NOT allowed (evidence standard) — server side covered in `tests/organizations-absence.test.ts`; client verified by E2E smoke + manual check in Step 5.

- [ ] **Step 1: Server.** Inside the `withPerms` map add:

```ts
dispatchBlocked: (getOrganizations() === null && s.workflowOrganizationId != null)
  ? { reason: "organizations-unavailable", detail: "Organization plugin/feature not enabled" }
  : null,
```

Absence test (in the absence suite): with provider reset, the schedules storage row for an org workflow maps to a non-null `dispatchBlocked`; with provider installed → null. (Test the mapping via a small exported helper if the route body is awkward to unit-test: `export function scheduleDispatchBlocked(workflowOrganizationId: number | null)` in `server/routes.ts` is acceptable and keeps the map one-line.)
- [ ] **Step 2: Client — config plumbing.** In `console-layout.tsx` add the same `useQuery({ queryKey: ["/api/config"] })` pattern used at `client/src/components/layout.tsx:44`; gate the `else` branch: `} else if (config?.organizationsEnabled !== "false") {` (string values — `/api/config` returns strings). In `App.tsx`, each of the four create-redirect guards adds the same condition before redirecting to `/console/organization/create` (an org-less user on an org-less instance lands on their normal console page instead); the fifth guard (`:738-740`) needs no change (it redirects AWAY from create — correct in all states).
- [ ] **Step 3: Client — schedules rendering.** In the located schedules page, next to the existing status badge derived from `deriveScheduleStatus`, render when `s.dispatchBlocked`:

```tsx
{s.dispatchBlocked && (
  <Badge variant="outline" title={s.dispatchBlocked.detail}>Orgs disabled</Badge>
)}
```

(match the page's existing Badge import/variant conventions).
- [ ] **Step 4:** `npm run check`; restart; api.test.ts unfiltered (additive key — no assertion touches it); `npx playwright test tests/e2e/user-roles.spec.ts` green.
- [ ] **Step 5: Manual absence smoke** (no automated harness runs the client against an absent provider in Phase 1): note in the report that full client-absence verification lands with Phase 2's staging smoke; what Phase 1 verifies is the flag plumbing and that org-ful behavior is unchanged.
- [ ] **Step 6: Commit** — `feat(orgs): computed dispatchBlocked + client capability gating — reasons are computed, never stored`

---

### Task 12: Boundary-scan hardening

**Files:**
- Modify: `tests/organizations-boundary.test.ts`, `server/storage.ts` (marker comments only)

**Design (§10):** add a **snake-case** pattern; narrow the blanket `storage.ts` exemption to explicitly marked provider-serving lines; extend coverage to `plugins/*/server` (no-op today, load-bearing in Phase 2). Keep the camelCase pattern + lookahead untouched.

- [ ] **Step 1: Failing test additions:**

```ts
const SNAKE_FORBIDDEN = /\busers\.organization_id\b|\borg_role\b/;
const MARKER = "// org-columns: provider";   // a line so tagged is an audited exemption

it("snake-case org-column SQL appears only on provider-marked lines", () => {
  // scan server/*.ts AND server/plugins/*.ts AND plugins/*/server/**/*.ts (recursive for the last):
  // storage.ts is NOT exempt from THIS pattern — unmarked hits are offenders
});
it("the marker count is pinned — a new exemption is a conscious act", () => {
  expect(countMarkers("server/storage.ts")).toBe(EXPECTED_MARKERS); // set to the real count in Step 3
});
// falsifiability: extend the existing scan(tmp,...) fixture with a seeded
// `WHERE users.organization_id = 1` line and assert it is flagged.
```

- [ ] **Step 2: Verify failure** — the surviving legitimate sites are unmarked, so the scan reports them; that report IS the enumeration for Step 3.
- [ ] **Step 3: Mark the survivors.** After Tasks 5-9 the business-logic sites are gone; what legitimately remains in `storage.ts` is the provider-serving surface (`getUser`, `getUsersByIds`, `getUsersByOrganization`, `countOrgAdmins`, `getOrganizationMemberCount`, `removeUserFromOrganization`, `updateUser`'s column list, org/org-secret CRUD — all of which Release B deletes or re-points). Tag each with the marker + one-line justification; set `EXPECTED_MARKERS`. **If Step 2 flagged a site that is NOT provider-serving, that is a Phase-1 gap — fix it through the seam, do not mark it.**
- [ ] **Step 4: Run** — boundary suite green; falsifiability case proves the new pattern fires.
- [ ] **Step 5: Commit** — `test(orgs): boundary scan sees SQL — snake-case pattern, marked exemptions, plugin dirs scanned`

---

### Task 13: Docs + the full gate

**Files:** `CLAUDE.md` (Permission Model section — the seam paragraph), final gate.

- [ ] **Step 1: Update CLAUDE.md.** Rewrite the two seam paragraphs to state: the provider is the full org contract (reads/counts/mutations/ciphertext secrets); `getOrganizations()` is nullable — absent ⇒ orgs inert (501 on org routes, scheduler skips with computed `dispatchBlocked`, sweeps exclude team, zero persistent writes), provider failure ⇒ treated as absence at gating points, 503 where an answer is required; the six former `storage.ts` bypasses are closed (R1 seam-batched, R2 frozen `eval_jobs.creator_org_id` — note the pinned claim-freshness change, R3 fence in Core, counts/writes behind the provider); the boundary scan now covers snake-case SQL with marked exemptions. Keep it to CLAUDE.md's telegraphic register.
- [ ] **Step 2: The gate.** DB cleanup (Global Constraints) → `./scripts/dev-local-run.sh stop && start` → `./scripts/full-tests-run.sh`. Green = unit + audio + E2E, modulo the named pre-existing failures — re-run any flake in isolation before classifying it.
- [ ] **Step 3: Commit** — `docs: CLAUDE.md — the org seam is the full provider contract; absence semantics recorded`
- [ ] **Step 4: STOP.** No push, no PR, no merge — those wait for the whole-branch final review and the user's mark.

---

## Verification summary

| Design requirement (§) | Evidence |
|---|---|
| Six bypasses closed (§1) | Tasks 5-9 + boundary scan (Task 12) reports zero unmarked sites |
| Absence = inert, zero writes (§7) | `tests/organizations-absence.test.ts` — both workers ticked, snapshot equality; sweeps excluded |
| Failure ≠ "no org" (§4) | membershipFor rethrow test; scheduler failing-provider test; 503 vs 501 split |
| Adapters, byte-identical responses (§3) | `tests/api.test.ts` unfiltered, assertions untouched |
| Pinned R2 semantic change (§11) | `tests/org-claim-stamp.test.ts` freezes it in both directions |
| Credential fence (§11 R3) | `tests/org-secret-fence.test.ts` cross-org negative |
| Client capability gating (§8) | Task 11 + E2E; full absence smoke deferred to Phase 2 staging (stated, not hidden) |
| No data moved, no plugin yet (§12) | The diff contains no `plugins/organizations`, one additive migration |
