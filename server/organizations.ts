//
// Core-side seam for organization MEMBERSHIP — "which org does this person
// belong to, and with what power?". Pure interface + holder, no storage import,
// mirroring server/marketplace.ts. The built-in implementation lives in
// server/organizations-core.ts; a future `vox.organizations` plugin replaces it
// without any call site moving again.
//
// NOT in scope: which org OWNS a row (workflow.organizationId and the other
// resource-ownership columns). Those are Core's own FK columns, stay Core
// permanently, and are compared as opaque integers.

export type OrgRole = "owner" | "admin" | "member";

export interface Membership {
  organizationId: number;
  role: OrgRole;
}

/** full row — three routes res.json() it verbatim (design §4) */
export interface Organization {
  id: number;
  name: string;
  address: string | null;
  verified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Thrown by `addMember` / `createOrganization` when the target user already
 * belongs to an organization.
 *
 * At-most-one-org is the provider's invariant, not Core's: today it is
 * physically enforced by `users.organization_id` being one column; a future
 * plugin's `memberships` table carries `UNIQUE (user_ref)` and throws this
 * same typed error. Register-with-invite and create-org map it to today's
 * 400s.
 */
export class AlreadyMemberError extends Error {}

export interface OrganizationsProvider {
  /** Membership of one user; null = belongs to no org. */
  getMembership(userId: number): Promise<Membership | null>;
  /** Batch form for listings — users with no org are absent from the map. */
  getMemberships(userIds: number[]): Promise<Map<number, Membership>>;
  /** Org identity, for display and the verification gate. */
  getOrganization(orgId: number): Promise<Organization | null>;
  /** Roster of an org. */
  listMembers(orgId: number): Promise<Array<{ userId: number; role: OrgRole }>>;
  /** Member count of an org. */
  countMembers(orgId: number): Promise<number>;
  /** Count of admins/owners in an org (demotion/removal guardrails). */
  countOrgAdmins(orgId: number): Promise<number>;
  /** All organizations (admin listing). */
  listOrganizations(): Promise<Organization[]>;

  // Mutations. Rules the interface encodes (design §4):
  // - Authorization stays in Core. The provider executes; it never decides —
  //   `requireOrgAdmin` and the predicates keep gating routes.
  // - At-most-one-org is the provider's invariant now (see AlreadyMemberError).
  // - Transactions do not cross the boundary: a plugin gets intra-provider
  //   atomicity only (e.g. org + owner membership commit together inside the
  //   provider); Core-side compensating writes follow a fixed order and no
  //   distributed transaction is attempted.
  // - Error semantics: "cannot answer" != "no" — providers throw on failure;
  //   they never return a membership-shaped null to mean "unavailable".

  /** Creates the org and makes `creator` its owner. Throws AlreadyMemberError if the creator already belongs to an org. */
  createOrganization(input: { name: string; address?: string }, creator: { userId: number }): Promise<Organization>;
  /** Patches name/address. Throws Error("organization not found") if orgId doesn't exist. */
  updateOrganization(orgId: number, patch: { name?: string; address?: string }): Promise<Organization>;
  /** Writes the `verified` column. */
  setVerified(orgId: number, verified: boolean): Promise<void>;
  /** Adds userId to orgId with role. Throws AlreadyMemberError if the user already belongs to ANY org. */
  addMember(orgId: number, userId: number, role: OrgRole): Promise<void>;
  /** Changes an existing member's role. */
  setMemberRole(orgId: number, userId: number, role: OrgRole): Promise<void>;
  /** Removes userId from orgId. */
  removeMember(orgId: number, userId: number): Promise<void>;
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
