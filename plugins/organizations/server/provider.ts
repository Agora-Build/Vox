import type { PluginDb } from "@vox/plugin-sdk";
import { AlreadyMemberError, type Membership, type Organization, type OrganizationsProvider, type OrgRole, type OrgSecretRow } from "./types";

type OrgRow = {
  id: number;
  name: string;
  address: string | null;
  verified: boolean;
  created_at: Date;
  updated_at: Date;
};

function toOrganization(r: OrgRow): Organization {
  return {
    id: r.id,
    name: r.name,
    address: r.address,
    verified: r.verified,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

type SecretRow = {
  id: number;
  org_ref: number;
  name: string;
  encrypted_value: string;
  broker_type: string | null;
  is_test_account: boolean;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
};

function toOrgSecretRow(r: SecretRow): OrgSecretRow {
  return {
    id: r.id,
    organizationId: r.org_ref,
    name: r.name,
    encryptedValue: r.encrypted_value,
    brokerType: r.broker_type,
    isTestAccount: r.is_test_account,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * True iff `err` is a pg unique-violation (23505) on the given constraint.
 * node-postgres surfaces DB errors as plain objects with `code`/`constraint`
 * fields (from the libpq error response) — no `pg.DatabaseError` re-export to
 * `instanceof` against from a plugin, so this is a structural check.
 */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === "object" && err !== null &&
    (err as { code?: unknown }).code === "23505" &&
    (err as { constraint?: unknown }).constraint === constraint
  );
}

// Task 2 implemented the seven reads test-first against plugin_organizations
// tables (see migrations/0001_init.sql); Task 3 completes the remaining nine
// mutation + org-secret methods, equivalence-locked to CoreOrganizations
// (server/organizations-core.ts).
//
// NOTE: that file no longer exists — the Release A flip (Task 7) deleted it, so
// this provider is now the ONLY implementation of the seam. Every
// `CoreOrganizations` / `organizations-core.ts:NN` citation below is HISTORICAL,
// kept because it records exactly which behavior each method is locked to; read
// them against the last commit that still had the file (`git show
// b13c12a:server/organizations-core.ts`).
export function createOrganizationsProvider(db: PluginDb): OrganizationsProvider {
  return {
    async getMembership(userId) {
      const { rows } = await db.query<{ org_ref: number; role: OrgRole }>(
        "SELECT org_ref, role FROM memberships WHERE user_ref = $1", [userId]);
      if (rows.length === 0) return null;
      return { organizationId: rows[0].org_ref, role: rows[0].role };
    },
    async getMemberships(userIds) {
      const out = new Map<number, Membership>();
      if (userIds.length === 0) return out;
      // ONE query for the whole batch — preserves Phase 1's N+1 fix
      // (CoreOrganizations.getMemberships via storage.getUsersByIds). Input is
      // deduped, as storage.getUsersByIds did (`inArray(users.id, [...new
      // Set(ids)])`): harmless either way for ANY(), but it keeps a listing with
      // repeated ids from widening the array parameter.
      const { rows } = await db.query<{ user_ref: number; org_ref: number; role: OrgRole }>(
        "SELECT user_ref, org_ref, role FROM memberships WHERE user_ref = ANY($1)",
        [Array.from(new Set(userIds))]);
      for (const r of rows) out.set(r.user_ref, { organizationId: r.org_ref, role: r.role });
      return out;
    },
    async getOrganization(orgId) {
      const { rows } = await db.query<OrgRow>(
        "SELECT id, name, address, verified, created_at, updated_at FROM organizations WHERE id = $1", [orgId]);
      return rows.length === 0 ? null : toOrganization(rows[0]);
    },
    async listMembers(orgId) {
      // Mirrors CoreOrganizations.listMembers, which delegates to
      // storage.getUsersByOrganization — ORDER BY created_at DESC
      // (server/storage.ts:404); the admin roster order is user-visible.
      const { rows } = await db.query<{ user_ref: number; role: OrgRole }>(
        "SELECT user_ref, role FROM memberships WHERE org_ref = $1 ORDER BY created_at DESC", [orgId]);
      return rows.map((r) => ({ userId: r.user_ref, role: r.role }));
    },
    async countMembers(orgId) {
      const { rows } = await db.query<{ count: string }>(
        "SELECT count(*) AS count FROM memberships WHERE org_ref = $1", [orgId]);
      return Number(rows[0]?.count ?? 0);
    },
    async countOrgAdmins(orgId) {
      const { rows } = await db.query<{ count: string }>(
        "SELECT count(*) AS count FROM memberships WHERE org_ref = $1 AND role IN ('owner', 'admin')", [orgId]);
      return Number(rows[0]?.count ?? 0);
    },
    async listOrganizations() {
      // Mirrors CoreOrganizations.listOrganizations, which delegates to
      // storage.getAllOrganizations — ORDER BY created_at DESC
      // (server/storage.ts:429); the admin console list order is user-visible.
      const { rows } = await db.query<OrgRow>(
        "SELECT id, name, address, verified, created_at, updated_at FROM organizations ORDER BY created_at DESC");
      return rows.map(toOrganization);
    },
    async createOrganization(input, creator) {
      // At-most-one-org precheck, mirroring CoreOrganizations.createOrganization
      // (organizations-core.ts:84-87) exactly — same AlreadyMemberError shape.
      const existing = await db.query<{ org_ref: number }>(
        "SELECT org_ref FROM memberships WHERE user_ref = $1", [creator.userId]);
      if (existing.rows.length > 0) {
        throw new AlreadyMemberError(
          `user ${creator.userId} already belongs to organization ${existing.rows[0].org_ref}`);
      }
      // Upgrade over Core: Core writes the org row and the users-table
      // membership sequentially (organizations-core.ts:88-93, explicitly
      // commented there as non-atomic). The plugin CAN commit both writes in
      // one transaction (design §4/§5) because both tables live in its own
      // schema, so it does — a crash between the two writes here is
      // impossible; in Core it just leaves an org with no owner.
      return db.withTransaction(async (tx) => {
        const orgResult = await tx.query<OrgRow>(
          `INSERT INTO organizations (name, address) VALUES ($1, $2)
           RETURNING id, name, address, verified, created_at, updated_at`,
          [input.name, input.address ?? null],
        );
        const org = orgResult.rows[0];
        await tx.query(
          `INSERT INTO memberships (org_ref, user_ref, role) VALUES ($1, $2, 'owner')`,
          [org.id, creator.userId],
        );
        return toOrganization(org);
      });
    },
    async updateOrganization(orgId, patch) {
      // KEY-PRESENCE semantics, matching BASE Core exactly. Core was
      // `storage.updateOrganization` → `.set({ ...patch, updatedAt })`
      // (`git show 881cb36:server/storage.ts`, updateOrganization), and drizzle's
      // mapUpdateSet filters ONLY `undefined` — so an absent/undefined field was
      // left untouched while an EXPLICIT `null` (reachable from raw JSON:
      // `PATCH /api/organizations/:id` forwards `address` whenever it is not
      // undefined, routes.ts) actually NULLed the column.
      //
      // An earlier COALESCE($n, col) form could not express that difference: it
      // treated an explicit null as "keep", silently ignoring an address clear.
      // Hence the built SET list. The empty-patch case is unchanged — no column
      // in the list, only updated_at moves.
      const sets: string[] = [];
      const params: unknown[] = [];
      // Cast: the contract types these as `string | undefined`, but the divergence
      // above is precisely about a runtime `null` arriving from raw JSON.
      const p = patch as { name?: string | null; address?: string | null };
      if (p.name !== undefined) { params.push(p.name); sets.push(`name = $${params.length}`); }
      if (p.address !== undefined) { params.push(p.address); sets.push(`address = $${params.length}`); }
      sets.push("updated_at = now()");
      params.push(orgId);
      const { rows } = await db.query<OrgRow>(
        `UPDATE organizations SET ${sets.join(", ")}
         WHERE id = $${params.length}
         RETURNING id, name, address, verified, created_at, updated_at`,
        params,
      );
      // EXACT string — Phase-1 adapters string-match it (organizations-core.ts:98).
      if (rows.length === 0) throw new Error("organization not found");
      return toOrganization(rows[0]);
    },
    async setVerified(orgId, verified) {
      // Mirrors Core's setVerified, which calls storage.updateOrganization
      // directly (NOT through Core's own checked updateOrganization method) and
      // discards the result whether a row matched or not — so, unlike
      // updateOrganization above, an unknown orgId is a silent no-op here, not
      // a thrown error (organizations-core.ts:102-104).
      await db.query(
        "UPDATE organizations SET verified = $1, updated_at = now() WHERE id = $2",
        [verified, orgId],
      );
    },
    async addMember(orgId, userId, role) {
      // Same at-most-one-org precheck as createOrganization/Core's addMember
      // (organizations-core.ts:106-110). Note: unlike Core, the plugin has no
      // "user not found" check here — Core's users-table existence check is
      // out of scope for a provider that owns only organizations/memberships/
      // org_secrets (design: authorization + existence gating stays in Core).
      const existing = await db.query<{ org_ref: number }>(
        "SELECT org_ref FROM memberships WHERE user_ref = $1", [userId]);
      if (existing.rows.length > 0) {
        throw new AlreadyMemberError(
          `user ${userId} already belongs to organization ${existing.rows[0].org_ref}`);
      }
      try {
        await db.query(
          "INSERT INTO memberships (org_ref, user_ref, role) VALUES ($1, $2, $3)",
          [orgId, userId, role],
        );
      } catch (err) {
        // Race backstop: two concurrent addMember calls for the same user can
        // both pass the precheck above before either INSERT commits. Core
        // structurally cannot have this race (one users.organization_id
        // column, last writer wins silently); the plugin's memberships table
        // has a real UNIQUE (user_ref) constraint, so the loser must not leak
        // a raw pg error to the Core adapters — map it to the same typed error
        // the precheck would have thrown.
        if (isUniqueViolation(err, "memberships_user_uq")) {
          throw new AlreadyMemberError(`user ${userId} already belongs to an organization`);
        }
        throw err;
      }
    },
    async setMemberRole(orgId, userId, role) {
      // Scoped to (org_ref, user_ref) — see removeMember below for why.
      // Silent no-op on unknown userId (or org/user mismatch): the adapters'
      // 404 guards sit in Core, ahead of this call (Phase-1 T2 carry).
      await db.query(
        "UPDATE memberships SET role = $1 WHERE org_ref = $2 AND user_ref = $3",
        [role, orgId, userId],
      );
    },
    async removeMember(orgId, userId) {
      // Core's removeMember ignores its orgId argument entirely
      // (organizations-core.ts:118, `_orgId`) — safe there ONLY because
      // users.organization_id is a single column, so "which org" can't
      // disagree with the row being touched. The plugin's memberships table
      // has no such structural guarantee at the SQL layer, so it filters on
      // BOTH org_ref and user_ref: removeMember(wrongOrgId, userId) must not
      // remove userId's membership in their ACTUAL org.
      await db.query(
        "DELETE FROM memberships WHERE org_ref = $1 AND user_ref = $2",
        [orgId, userId],
      );
    },
    async listOrgSecrets(orgId) {
      // ORDER BY created_at DESC — parity with storage.getOrgSecrets
      // (server/storage.ts:2698-2701).
      const { rows } = await db.query<SecretRow>(
        `SELECT id, org_ref, name, encrypted_value, broker_type, is_test_account, created_by, created_at, updated_at
         FROM org_secrets WHERE org_ref = $1 ORDER BY created_at DESC`,
        [orgId],
      );
      return rows.map(toOrgSecretRow);
    },
    async upsertOrgSecret(orgId, row) {
      // Single statement: INSERT .. ON CONFLICT (org_ref, name) DO UPDATE.
      // `created_by` is deliberately absent from the SET list, so on an
      // UPDATE path Postgres leaves the existing row's created_by untouched —
      // preserve-original for free, matching storage.upsertOrgSecretRow
      // (server/storage.ts:2753-2781) and the Phase-1 T9 route compensation
      // that depends on the original creator surviving a credential rotation.
      const { rows } = await db.query<SecretRow>(
        `INSERT INTO org_secrets (org_ref, name, encrypted_value, broker_type, is_test_account, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_ref, name) DO UPDATE SET
           encrypted_value = EXCLUDED.encrypted_value,
           broker_type = EXCLUDED.broker_type,
           is_test_account = EXCLUDED.is_test_account,
           updated_at = now()
         RETURNING id, org_ref, name, encrypted_value, broker_type, is_test_account, created_by, created_at, updated_at`,
        [orgId, row.name, row.encryptedValue, row.brokerType, row.isTestAccount, row.createdBy],
      );
      return toOrgSecretRow(rows[0]);
    },
    async deleteOrgSecret(orgId, name) {
      await db.query(
        "DELETE FROM org_secrets WHERE org_ref = $1 AND name = $2",
        [orgId, name],
      );
    },
  };
}
