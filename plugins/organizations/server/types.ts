// Duck-typed mirror of server/organizations.ts — plugins import only
// @vox/plugin-sdk. tests/organizations-mirror.test.ts fails the build on drift.

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
 *
 * `name` is set EXPLICITLY and must stay identical to Core's copy
 * (server/organizations.ts): this class is a DIFFERENT class object from the
 * one Core's adapters can see, so `instanceof` is false across the boundary and
 * Core matches on `err.name === "AlreadyMemberError"` (`isAlreadyMemberError`).
 * Renaming it here silently turns both Core 400 paths into 500s — which is why
 * tests/organizations-mirror.test.ts asserts the literal name on both classes.
 */
export class AlreadyMemberError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "AlreadyMemberError";
  }
}

/**
 * Hand-written, deliberately NOT the drizzle-inferred `OrgSecret` (shared/schema.ts),
 * which dies when org secrets move behind the seam in a later release. The provider
 * traffics in ciphertext only: `encryptedValue` is opaque to it — `encryptValue`/
 * `decryptValue` and the key stay in Core (design §"Org secrets move too").
 */
export interface OrgSecretRow {
  id: number;
  organizationId: number;
  name: string;
  encryptedValue: string;
  brokerType: string | null;
  isTestAccount: boolean;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
}

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

  // Org secrets. Ciphertext only — the provider never encrypts, decrypts, or
  // sees plaintext; `encryptValue`/`decryptValue` and the key stay in Core.

  /** All secrets for an org, ciphertext untouched. */
  listOrgSecrets(orgId: number): Promise<OrgSecretRow[]>;
  /** Creates or updates a secret by name, storing `encryptedValue` verbatim. */
  upsertOrgSecret(
    orgId: number,
    row: { name: string; encryptedValue: string; brokerType: string | null; isTestAccount: boolean; createdBy: number },
  ): Promise<OrgSecretRow>;
  /** Removes a secret by name. */
  deleteOrgSecret(orgId: number, name: string): Promise<void>;
}
