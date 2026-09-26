//
// Core-side seam for organization MEMBERSHIP — "which org does this person
// belong to, and with what power?". Pure interface + holder, no storage import,
// mirroring server/marketplace.ts. The implementation is the `organizations`
// PLUGIN (`vox.organizations`, plugins/organizations) — there is no built-in
// fallback: absence is a legal, inert state (see getOrganizations below).
//
// NOT in scope: which org OWNS a row (evalFlow.organizationId and the other
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
 *
 * `name` is set EXPLICITLY, and that is load-bearing: the implementation is a
 * plugin, which throws its OWN copy of this class (plugins/organizations/server/
 * types.ts), so `instanceof` is false across the boundary. The name is the
 * cross-boundary identity — match with `isAlreadyMemberError` below, never with
 * `instanceof` alone and never via `constructor.name` (the production bundle is
 * esbuild-built; class names are not guaranteed to survive).
 */
export class AlreadyMemberError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "AlreadyMemberError";
  }
}

/**
 * The adapter-side predicate for the error above. `instanceof` first (same-realm
 * Core throws), then the explicit `name` — which is what carries the identity
 * when the throw came from the plugin's structurally-identical class.
 */
export function isAlreadyMemberError(err: unknown): boolean {
  return err instanceof AlreadyMemberError || (err instanceof Error && err.name === "AlreadyMemberError");
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

let current: OrganizationsProvider | null = null;

/**
 * Called once at startup (server/index.ts), and by tests installing a fake.
 * Accepts `null` so the startup call can pass the plugin lookup through
 * verbatim — `optional(...) ?? null` — instead of branching on absence.
 */
export function setOrganizations(p: OrganizationsProvider | null): void {
  current = p;
}

/** Test-only: drop the installed provider so a suite starts from a known state. */
export function resetOrganizations(): void {
  current = null;
}

/**
 * Absence is a legal state (design §7): a missing provider makes orgs INERT —
 * routes/helpers that need an answer return 501, and paths that can tolerate
 * "no org" fail closed via `?? null`. This is deliberately unlike the old
 * throw-on-uninitialized behavior: a startup wiring bug used to crash every
 * request that touched membership; now it degrades the org feature instead.
 *
 * Provider FAILURE (a thrown error from an installed provider) is NOT the same
 * as absence — it must stay distinguishable from "no org" wherever that
 * distinction matters (e.g. `membershipFor` rethrows), surfacing as 503 where
 * an answer is required. Neither absence nor failure is ever allowed to look
 * like a silent "user has no org" on a path that must tell the two apart.
 */
export function getOrganizations(): OrganizationsProvider | null {
  return current;
}

/** Route guard: absent provider → 501, one sentence, one status, everywhere. */
export function requireOrganizations(res: { status(n: number): { json(b: unknown): unknown } }): OrganizationsProvider | null {
  const p = getOrganizations();
  if (!p) res.status(501).json({ error: "Organizations feature not enabled" });
  return p;
}
