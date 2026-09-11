# Organizations Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put every "which org does this person belong to, and with what power?" question behind a replaceable `vox.organizations` provider, so orgs can later be extracted into a plugin by swapping an implementation instead of rewriting Core.

**Architecture:** A never-null seam (`server/organizations.ts`: interface + holder, mirroring `server/marketplace.ts`) with a Core-native implementation (`server/organizations-core.ts`) resolved once at startup, overridable by a plugin providing `vox.organizations`. Membership is resolved **once per request** at the auth boundary and attached to the user object, so the synchronous permission predicates keep working. The migration is deliberately incremental: membership is added *alongside* the legacy `users.organizationId` / `users.orgRole` columns, call sites move over in batches (every intermediate state compiles and passes tests), and the final task removes the legacy fields from the auth type so `tsc` proves no reader was missed.

**Tech Stack:** TypeScript, Express, Drizzle ORM, Vitest, Playwright.

**Spec:** `designs/2026-09-10-organizations-seam-design.md` — read it first; this plan argues from it.

## Global Constraints

- **Branch:** `feat/organizations-seam` (already created, based on `main`). Never commit to `main`.
- **Every commit message ends with:** `🤖 Built with SMT <smt@agora.build>`
- **No schema change, no migration, no data movement, no UI change.** If a task seems to need one, stop — that is a signal the design was wrong, not a licence to add one.
- **No API surface change.** Every endpoint keeps its path, request shape, response shape and status codes. A behavioral difference is a bug, not a feature.
- **No permission-semantics change.** Admin is not a super-editor; `canScheduleWorkflow` stays owner-only; secrets still follow workflow ownership.
- **Type check must stay clean:** `npm run check` (runs `tsc`). This is the primary safety net for this refactor.
- **Unit tests:** `npx vitest run tests/<file>.test.ts`. Full unit suite: `npm test`.
- **Integration tests hit the ALREADY-RUNNING dev server.** After changing anything under `server/`, restart before trusting `tests/api.test.ts`:
  `./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start`
- **Before any full-gate run**, clear leaked test resources or per-user caps trip and the gate goes red for unrelated reasons:
  ```sql
  DELETE FROM workflows WHERE owner_id=1;
  DELETE FROM projects  WHERE owner_id=1;
  DELETE FROM secrets   WHERE user_id=1;
  ```
  Run with: `docker exec -i $(docker ps -qf name=vox-postgres) psql -U vox -d vox < /tmp/cleanup.sql`
- **Known-flaky, not caused by this work:** `tests/e2e/admin.spec.ts` "redirect admin ... after login" (passes in isolation) and the credits suites when run in parallel. Verify in isolation before investigating.
- **Domain facts (verbatim from the code):**
  - `orgRoleEnum = pgEnum("org_role", ["owner", "admin", "member"])`; the `users.orgRole` column is **nullable**.
  - **Verified**: every existing `orgRole` comparison in `server/routes.ts` tests against `'owner'` or `'admin'` only (lines 2205, 5670, 5680, 5685, 5729, 5765) — there is no `=== 'member'` test anywhere. That is why `CoreOrganizations` may map a null role to `"member"` without changing any outcome: a null role was never a manager, and neither is `"member"`. If you add a `role === 'member'` test during this work, you have introduced a behavior change — don't.
  - The organizations table column is `verified` (boolean), which maps to `OrgSummary.isVerified` at the seam boundary. This rename is deliberate; do not rename the column.
  - Existing storage methods to build on: `storage.getUser(id)`, `storage.getUsersByOrganization(organizationId)`, `storage.getOrganization(id)`.

---

### Task 1: The seam — interface and holder

**Files:**
- Create: `server/organizations.ts`
- Test: `tests/organizations-seam.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `OrgRole`, `Membership`, `OrgSummary`, `OrganizationsProvider`, `setOrganizations(p)`, `getOrganizations()`, `resetOrganizations()`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/organizations-seam.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  setOrganizations,
  getOrganizations,
  resetOrganizations,
  type OrganizationsProvider,
} from "../server/organizations";

const stub: OrganizationsProvider = {
  getMembership: async () => ({ organizationId: 7, role: "admin" }),
  getMemberships: async () => new Map(),
  getOrganization: async () => null,
  listMembers: async () => [],
};

describe("organizations seam", () => {
  beforeEach(() => resetOrganizations());

  it("returns the provider that was installed", async () => {
    setOrganizations(stub);
    expect(await getOrganizations().getMembership(1)).toEqual({ organizationId: 7, role: "admin" });
  });

  it("throws rather than reporting everyone as org-less when uninitialized", () => {
    expect(() => getOrganizations()).toThrow(/not initialized/);
  });

  it("lets a later provider replace an earlier one (plugin overrides Core)", async () => {
    setOrganizations(stub);
    setOrganizations({ ...stub, getMembership: async () => null });
    expect(await getOrganizations().getMembership(1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/organizations-seam.test.ts`
Expected: FAIL — cannot resolve `../server/organizations`.

- [ ] **Step 3: Write the implementation**

```ts
// server/organizations.ts
//
// Core-side seam for organization MEMBERSHIP — "which org does this person
// belong to, and with what power?". Pure interface + holder, no storage import,
// mirroring server/marketplace.ts. The built-in implementation lives in
// server/organizations-core.ts; a future `vox.organizations` plugin replaces it
// without any call site moving again.
//
// NOT in scope: which org OWNS a row (workflow.organizationId and its 8
// siblings). Those are Core's own FK columns, stay Core permanently, and are
// compared as opaque integers.

export type OrgRole = "owner" | "admin" | "member";

export interface Membership {
  organizationId: number;
  role: OrgRole;
}

export interface OrgSummary {
  id: number;
  name: string;
  isVerified: boolean;
}

export interface OrganizationsProvider {
  /** Membership of one user; null = belongs to no org. */
  getMembership(userId: number): Promise<Membership | null>;
  /** Batch form for listings — users with no org are absent from the map. */
  getMemberships(userIds: number[]): Promise<Map<number, Membership>>;
  /** Org identity, for display and the verification gate. */
  getOrganization(orgId: number): Promise<OrgSummary | null>;
  /** Roster of an org. */
  listMembers(orgId: number): Promise<Array<{ userId: number; role: OrgRole }>>;
}

let current: OrganizationsProvider | null = null;

/** Called once at startup (server/index.ts), and by tests installing a fake. */
export function setOrganizations(p: OrganizationsProvider): void {
  current = p;
}

/** Test-only: drop the installed provider so a suite starts from a known state. */
export function resetOrganizations(): void {
  current = null;
}

/**
 * NEVER null — deliberately unlike getMarketplace(). An absent marketplace makes
 * one optional tier inert, which is a coherent product state. An absent
 * organizations provider would report every user as belonging to no org, which
 * silently changes authorization outcomes across the app. Throwing turns a
 * startup wiring bug into a loud failure instead of a quiet policy change.
 */
export function getOrganizations(): OrganizationsProvider {
  if (!current) {
    throw new Error(
      "organizations provider not initialized — setOrganizations() must run at startup (server/index.ts) or in test setup",
    );
  }
  return current;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/organizations-seam.test.ts`
Expected: PASS (3 tests). Then `npm run check` — expected clean.

- [ ] **Step 5: Commit**

```bash
git add server/organizations.ts tests/organizations-seam.test.ts
git commit -m "feat(orgs): vox.organizations seam — interface and never-null holder

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 2: `CoreOrganizations` — the built-in implementation

**Files:**
- Create: `server/organizations-core.ts`
- Test: `tests/organizations-core.test.ts`

**Interfaces:**
- Consumes: `OrganizationsProvider`, `Membership`, `OrgSummary`, `OrgRole` from Task 1.
- Produces: `class CoreOrganizations implements OrganizationsProvider`, constructed as `new CoreOrganizations(storage)`.

- [ ] **Step 1: Write the failing test**

The storage dependency is injected, so this test needs no database.

```ts
// tests/organizations-core.test.ts
import { describe, it, expect } from "vitest";
import { CoreOrganizations } from "../server/organizations-core";

const users: Record<number, { id: number; organizationId: number | null; orgRole: string | null }> = {
  1: { id: 1, organizationId: 7, orgRole: "owner" },
  2: { id: 2, organizationId: 7, orgRole: "member" },
  3: { id: 3, organizationId: null, orgRole: null },
  4: { id: 4, organizationId: 7, orgRole: null }, // org member with no role set
};

const fakeStorage = {
  getUser: async (id: number) => users[id],
  getUsersByOrganization: async (orgId: number) =>
    Object.values(users).filter((u) => u.organizationId === orgId),
  getOrganization: async (id: number) =>
    id === 7 ? { id: 7, name: "Acme", verified: true } : undefined,
} as never;

const orgs = new CoreOrganizations(fakeStorage);

describe("CoreOrganizations", () => {
  it("reads membership and role from the user row", async () => {
    expect(await orgs.getMembership(1)).toEqual({ organizationId: 7, role: "owner" });
  });

  it("returns null for a user in no org", async () => {
    expect(await orgs.getMembership(3)).toBeNull();
  });

  it("returns null for an unknown user", async () => {
    expect(await orgs.getMembership(999)).toBeNull();
  });

  it("treats a null org_role as 'member' — preserving today's non-manager outcome", async () => {
    expect(await orgs.getMembership(4)).toEqual({ organizationId: 7, role: "member" });
  });

  it("batches memberships and omits users with no org", async () => {
    const map = await orgs.getMemberships([1, 3, 4, 999]);
    expect(map.get(1)).toEqual({ organizationId: 7, role: "owner" });
    expect(map.get(4)).toEqual({ organizationId: 7, role: "member" });
    expect(map.has(3)).toBe(false);
    expect(map.has(999)).toBe(false);
  });

  it("maps the `verified` column onto isVerified", async () => {
    expect(await orgs.getOrganization(7)).toEqual({ id: 7, name: "Acme", isVerified: true });
    expect(await orgs.getOrganization(8)).toBeNull();
  });

  it("lists members with their roles", async () => {
    const members = await orgs.listMembers(7);
    expect(members).toHaveLength(3);
    expect(members).toContainEqual({ userId: 1, role: "owner" });
    expect(members).toContainEqual({ userId: 4, role: "member" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/organizations-core.test.ts`
Expected: FAIL — cannot resolve `../server/organizations-core`.

- [ ] **Step 3: Write the implementation**

```ts
// server/organizations-core.ts
//
// The built-in `vox.organizations` implementation: membership read from the
// Core `users.organization_id` / `users.org_role` columns. This is the ONLY
// file (besides storage) permitted to read those columns — see the boundary
// scan test. When orgs extract into a plugin, this file is deleted.

import type { DatabaseStorage } from "./storage";
import type { Membership, OrganizationsProvider, OrgRole, OrgSummary } from "./organizations";

/** Only the storage surface this needs — keeps the class testable without a DB. */
type StorageLike = Pick<DatabaseStorage, "getUser" | "getUsersByOrganization" | "getOrganization">;

/**
 * `users.org_role` is nullable. A user who belongs to an org but has no role
 * recorded is treated as "member": today's predicates grant manager rights only
 * on an explicit 'owner'/'admin', so mapping null → member preserves the exact
 * current outcome rather than inventing one.
 */
function toMembership(organizationId: number | null, orgRole: string | null): Membership | null {
  if (organizationId == null) return null;
  const role: OrgRole = orgRole === "owner" || orgRole === "admin" ? orgRole : "member";
  return { organizationId, role };
}

export class CoreOrganizations implements OrganizationsProvider {
  constructor(private readonly storage: StorageLike) {}

  async getMembership(userId: number): Promise<Membership | null> {
    const user = await this.storage.getUser(userId);
    if (!user) return null;
    return toMembership(user.organizationId, user.orgRole);
  }

  async getMemberships(userIds: number[]): Promise<Map<number, Membership>> {
    const out = new Map<number, Membership>();
    await Promise.all(
      [...new Set(userIds)].map(async (id) => {
        const m = await this.getMembership(id);
        if (m) out.set(id, m);
      }),
    );
    return out;
  }

  async getOrganization(orgId: number): Promise<OrgSummary | null> {
    const org = await this.storage.getOrganization(orgId);
    if (!org) return null;
    return { id: org.id, name: org.name, isVerified: org.verified };
  }

  async listMembers(orgId: number): Promise<Array<{ userId: number; role: OrgRole }>> {
    const users = await this.storage.getUsersByOrganization(orgId);
    return users.flatMap((u) => {
      const m = toMembership(u.organizationId, u.orgRole);
      return m ? [{ userId: u.id, role: m.role }] : [];
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/organizations-core.test.ts`
Expected: PASS (7 tests). Then `npm run check` — expected clean.

- [ ] **Step 5: Commit**

```bash
git add server/organizations-core.ts tests/organizations-core.test.ts
git commit -m "feat(orgs): CoreOrganizations — built-in membership provider over the users columns

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 3: Resolve the provider at startup

**Files:**
- Modify: `server/index.ts` (at the existing `setMarketplace(...)` call, ~line 216)

**Interfaces:**
- Consumes: `setOrganizations` (Task 1), `CoreOrganizations` (Task 2).
- Produces: a wired provider for every request path.

- [ ] **Step 1: Add the imports**

At the top of `server/index.ts`, beside the existing marketplace import:

```ts
import { setOrganizations, type OrganizationsProvider } from "./organizations";
import { CoreOrganizations } from "./organizations-core";
```

- [ ] **Step 2: Resolve beside the marketplace seam**

Find:

```ts
  const plugins = await loadPlugins(app, pool);
  setMarketplace(plugins.services.optional<EvalMarketplace>("vox.eval-marketplace", "^1.0.0"));
```

Add immediately after:

```ts
  // Organizations: a plugin may own membership; until one does, Core's own
  // implementation fills the seam. Unlike the marketplace this is never null —
  // an unresolved provider is a startup bug, not a degraded feature.
  setOrganizations(
    plugins.services.optional<OrganizationsProvider>("vox.organizations", "^1.0.0")
      ?? new CoreOrganizations(storage),
  );
```

- [ ] **Step 3: Verify the server boots and serves an authenticated request**

Run:
```bash
npm run check
./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start
curl -s -c /tmp/c.txt -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@vox.local","password":"admin123456"}' | head -c 80
curl -s -b /tmp/c.txt http://localhost:5000/api/user/organization | head -c 200
```
Expected: `npm run check` clean; login returns a user object; the org endpoint responds exactly as it did before this branch (no 500).

- [ ] **Step 4: Commit**

```bash
git add server/index.ts
git commit -m "feat(orgs): resolve the vox.organizations seam at startup, Core impl as default

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 4: Attach membership at the auth boundary (additive)

Nothing breaks in this task: membership is added *alongside* the existing columns.

**Files:**
- Modify: `server/auth.ts` (`getCurrentUser` ~line 66, `requireAuth` ~73, `requireOrgAdmin` ~106, `getCurrentUserOrApiKeyUser` ~187)
- Test: `tests/auth-membership.test.ts`

**Interfaces:**
- Consumes: `getOrganizations()` (Task 1).
- Produces: `export type AuthUser = User & { membership: Membership | null }`; `getCurrentUser(req)` and `getCurrentUserOrApiKeyUser(req)` now resolve to `AuthUser | undefined`; `resolveMembership(user, req)` helper.

- [ ] **Step 1: Write the failing test**

```ts
// tests/auth-membership.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { setOrganizations, resetOrganizations, type OrganizationsProvider } from "../server/organizations";
import { resolveMembership } from "../server/auth";

let calls = 0;
const provider: OrganizationsProvider = {
  getMembership: async (userId: number) => {
    calls++;
    return userId === 1 ? { organizationId: 7, role: "admin" } : null;
  },
  getMemberships: async () => new Map(),
  getOrganization: async () => null,
  listMembers: async () => [],
};

describe("auth membership resolution", () => {
  beforeEach(() => { calls = 0; resetOrganizations(); setOrganizations(provider); });

  it("attaches membership from the provider", async () => {
    const req = {} as never;
    const user = await resolveMembership({ id: 1 } as never, req);
    expect(user!.membership).toEqual({ organizationId: 7, role: "admin" });
  });

  it("attaches null for a user in no org", async () => {
    const user = await resolveMembership({ id: 2 } as never, {} as never);
    expect(user!.membership).toBeNull();
  });

  it("passes undefined through untouched", async () => {
    expect(await resolveMembership(undefined, {} as never)).toBeUndefined();
  });

  it("resolves once per request even when called repeatedly", async () => {
    const req = {} as never;
    await resolveMembership({ id: 1 } as never, req);
    await resolveMembership({ id: 1 } as never, req);
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auth-membership.test.ts`
Expected: FAIL — `resolveMembership` is not exported from `../server/auth`.

- [ ] **Step 3: Implement in `server/auth.ts`**

Add near the top:

```ts
import { getOrganizations, type Membership } from "./organizations";

/**
 * The authenticated caller, with their org membership resolved once. Callers
 * read `membership`, never the raw columns — that is what lets a plugin own
 * membership later without touching call sites.
 */
export type AuthUser = User & { membership: Membership | null };

// Per-request memo: a single request may call getCurrentUser several times, and
// each call would otherwise hit the provider again. WeakMap keyed by the request
// avoids augmenting Express's type surface.
const membershipCache = new WeakMap<Request, Map<number, Membership | null>>();

export async function resolveMembership(
  user: User | undefined,
  req: Request,
): Promise<AuthUser | undefined> {
  if (!user) return undefined;
  let perRequest = membershipCache.get(req);
  if (!perRequest) {
    perRequest = new Map();
    membershipCache.set(req, perRequest);
  }
  if (!perRequest.has(user.id)) {
    perRequest.set(user.id, await getOrganizations().getMembership(user.id));
  }
  return { ...user, membership: perRequest.get(user.id) ?? null };
}
```

Then wrap the two user-returning entry points:

```ts
export async function getCurrentUser(req: Request): Promise<AuthUser | undefined> {
  if (!req.session?.userId) {
    return undefined;
  }
  return resolveMembership(await storage.getUser(req.session.userId), req);
}

export async function getCurrentUserOrApiKeyUser(req: Request): Promise<AuthUser | undefined> {
  if (req.apiKeyUser) {
    return resolveMembership(req.apiKeyUser, req);
  }
  if (req.session?.userId) {
    return resolveMembership(await storage.getUser(req.session.userId), req);
  }
  return undefined;
}
```

And switch `requireOrgAdmin` to the seam (replacing its two column reads):

```ts
export async function requireOrgAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const user = await storage.getUser(req.session.userId);
  if (!user) {
    return res.status(401).json({ error: "User not found" });
  }
  const membership = await getOrganizations().getMembership(user.id);
  if (!membership) {
    return res.status(403).json({ error: "Organization membership required" });
  }
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    return res.status(403).json({ error: "Organization admin access required" });
  }
  next();
}
```

The error strings and status codes are unchanged — org-admin routes must behave identically.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/auth-membership.test.ts && npm run check`
Expected: PASS (4 tests); `tsc` clean — nothing else changed, because `AuthUser` is still a superset of `User`.

- [ ] **Step 5: Verify the org-admin route still behaves identically**

```bash
./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start
npx vitest run tests/api.test.ts -t "organization"
```
Expected: the same results as on `main` (no new failures).

- [ ] **Step 6: Commit**

```bash
git add server/auth.ts tests/auth-membership.test.ts
git commit -m "feat(orgs): resolve membership once per request at the auth boundary

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 5: Move the permission predicates onto membership

**Files:**
- Modify: `server/permissions.ts` (lines 12–17 `AuthUser`, 19–25 `canAccessResource`, 32–41 `isOwnerOrOrgManager`, 88–96 `hasOrg`)
- Test: `tests/permissions-membership.test.ts`

**Interfaces:**
- Consumes: `Membership` (Task 1).
- Produces: `AuthUser` in `permissions.ts` becomes `{ id: number; isAdmin: boolean; membership: Membership | null }`.

**Heads-up — there are two types named `AuthUser`, and that is pre-existing.** `server/permissions.ts` defines a minimal *structural* one (`id`, `isAdmin`, and now `membership`), while `server/auth.ts` (Task 4) exports a concrete one derived from the schema `User`. They are not imported from each other; the auth one structurally satisfies the permissions one, which is why routes can pass their user straight into the predicates. Do not try to unify them in this task — that is a separate cleanup and would widen the diff.

**Deliberately unchanged:** `sameOrg`, `canDispatchToToken`, `isClaimable`, `sessionPoolViolation`, `isSessionServable`, `isOwnerOperatedAgent`. These take *already-resolved org ids* (`{ organizationId: number | null }`), which is the correct shape for comparing a membership's org against a resource's org. Membership enters at their call sites, not in their signatures. Changing them would widen this refactor for no gain.

- [ ] **Step 1: Write the failing test**

```ts
// tests/permissions-membership.test.ts
import { describe, it, expect } from "vitest";
import { canAccessResource, isOwnerOrOrgManager, hasOrg, canEditResource } from "../server/permissions";

const owner  = { id: 1, isAdmin: false, membership: { organizationId: 7, role: "owner"  as const } };
const member = { id: 2, isAdmin: false, membership: { organizationId: 7, role: "member" as const } };
const outsider = { id: 3, isAdmin: false, membership: null };
const otherOrg = { id: 4, isAdmin: false, membership: { organizationId: 8, role: "admin" as const } };
const admin = { id: 5, isAdmin: true, membership: null };

const orgResource = { ownerId: 2, organizationId: 7, visibility: "private" };
const personal    = { ownerId: 2, organizationId: null, visibility: "private" };

describe("permissions over membership", () => {
  it("grants org members access to an org resource", () => {
    expect(canAccessResource(member, orgResource)).toBe(true);
    expect(canAccessResource(owner, orgResource)).toBe(true);
  });

  it("denies a different org and a user with no org", () => {
    expect(canAccessResource(otherOrg, orgResource)).toBe(false);
    expect(canAccessResource(outsider, orgResource)).toBe(false);
  });

  it("treats org managers as editors of an org resource", () => {
    expect(isOwnerOrOrgManager(owner, orgResource)).toBe(true);
    expect(isOwnerOrOrgManager(member, orgResource)).toBe(true);   // is the resource owner
    expect(isOwnerOrOrgManager(otherOrg, orgResource)).toBe(false);
  });

  it("does NOT let a plain org member manage another member's org resource", () => {
    const plain = { id: 9, isAdmin: false, membership: { organizationId: 7, role: "member" as const } };
    expect(isOwnerOrOrgManager(plain, orgResource)).toBe(false);
  });

  it("keeps admin out of isOwnerOrOrgManager but in canEditResource", () => {
    expect(isOwnerOrOrgManager(admin, orgResource)).toBe(false);
    expect(canEditResource(admin, orgResource)).toBe(true);
  });

  it("owner of a personal resource still qualifies", () => {
    expect(isOwnerOrOrgManager(member, personal)).toBe(true);
    expect(isOwnerOrOrgManager(owner, personal)).toBe(false);
  });

  it("hasOrg reflects membership", () => {
    expect(hasOrg(owner)).toBe(true);
    expect(hasOrg(outsider)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/permissions-membership.test.ts`
Expected: FAIL — `membership` is not a property of `AuthUser`; type errors and/or false results.

- [ ] **Step 3: Update `server/permissions.ts`**

Add the import and replace the interface:

```ts
import type { Membership } from "./organizations";

export interface AuthUser {
  id: number;
  isAdmin: boolean;
  /** Resolved once per request at the auth boundary; null = belongs to no org. */
  membership: Membership | null;
}
```

Replace the org branch in `canAccessResource`:

```ts
  if (resource.organizationId && resource.organizationId === user.membership?.organizationId) return true;
```

Replace the org branch in `isOwnerOrOrgManager`:

```ts
  // Org resource
  if (resource.organizationId && resource.organizationId === user.membership?.organizationId) {
    if (user.membership.role === 'owner' || user.membership.role === 'admin') return true;
    if (resource.ownerId === user.id || resource.createdBy === user.id) return true;
  }
```

Replace `hasOrg` (keep the doc comment, update the body and parameter type):

```ts
export function hasOrg(user: { membership: Membership | null }): boolean {
  return user.membership != null;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/permissions-membership.test.ts && npm run check`
Expected: PASS (7 tests). `tsc` is expected to be **clean**: routes pass the `AuthUser` returned by `getCurrentUser`, which now carries `membership`, and the legacy columns are still present so nothing else breaks yet.

If `tsc` reports errors here, they are call sites passing a *raw* `storage.getUser()` row into a predicate. Fix each by routing it through `getCurrentUser`/`resolveMembership`, and note it in the commit body — those are exactly the sites the seam exists to catch.

- [ ] **Step 5: Run the existing authorization suites unchanged**

Run: `npx vitest run tests/permissions-dispatch.test.ts tests/tier-pool-dispatch.test.ts tests/session-dispatch.test.ts`
Expected: PASS, with **no edits to those files**. Editing them would mean semantics moved.

- [ ] **Step 6: Commit**

```bash
git add server/permissions.ts tests/permissions-membership.test.ts
git commit -m "feat(orgs): permission predicates read membership instead of user columns

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 6: Migrate the direct membership reads in `routes.ts`

56 sites. Mechanical, and every intermediate state still compiles because the legacy columns remain until Task 9.

**Files:**
- Modify: `server/routes.ts`

**Interfaces:**
- Consumes: `AuthUser.membership` (Task 4).
- Produces: no new exports; `routes.ts` stops reading `user.organizationId` / `user.orgRole`.

- [ ] **Step 1: Enumerate the sites**

Run:
```bash
grep -n -E '\b(user|currentUser|targetUser|member|actor|apiKeyUser)\w*\.(organizationId|orgRole)' server/routes.ts | tee /tmp/org-sites.txt | wc -l
```
Expected: 56. Keep `/tmp/org-sites.txt` as the checklist.

- [ ] **Step 2: Triage each site before substituting**

The regex catches two different things. Decide per site:

- **The authenticated caller** (`user`, `currentUser` — came from `getCurrentUser` / `getCurrentUserOrApiKeyUser`): apply the substitution table below. This is the large majority.
- **Another user's raw row** (came from `storage.getUser(...)`, e.g. `const member = await storage.getUser(userId)` at ~5670/5729, or `tokenOwner` at ~3660/3752/4204): **do not** write `member.membership` — a raw row has no such field. These belong to **Task 8**: resolve with `await getOrganizations().getMembership(<thatUserId>)`. Leave them in place for now and handle them in Task 8, or do them here using Task 8's pattern — either is fine, but they must not get the `?.membership` treatment.

Applying the wrong treatment produces a `undefined` read that silently denies access, which no test may catch. When unsure, trace where the identifier was assigned.

- [ ] **Step 3: Apply the substitutions**

Two rules, applied to **the authenticated caller** only:

| Before | After |
|---|---|
| `user.organizationId` | `user.membership?.organizationId ?? null` |
| `user.orgRole` | `user.membership?.role ?? null` |

Worked examples from the file:

```ts
// before (~line 1451)
if (!user.organizationId) return res.status(403).json({ error: "Organization membership required" });
const orgId = user.organizationId;
// after
if (!user.membership) return res.status(403).json({ error: "Organization membership required" });
const orgId = user.membership.organizationId;
```

```ts
// before (~line 1672)
if (user.organizationId) {
  const all = await storage.getWorkflowsByOrganization(user.organizationId);
// after
if (user.membership) {
  const all = await storage.getWorkflowsByOrganization(user.membership.organizationId);
```

```ts
// before (~line 4724)
&& sameOrg({ organizationId: user.organizationId }, { organizationId: a.tokenOwnerOrgId });
// after — sameOrg still compares org ids; membership enters at the call site
&& sameOrg({ organizationId: user.membership?.organizationId ?? null }, { organizationId: a.tokenOwnerOrgId });
```

**Do NOT touch** reads on resource-shaped identifiers — `workflow.organizationId`, `project.organizationId`, `evalSet.organizationId`, `schedule.organizationId`, `secret.organizationId`. Those are Core FK columns and stay.

**Where a response body echoes the field** (e.g. `organizationId: user.organizationId` at ~line 340), keep the **response key** exactly as-is and change only the source expression: `organizationId: user.membership?.organizationId ?? null`. The API surface must not change.

- [ ] **Step 4: Verify the sites are gone and the types hold**

Run:
```bash
grep -c -E '\b(user|currentUser|targetUser|member|actor|apiKeyUser)\w*\.(organizationId|orgRole)' server/routes.ts
npm run check
```
Expected: `0` (counting any deferred to Task 8 as still-present — in that case finish Task 8 before claiming this), and `tsc` clean.

- [ ] **Step 5: Run the integration suite against a restarted server**

Run:
```bash
./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start
npx vitest run tests/api.test.ts
```
Expected: same pass/fail profile as `main` — no NEW failures. The org tests in this file are the regression evidence for this task.

- [ ] **Step 6: Commit**

```bash
git add server/routes.ts
git commit -m "refactor(orgs): routes.ts reads membership through the seam, not user columns

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 7: Migrate `routes-api-v1.ts` and `dispatch.ts`

**Files:**
- Modify: `server/routes-api-v1.ts` (4 sites), `server/dispatch.ts` (1 site)

**Interfaces:**
- Consumes: `AuthUser.membership`.
- Produces: nothing new.

- [ ] **Step 1: Enumerate**

```bash
grep -n -E '\b(user|currentUser|targetUser|member|actor|apiKeyUser)\w*\.(organizationId|orgRole)' server/routes-api-v1.ts server/dispatch.ts
```
Expected: 5 lines total.

- [ ] **Step 2: Apply the same two substitutions as Task 6**

`user.organizationId` → `user.membership?.organizationId ?? null`; `user.orgRole` → `user.membership?.role ?? null`. In `dispatch.ts` the single site feeds `validateTierChoice`'s org gate — it must keep calling `hasOrg(user)`, which now reads membership, so prefer passing the user through unchanged over inlining an id.

- [ ] **Step 3: Verify**

```bash
grep -c -E '\b(user|currentUser|targetUser|member|actor|apiKeyUser)\w*\.(organizationId|orgRole)' server/routes-api-v1.ts server/dispatch.ts
npm run check
npx vitest run tests/tier-pool-dispatch.test.ts tests/dispatch-dispatchable.test.ts tests/permissions-dispatch.test.ts
```
Expected: `0` for both files; `tsc` clean; suites pass unedited.

- [ ] **Step 4: Commit**

```bash
git add server/routes-api-v1.ts server/dispatch.ts
git commit -m "refactor(orgs): api-v1 and dispatch read membership through the seam

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 8: Route *other users'* affiliation through the seam

This is the category the compiler cannot find, because `storage.getUser()` and `storage.getUsersByOrganization()` return raw rows that still carry the columns. Three known agent-token sites, plus any listing that reports another user's org.

**Files:**
- Modify: `server/routes.ts` (~lines 3660, 3752, 4204 — `const tokenOwner = await storage.getUser(...)` followed by `tokenOwner?.organizationId`), plus the admin users listing (~line 596) if it exposes org affiliation.

**Interfaces:**
- Consumes: `getOrganizations().getMembership(userId)`, `.getMemberships(userIds)` (Task 1).
- Produces: nothing new.

- [ ] **Step 1: Enumerate the sites**

```bash
grep -n -B2 'tokenOwner?.organizationId\|owner.organizationId' server/routes.ts
grep -n -A12 'app.get("/api/admin/users"' server/routes.ts
```

- [ ] **Step 2: Replace the token-owner lookups**

```ts
// before (~line 3660)
const tokenOwner = await storage.getUser(evalAgentToken.createdBy);
// ...
ownerOrgId: tokenOwner?.organizationId ?? null,

// after
const ownerMembership = await getOrganizations().getMembership(evalAgentToken.createdBy);
// ...
ownerOrgId: ownerMembership?.organizationId ?? null,
```

Apply the same shape at ~3752 and ~4204. At 4204 the value feeds `serveTokenOwner`:

```ts
const serveTokenOwner = { organizationId: ownerMembership?.organizationId ?? null };
```

If `tokenOwner` is used for anything else at a site (e.g. a name or plan), keep the `storage.getUser` call for those fields and take only the org id from the seam.

- [ ] **Step 3: Batch any listing that reports other users' orgs**

If the admin users listing maps `organizationId` out of each row, resolve once and look up:

```ts
const users = await storage.getAllUsers();
const memberships = await getOrganizations().getMemberships(users.map((u) => u.id));
res.json(users.map(u => ({
  // ...unchanged fields...
  organizationId: memberships.get(u.id)?.organizationId ?? null,
})));
```

Response keys stay identical.

- [ ] **Step 4: Verify**

```bash
npm run check
./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start
npx vitest run tests/api.test.ts tests/session-dispatch.test.ts tests/zero-trust-dispatch.test.ts
```
Expected: `tsc` clean; no new failures. The session/zero-trust suites cover the ~4204 serve-gate path specifically.

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts
git commit -m "refactor(orgs): resolve other users' membership via the seam, not raw rows

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 9: Completeness gate — remove the legacy fields from `AuthUser`

The point of the whole plan: make `tsc` prove no reader was missed.

**Files:**
- Modify: `server/auth.ts` (the `AuthUser` type)

**Interfaces:**
- Consumes: everything above.
- Produces: `export type AuthUser = Omit<User, 'organizationId' | 'orgRole'> & { membership: Membership | null }`.

- [ ] **Step 1: Narrow the type**

```ts
/**
 * The authenticated caller. The org columns are deliberately OMITTED: membership
 * is the only supported way to ask which org this person belongs to, so a future
 * plugin can own it. Reading the columns is a compile error by design.
 */
export type AuthUser = Omit<User, 'organizationId' | 'orgRole'> & { membership: Membership | null };
```

`resolveMembership` must now strip the columns rather than spread them through:

```ts
export async function resolveMembership(
  user: User | undefined,
  req: Request,
): Promise<AuthUser | undefined> {
  if (!user) return undefined;
  let perRequest = membershipCache.get(req);
  if (!perRequest) {
    perRequest = new Map();
    membershipCache.set(req, perRequest);
  }
  if (!perRequest.has(user.id)) {
    perRequest.set(user.id, await getOrganizations().getMembership(user.id));
  }
  const { organizationId: _organizationId, orgRole: _orgRole, ...rest } = user;
  return { ...rest, membership: perRequest.get(user.id) ?? null };
}
```

- [ ] **Step 2: Run the compiler and fix every straggler**

Run: `npm run check`
Expected: either clean (Tasks 6–8 were complete) or a finite list of `Property 'organizationId' does not exist on type 'AuthUser'` errors. Fix each with the Task 6 substitution rules. **Do not** re-add the fields to the type to silence an error — that defeats the gate.

- [ ] **Step 3: Verify nothing regressed**

```bash
npm run check
./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start
npm test
```
Expected: `tsc` clean; unit suite shows no NEW failures versus `main` (see Global Constraints for the known flakes).

- [ ] **Step 4: Commit**

```bash
git add server/auth.ts
git commit -m "feat(orgs): omit org columns from AuthUser — membership is the only path

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 10: Prove the seam is load-bearing (fake provider disagrees with the columns)

A seam nobody has swapped is a guess. This test is the proof.

**Files:**
- Create: `tests/organizations-override.test.ts`

**Interfaces:**
- Consumes: `setOrganizations` (Task 1), `resolveMembership` (Task 4), the predicates (Task 5).
- Produces: `FakeOrganizations` usable by future suites.

- [ ] **Step 1: Write the test**

The fake deliberately reports the OPPOSITE of the user row. If any code still reads the columns, this fails.

```ts
// tests/organizations-override.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { setOrganizations, resetOrganizations, type OrganizationsProvider, type Membership } from "../server/organizations";
import { resolveMembership } from "../server/auth";
import { canAccessResource, isOwnerOrOrgManager, hasOrg } from "../server/permissions";

class FakeOrganizations implements OrganizationsProvider {
  constructor(private readonly byUser: Map<number, Membership>) {}
  async getMembership(userId: number) { return this.byUser.get(userId) ?? null; }
  async getMemberships(userIds: number[]) {
    const m = new Map<number, Membership>();
    for (const id of userIds) { const v = this.byUser.get(id); if (v) m.set(id, v); }
    return m;
  }
  async getOrganization(orgId: number) { return { id: orgId, name: `org-${orgId}`, isVerified: false }; }
  async listMembers(orgId: number) {
    return [...this.byUser.entries()]
      .filter(([, m]) => m.organizationId === orgId)
      .map(([userId, m]) => ({ userId, role: m.role }));
  }
}

// The row says org 7 / owner. The provider says org 99 / member. The provider must win.
const rowSaysOrg7 = { id: 42, isAdmin: false, organizationId: 7, orgRole: "owner" } as never;

describe("organizations seam override", () => {
  beforeEach(() => {
    resetOrganizations();
    setOrganizations(new FakeOrganizations(new Map([[42, { organizationId: 99, role: "member" }]])));
  });

  it("membership comes from the provider, not the user row", async () => {
    const user = await resolveMembership(rowSaysOrg7, {} as never);
    expect(user!.membership).toEqual({ organizationId: 99, role: "member" });
  });

  it("authorization follows the provider's org, not the row's", async () => {
    const user = (await resolveMembership(rowSaysOrg7, {} as never))!;
    expect(canAccessResource(user, { ownerId: 1, organizationId: 99, visibility: "private" })).toBe(true);
    expect(canAccessResource(user, { ownerId: 1, organizationId: 7,  visibility: "private" })).toBe(false);
  });

  it("authorization follows the provider's role, not the row's", async () => {
    const user = (await resolveMembership(rowSaysOrg7, {} as never))!;
    // Row says owner (a manager); provider says member (not a manager) and must win.
    expect(isOwnerOrOrgManager(user, { ownerId: 1, organizationId: 99, visibility: "private" })).toBe(false);
  });

  it("a provider reporting no org overrides a row that has one", async () => {
    setOrganizations(new FakeOrganizations(new Map()));
    const user = (await resolveMembership(rowSaysOrg7, {} as never))!;
    expect(hasOrg(user)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/organizations-override.test.ts`
Expected: PASS (4 tests). A failure here means a call site still reads the columns — find it, fix it, do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add tests/organizations-override.test.ts
git commit -m "test(orgs): prove the seam overrides the user columns, not merely mirrors them

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 11: Boundary scan test

Stops the seam from eroding through `storage.getUser()`, which still returns the raw columns.

**Files:**
- Create: `tests/organizations-boundary.test.ts`

**Interfaces:**
- Consumes: nothing at runtime — it reads source files, in the style of `tests/sensitive-paths.test.ts`.
- Produces: nothing.

- [ ] **Step 1: Write the test**

```ts
// tests/organizations-boundary.test.ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import path from "path";

// Files allowed to read the raw org columns: the built-in provider (whose job it
// is) and the storage layer (which serves it). Everything else must go through
// getOrganizations(). Scans source rather than re-listing call sites, so it
// cannot drift out of date — same approach as tests/sensitive-paths.test.ts.
const ALLOWED = new Set(["organizations-core.ts", "storage.ts"]);

// User-shaped identifiers only. Resource-shaped reads (workflow.organizationId)
// are permanent Core FK columns and must NOT be flagged.
const FORBIDDEN = /\b(user|currentUser|targetUser|member|actor|apiKeyUser|tokenOwner)\w*\.(organizationId|orgRole)\b/;

describe("organizations boundary", () => {
  it("no user-shaped org-column read outside the provider and storage", () => {
    const dir = path.resolve(__dirname, "../server");
    const offenders: string[] = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (ALLOWED.has(entry.name)) continue;
      readFileSync(path.join(dir, entry.name), "utf-8")
        .split("\n")
        .forEach((line, i) => {
          if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
          if (FORBIDDEN.test(line)) offenders.push(`${entry.name}:${i + 1}: ${line.trim()}`);
        });
    }

    expect(offenders, `read membership via getOrganizations() instead:\n${offenders.join("\n")}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/organizations-boundary.test.ts`
Expected: PASS. If it lists offenders, migrate them with the Task 6 rules — do not add them to `ALLOWED`.

- [ ] **Step 3: Commit**

```bash
git add tests/organizations-boundary.test.ts
git commit -m "test(orgs): fail the build if membership is read off the user columns

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 12: Document the seam and run the full gate

**Files:**
- Modify: `CLAUDE.md` (the permission-model section)

**Interfaces:**
- Consumes: everything.
- Produces: the merge-ready branch.

- [ ] **Step 1: Document it in `CLAUDE.md`**

In the "Permission Model (`server/permissions.ts`)" section, after the predicate list, add:

```markdown
**Org membership goes through the `vox.organizations` seam** (`server/organizations.ts`): `getOrganizations().getMembership(userId)` is the only supported way to ask which org a user belongs to. Core's built-in provider (`server/organizations-core.ts`) reads `users.organization_id`/`org_role`; a plugin providing `vox.organizations` overrides it. Membership is resolved once per request at the auth boundary, so `AuthUser` carries `membership` and deliberately **omits** the raw columns — reading them is a compile error, and `tests/organizations-boundary.test.ts` fails the build if one creeps back via `storage.getUser()`. Resource ownership (`workflow.organizationId` and its 8 siblings) is unaffected: those are Core FK columns compared as opaque integers. Design: `designs/2026-09-10-organizations-seam-design.md`.
```

- [ ] **Step 2: Clean the dev DB, then run the full gate**

```bash
printf 'DELETE FROM workflows WHERE owner_id=1;\nDELETE FROM projects WHERE owner_id=1;\nDELETE FROM secrets WHERE user_id=1;\n' > /tmp/cleanup.sql
docker exec -i $(docker ps -qf name=vox-postgres) psql -U vox -d vox < /tmp/cleanup.sql
./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start
./scripts/full-tests-run.sh
```
Expected: unit + audio + E2E green, allowing for the known flakes in Global Constraints — each of which must be re-run in isolation to confirm it passes before you call the gate green.

- [ ] **Step 3: Commit and open the PR**

```bash
git add CLAUDE.md
git commit -m "docs: document the vox.organizations seam in CLAUDE.md

🤖 Built with SMT <smt@agora.build>"
git push -u origin feat/organizations-seam
```

Open a PR against `main` whose body summarizes: the seam, the never-null choice, the per-request resolution, the compiler gate (Task 9), and the two enforcement tests. End the body with `Generated with SMT <smt@agora.build>`.

**Do not merge.** Merging happens only on the user's explicit mark.

---

## Verification summary

| Claim | Evidence |
|---|---|
| The seam can be overridden by a plugin | `tests/organizations-override.test.ts` — the fake disagrees with the row and wins |
| No membership reader was missed | Task 9: `AuthUser` omits the columns, so `tsc` enumerates any straggler |
| The boundary cannot silently erode | `tests/organizations-boundary.test.ts` scans `server/*.ts` |
| Behavior is unchanged | `tests/api.test.ts` org tests and the dispatch/session suites pass **unedited** |
| Nothing else regressed | `./scripts/full-tests-run.sh` (unit + audio + E2E) |
